import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WiliDeviceProtocol, WiliNdjson, validHostPacket, validDevicePacket } from './protocol.ts';
import type { WiliIncidentContext, WiliWellbeingContext } from './protocol.ts';
import { readMonoPcm16Wav } from './audio.ts';
import { ConversationAudioQueue, prepareConversationAudio } from './conversation-audio.ts';
import { matchingStockWellbeing, recognizeCurrentWellbeing } from './wellbeing-audio.ts';
import { StockBridgeFailure, backendCloseFailure, backendHttpFailure, backendTransportFailure,
  selectedPortFailure, superviseStockBridge } from './stock-recovery.ts';

export function matchingStockCheckin(context: WiliIncidentContext | null, packet: { incidentId?: unknown; checkinId?: unknown }, now = Date.now()): boolean {
  return context?.phase === 'CONFIRMING' && context.incidentId === packet.incidentId
    && context.checkinId === packet.checkinId && context.checkinDeadline !== null && now < context.checkinDeadline;
}

/** Asset setup can outlast an incident. Deliver the latest context only once
 * the worker is ready, without replaying a check-in whose deadline has passed. */
export function stockContextToDeliver(context: WiliIncidentContext | null, ready: boolean, now = Date.now(), restoring = false): WiliIncidentContext | null {
  if (!ready || !context || context.phase === 'CONFIRMING' && !matchingStockCheckin(context, context, now)) return null;
  if (restoring && ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(context.phase ?? '')) return { ...context,
    incidentId: null, checkinId: null, phase: null, checkinDeadline: null, ownerName: null,
    statusText: 'LIFELINE\nREADY', voiceAsset: null };
  return context;
}

/** Official stock SDK transport. Only the child process owns the DISPLAY serial port. */
function requireSelectedPort(port: string): void {
  let character: boolean;
  try { character = statSync(port).isCharacterDevice(); } catch (error) { throw selectedPortFailure(error); }
  if (!character) throw new StockBridgeFailure('worker-runtime', 'Select the actual DISPLAY character-device port.');
}
export async function runStockBridge(options: { port: string; python: string; tokenFile: string; base: string; audioDir: string;
  uiDir?: string; uiContacts?: string[]; signal?: AbortSignal; onForwardedRealSample?: () => void }): Promise<void> {
  if (options.signal?.aborted) return;
  if (!/^\/dev\/cu\.[\w.-]+$/.test(options.port)) throw new StockBridgeFailure('worker-runtime', 'Select the actual DISPLAY serial port.');
  const base = new URL(options.base);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('Use a plain backend origin.');
  const tokenStat = statSync(options.tokenFile);
  if (!tokenStat.isFile() || tokenStat.size > 1024 || (tokenStat.mode & 0o077)) throw new Error('Pairing token file must be private.');
  const token = readFileSync(options.tokenFile, 'utf8').trim();
  if (!/^[\w-]{16,200}$/.test(token)) throw new Error('Invalid local pairing token.');
  if (!statSync(options.audioDir).isDirectory()) throw new Error('Prepared WILi audio directory is missing.');
  requireSelectedPort(options.port);
  const endpoint = new URL('/motion', base); endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('source', 'body-wili'); endpoint.searchParams.set('token', token);
  const conversationDirectory = await mkdtemp(join(tmpdir(), 'lifeline-responder-voice-'));
  if (options.signal?.aborted) { await rm(conversationDirectory, { recursive: true, force: true }); return; }
  const child = spawn(options.python, [fileURLToPath(new URL('./stock_io.py', import.meta.url)), '--port', options.port,
    '--audio-dir', resolve(options.audioDir), '--conversation-dir', conversationDirectory,
    ...(options.uiDir ? ['--ui-dir', resolve(options.uiDir), '--ui-contacts', JSON.stringify(options.uiContacts ?? [])] : [])],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const protocol = new WiliDeviceProtocol(), decoder = new WiliNdjson(400_000);
  let socket: WebSocket | null = null, context: WiliIncidentContext | null = null;
  let wellbeingContext: WiliWellbeingContext | null = null, wellbeingAbort: AbortController | null = null;
  let stopped = false, workerReady = false, transcribing = false, samples = 0, dropped = 0, audioWindows = 0;
  let firstSampleAt = 0, lastSampleAt = 0, maxGapMs = 0;
  const pendingClocks = new Set<string>();
  const sttAbort = new AbortController();
  const utterances = new Set<Promise<void>>();
  let conversation: ConversationAudioQueue | null = null, conversationStopped: Promise<void> | null = null;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const childClosed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let backendConnectTimer: ReturnType<typeof setTimeout> | null = null;
  let socketClosed: Promise<void> | null = null, failure: StockBridgeFailure | null = null;
  const stop = (reason?: StockBridgeFailure) => {
    if (stopped) return; stopped = true; sttAbort.abort();
    if (reason && !options.signal?.aborted) failure = reason;
    conversationStopped = conversation?.stop() ?? null;
    socket?.terminate(); child.stdin.end(); child.kill('SIGTERM');
    // Give interrupted file upload cleanup time to restore button events using
    // the stock SDK's finite synchronous response waits.
    killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000); killTimer.unref(); finish();
  };
  const signal = () => stop();
  if (options.signal) options.signal.addEventListener('abort', signal, { once: true });
  else { process.once('SIGINT', signal); process.once('SIGTERM', signal); }
  const portWatch = setInterval(() => {
    if (stopped) return;
    try { requireSelectedPort(options.port); } catch (error) {
      stop(error instanceof StockBridgeFailure ? error : new StockBridgeFailure('worker-runtime', 'Selected WILi port cannot be verified.'));
    }
  }, 250);
  if (options.signal?.aborted) signal();
  const sendChild = (packet: unknown) => {
    if (stopped) return;
    if (!child.stdin.writable || child.stdin.writableLength > 64_000) { stop(new StockBridgeFailure('queue-stalled', 'Stock WILi command queue stalled.')); return; }
    child.stdin.write(JSON.stringify(packet) + '\n');
  };
  const sendBackend = (packet: unknown): boolean => {
    if (stopped || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64_000) return false;
    socket.send(JSON.stringify(packet)); return true;
  };
  conversation = new ConversationAudioQueue({
    prepare: (packet, signal) => prepareConversationAudio(packet, conversationDirectory, { signal }),
    dispatch: (packet, filename) => sendChild({ ...packet, type: 'conversation.play', filename }),
    status: packet => {
      const validated = protocol.accept(packet);
      if (!sendBackend(validated)) stop(new StockBridgeFailure('command-undelivered', 'Responder playback status could not reach the backend.'));
    },
  });
  const matchingCheckin = (p: { incidentId?: unknown; checkinId?: unknown }) => matchingStockCheckin(context, p);
  const matchingWellbeing = (p: { sessionId?: unknown; conversationId?: unknown }) => !stopped
    && matchingStockWellbeing(wellbeingContext, context, p) && p.sessionId === protocol.hello?.sessionId;
  const wellbeingStatus = (p: { sessionId?: unknown; conversationId?: unknown }, stage: 'transcribing' | 'complete' | 'unavailable') => {
    if (!matchingWellbeing(p)) return;
    const status = protocol.accept({ type: 'wellbeing.audio', source: 'body-wili', sessionId: p.sessionId,
      eventId: randomUUID(), conversationId: p.conversationId, stage });
    if (!sendBackend(status)) stop(new StockBridgeFailure('command-undelivered', 'WILi wellbeing voice status could not reach the backend.'));
  };
  const wellbeingResult = (p: Record<string, unknown>, stage: 'complete' | 'unavailable') => {
    wellbeingStatus(p, stage);
    if (matchingWellbeing(p)) sendChild({ type: 'wellbeing.result', sessionId: p.sessionId,
      conversationId: p.conversationId, eventId: p.eventId, stage });
  };
  const wellbeingUtterance = async (p: Record<string, unknown>) => {
    if (!matchingWellbeing(p)) return;
    if (transcribing) { wellbeingResult(p, 'unavailable'); return; }
    audioWindows++; transcribing = true;
    const abort = new AbortController(); wellbeingAbort = abort;
    try {
      const result = await recognizeCurrentWellbeing(p, () => ({ wellbeing: wellbeingContext, incident: context }), {
        signal: AbortSignal.any([sttAbort.signal, abort.signal]), onStart: packet => wellbeingStatus(packet, 'transcribing'),
      });
      if (matchingWellbeing(p) && result?.status === 'transcribed') {
        const reply = protocol.accept({ type: 'wellbeing.reply', source: 'body-wili', sessionId: p.sessionId,
          eventId: p.eventId, conversationId: p.conversationId, transcript: result.transcript });
        if (!sendBackend(reply)) { stop(new StockBridgeFailure('command-undelivered', 'WILi wellbeing reply could not reach the backend.')); return; }
        wellbeingResult(p, 'complete'); console.log('A real local WILi wellbeing transcript reached the backend.');
      } else if (result !== null) wellbeingResult(p, 'unavailable');
    } finally {
      p.audioBase64 = ''; transcribing = false;
      if (wellbeingAbort === abort) wellbeingAbort = null;
    }
  };
  const audioStatus = (p: { incidentId?: unknown; checkinId?: unknown; eventId?: unknown }, stage: 'transcribing' | 'complete' | 'unavailable') => {
    if (!matchingCheckin(p)) return;
    const status = protocol.accept({ type: 'checkin.audio', source: 'body-wili', sessionId: protocol.hello!.sessionId,
      eventId: randomUUID(), incidentId: p.incidentId, checkinId: p.checkinId, stage });
    if (!sendBackend(status)) stop(new StockBridgeFailure('command-undelivered', 'WILi voice status could not reach the backend.'));
    if (stage !== 'transcribing') sendChild({ type: 'stock.checkin-result', sessionId: protocol.hello!.sessionId,
      incidentId: p.incidentId, checkinId: p.checkinId, eventId: p.eventId, stage });
  };
  const utterance = async (p: Record<string, unknown>) => {
    if (transcribing || !matchingCheckin(p) || p.sessionId !== protocol.hello?.sessionId) return;
    if (p.format !== 'wav' || p.sampleRate !== 8000 || typeof p.audioBase64 !== 'string'
      || p.audioBase64.length > 128_100 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.audioBase64)
      || typeof p.eventId !== 'string' || !/^[\w-]{1,80}$/.test(p.eventId)) throw new Error('Invalid bounded microphone utterance.');
    const wav = Buffer.from(p.audioBase64, 'base64');
    const parsed = readMonoPcm16Wav(wav);
    if (parsed.sampleRate !== 8000 || parsed.durationMs > 6000) throw new Error('Invalid microphone duration.');
    audioWindows++; transcribing = true;
    audioStatus(p, 'transcribing');
    try {
      const { transcribeOgUtterance } = await import('./audio-transcription.ts');
      const result = await transcribeOgUtterance(wav, { signal: sttAbort.signal });
      if (!stopped && result.status === 'transcribed' && result.transcript && matchingCheckin(p)) {
        const reply = protocol.accept({ type: 'checkin.reply', source: 'body-wili', sessionId: p.sessionId,
          eventId: p.eventId, incidentId: p.incidentId, checkinId: p.checkinId, transcript: result.transcript });
        sendBackend(reply); console.log('A local WILi speech transcript reached the incident policy.');
        audioStatus(p, 'complete');
      } else if (!stopped && result.status === 'unavailable') {
        audioStatus(p, 'unavailable'); console.error('No usable WILi speech transcript; the check-in timer continues.');
      }
    } catch { if (!stopped) { audioStatus(p, 'unavailable'); console.error('Local WILi transcription unavailable; the check-in timer continues.'); } }
    finally { wav.fill(0); transcribing = false; }
  };
  child.stdout.on('data', (bytes: Buffer) => {
    if (stopped) return;
    try {
      for (const value of decoder.push(bytes)) {
        if (!value || typeof value !== 'object') throw new Error();
        const p = value as Record<string, unknown>;
        if (p.type === 'stock.status') {
          if (typeof p.status === 'string' && /^[a-z-]{1,40}$/.test(p.status)) console.log(`Stock WILi: ${p.status}.`);
          if (typeof p.status === 'string' && (p.status.startsWith('ui-') || p.status === 'speaker-volume') && typeof p.detail === 'string') console.log(p.detail.slice(0,160));
          if (p.status === 'ready' && !workerReady) {
            workerReady = true;
            const current = stockContextToDeliver(context, workerReady, Date.now(), true);
            // Reconnection restores the current display, without replaying an old closing announcement.
            if (current) sendChild(current);
            if (wellbeingContext) sendChild(wellbeingContext);
          }
          continue;
        }
        if (p.type === 'stock.utterance') {
          const work = utterance(p).catch(() => stop(new StockBridgeFailure('protocol', 'Invalid stock microphone packet.')));
          utterances.add(work); void work.finally(() => utterances.delete(work)); continue;
        }
        if (p.type === 'stock.wellbeing-utterance') {
          const work = wellbeingUtterance(p).catch(() => stop(new StockBridgeFailure('protocol', 'Invalid stock wellbeing microphone packet.')));
          utterances.add(work); void work.finally(() => utterances.delete(work)); continue;
        }
        if (p.type === 'voice.playback') {
          // Queue correlation is checked before accepting/forwarding ordered status.
          if (!validDevicePacket(p) || p.type !== 'voice.playback') throw new Error();
          conversation!.playback(p); continue;
        }
        const packet = protocol.accept(value);
        if (packet.type === 'device.hello') {
          if (socket || packet.transport !== 'stock-sdk') throw new Error();
          socket = new WebSocket(endpoint, { handshakeTimeout: 6000, maxPayload: 4096, followRedirects: false });
          socketClosed = new Promise<void>(resolve => socket!.once('close', () => resolve()));
          backendConnectTimer = setTimeout(() => stop(new StockBridgeFailure('backend-transport', 'WILi backend connection timed out.', true)), 5000);
          socket.on('open', () => {
            if (backendConnectTimer) { clearTimeout(backendConnectTimer); backendConnectTimer = null; }
            sendBackend(packet); console.log('FREE-WILi stock SDK connected: real acceleration, display, and buttons.');
          });
          socket.on('unexpected-response', (request, response) => {
            response.resume(); stop(backendHttpFailure(response.statusCode ?? 0)); request.destroy();
          });
          socket.on('message', raw => {
            if (stopped) return;
            try {
              const hostPacket: unknown = JSON.parse(raw.toString());
              if (!validHostPacket(hostPacket)) throw new Error();
              if (hostPacket.type === 'clock.ping') {
                // Initial image installation can take minutes. No microphone or
                // sensor is ready yet; stale setup pings must not fill stdin.
                if (!workerReady) return;
                while (pendingClocks.size >= 8) pendingClocks.delete(pendingClocks.values().next().value!);
                pendingClocks.add(hostPacket.id);
              }
              else {
                if (hostPacket.sessionId !== packet.sessionId) throw new Error();
                if (hostPacket.type === 'incident.context') {
                  context = hostPacket; conversation!.updateContext(hostPacket);
                  if (hostPacket.phase !== null && !['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(hostPacket.phase)) {
                    wellbeingAbort?.abort();
                    if (wellbeingContext?.enabled) {
                      wellbeingContext = { ...wellbeingContext, enabled: false };
                      if (workerReady) sendChild(wellbeingContext);
                    }
                  }
                  const current = stockContextToDeliver(context, workerReady);
                  if (current) sendChild(current);
                  return;
                }
                if (hostPacket.type === 'wellbeing.context') {
                  if (!hostPacket.enabled || wellbeingContext?.conversationId !== hostPacket.conversationId) wellbeingAbort?.abort();
                  wellbeingContext = hostPacket;
                  if (workerReady) sendChild(hostPacket);
                  return;
                }
              }
              if (hostPacket.type === 'audio.command') {
                if (workerReady && matchingCheckin(hostPacket)
                  && hostPacket.action === 'play' && hostPacket.asset === 'safe-confirmation')
                  sendChild({ type: 'voice.asset', sessionId: packet.sessionId, name: 'OKAY', incidentId: hostPacket.incidentId, checkinId: hostPacket.checkinId });
              } else if (hostPacket.type === 'conversation.speak') conversation!.enqueue(hostPacket);
              else sendChild(hostPacket);
            } catch { stop(new StockBridgeFailure('protocol', 'Invalid backend WILi context.')); }
          });
          socket.on('error', error => stop(backendTransportFailure(error)));
          socket.on('close', code => stop(stopped ? undefined : backendCloseFailure(code)));
          continue;
        }
        if (packet.type === 'clock.pong' && !pendingClocks.delete(packet.id)) continue;
        if (packet.type === 'button.press' && packet.action === 'help') {
          wellbeingAbort?.abort();
          if (wellbeingContext) wellbeingContext = { ...wellbeingContext, enabled: false };
        }
        if (packet.type === 'wellbeing.audio' && !matchingWellbeing(packet)) continue;
        if (packet.type === 'accel.sample') {
          const at = performance.now(); samples++;
          if (!firstSampleAt) firstSampleAt = at;
          if (lastSampleAt) maxGapMs = Math.max(maxGapMs, at - lastSampleAt);
          lastSampleAt = at;
        }
        if (!sendBackend(packet)) {
          if (packet.type === 'accel.sample') dropped++;
          else if (packet.type !== 'device.status') throw new Error('Undelivered physical action.');
        } else if (packet.type === 'accel.sample' && workerReady) options.onForwardedRealSample?.();
      }
    } catch { stop(new StockBridgeFailure('protocol', 'Invalid or undeliverable stock WILi packet.')); }
  });
  child.stderr.on('data', () => { if (!stopped) console.error('Stock SDK reported a diagnostic; device availability is checked separately.'); });
  child.on('error', () => stop(new StockBridgeFailure('worker-runtime', 'WILi SDK Python runtime unavailable; run setup:freewili.')));
  const workerEnded = () => {
    if (stopped) return;
    try { requireSelectedPort(options.port); }
    catch (error) { stop(error instanceof StockBridgeFailure ? error : new StockBridgeFailure('worker-runtime', 'Selected WILi port cannot be verified.')); return; }
    stop(new StockBridgeFailure('worker-unexpected', 'Stock WILi worker ended while its selected port remains present; verify SDK/configuration before retrying.'));
  };
  child.stdin.on('error', workerEnded); child.once('close', workerEnded);
  const report = setInterval(() => console.log(`WILi: ${samples} real samples, ${samples > 1 ? ((samples - 1) * 1000 / (lastSampleAt - firstSampleAt)).toFixed(1) : '0'} Hz observed, ${Math.round(maxGapMs)} ms maximum receipt gap, ${audioWindows} microphone windows, ${dropped} unavailable-backend drops.`), 10_000);
  await finished; clearInterval(report); clearInterval(portWatch);
  if (backendConnectTimer) clearTimeout(backendConnectTimer);
  await childClosed; await socketClosed;
  await conversationStopped;
  await Promise.allSettled(utterances);
  await rm(conversationDirectory, { recursive: true, force: true });
  if (killTimer) clearTimeout(killTimer);
  if (options.signal) options.signal.removeEventListener('abort', signal);
  else { process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); }
  if (failure) throw failure;
}

async function main() {
  const args = process.argv.slice(2), values = new Map<string,string>(); let reconnect = false, noUi = false;
  if (args.includes('--help')) { console.log('node native/freewili/stock-bridge.ts --port <DISPLAY /dev/cu.*> [--reconnect] [--backend http://127.0.0.1:8877] [--python output/freewili-runtime/bin/python] [--token-file data/pairing-token] [--audio-dir output/freewili-audio] [--ui-dir output/wili-ui] [--no-ui]\n--reconnect: foreground only, 120s outage window, 500ms–5s backoff; Ctrl-C stops without relaunch.\nBuild the optional 320x240 ambient screens with python3 scripts/prepare-wili-ui.py.'); return; }
  for (let i = 0; i < args.length;) {
    if (args[i] === '--no-ui') { if (noUi) throw new Error('Duplicate --no-ui.'); noUi = true; args.splice(i, 1); }
    else if (args[i] === '--reconnect') { if (reconnect) throw new Error('Duplicate --reconnect.'); reconnect = true; args.splice(i, 1); } else i++;
  }
  for (let i=0; i<args.length; i+=2) {
    if (!['--port','--backend','--python','--token-file','--audio-dir','--ui-dir'].includes(args[i]) || !args[i+1] || values.has(args[i])) throw new Error('Invalid stock bridge arguments.');
    values.set(args[i],args[i+1]);
  }
  if (!values.has('--port')) throw new Error('An explicit DISPLAY port is required.');
  const uiDir = values.get('--ui-dir') ?? resolve('output/wili-ui');
  const uiContacts: string[] = [];
  // Names are cached before serial/audio starts. Phone numbers never enter UI assets.
  if (!noUi && existsSync(join(uiDir, 'manifest.json'))) {
    try {
      const response = await fetch(new URL('/api/state', values.get('--backend') ?? 'http://127.0.0.1:8877'),
        { signal: AbortSignal.timeout(2000) });
      const state = await response.json() as { responders?: { name?: unknown }[] };
      if (response.ok && Array.isArray(state.responders)) for (const responder of state.responders) {
        if (typeof responder.name === 'string' && responder.name.trim() && !uiContacts.includes(responder.name)) uiContacts.push(responder.name);
        if (uiContacts.length === 2) break;
      }
    } catch { console.log('WILi uses generic responder artwork until names are available.'); }
  }
  const options = {port:values.get('--port')!, base:values.get('--backend') ?? 'http://127.0.0.1:8877',
    python:values.get('--python') ?? resolve('output/freewili-runtime/bin/python'), tokenFile:values.get('--token-file') ?? 'data/pairing-token',
    audioDir:values.get('--audio-dir') ?? process.env.LIFELINE_WILI_AUDIO_DIR ?? 'output/freewili-audio',
    uiDir:!noUi && existsSync(join(uiDir, 'manifest.json')) ? uiDir : undefined, uiContacts};
  if (!reconnect) { await runStockBridge(options); return; }
  const abort = new AbortController(), cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  console.log('WILi foreground recovery enabled. Only the selected DISPLAY port will be retried; no service is installed.');
  try {
    await superviseStockBridge({ signal: abort.signal,
      attempt: (signal, onForwardedRealSample) => runStockBridge({ ...options, signal, onForwardedRealSample }),
      onRetry: info => console.error(`WILi unavailable (${info.kind}); retry ${info.attempt} in ${Math.round(info.delayMs)}ms, ${Math.round(info.remainingMs / 1000)}s recovery remaining.`),
    });
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : 'Stock WILi bridge failed.'); process.exitCode=1; });
