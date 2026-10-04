import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { Controller } from '../src/controller.ts';
import { FreeWili } from '../src/freewili.ts';
import { handleResponderRelay } from '../src/responder-relay.ts';
import { WiliDeviceProtocol } from '../native/freewili/protocol.ts';
import { readStockVoiceManifest } from '../native/freewili/prepare-stock-audio.ts';
import type { Action, CheckinDecision, Incident, ProviderInbound } from '../src/contracts.ts';
import type { WiliIncidentContext, WiliCheckinAudio } from '../native/freewili/protocol.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEARER_STATEMENT = "I fell pretty hard. My ankle hurts and I can't stand up.";
const RESPONDER_REPLY = 'Smoke wearer, stay seated. I am coming now.';
const RESPONDER = { id: 'smoke-responder', name: 'Smoke responder', phone: '+12025550101' };
const CHANNEL = { chatId: 'isolated-smoke-chat', lineId: 'isolated-smoke-line' };
export interface VoiceSmokeOptions { port: string; python: string; audioDir: string; audioDevice: string; timeoutMs: number; checkinMs: number }
interface RecordedOutbound { action: Action; messageId: string; chatId: string; lineId: string }
class VoiceSmokeFailure extends Error {
  readonly report: unknown;
  constructor(message: string, report: unknown) { super(message); this.report = report; }
}

export function parseVoiceSmokeArgs(args: string[]): VoiceSmokeOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--port', '--python', '--audio-dir', '--audio-device', '--timeout-ms', '--checkin-ms'].includes(key) || !value || values.has(key))
      throw new Error('Use --port <DISPLAY port> with optional --python, --audio-dir, --audio-device, --timeout-ms, --checkin-ms.');
    values.set(key, value);
  }
  const port = values.get('--port');
  if (!port || !/^\/dev\/cu\.[\w.-]+$/.test(port)) throw new Error('An explicit verified DISPLAY serial port is required.');
  const timeoutMs = Number(values.get('--timeout-ms') ?? '150000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 240000)
    throw new Error('--timeout-ms must be between 30000 and 240000.');
  const audioDevice = values.get('--audio-device') ?? 'MacBook Pro Speakers';
  if (!audioDevice.trim() || audioDevice.length > 100 || /[\x00-\x1f\x7f]/.test(audioDevice))
    throw new Error('--audio-device must be a Core Audio output name or ID.');
  const checkinMs = Number(values.get('--checkin-ms') ?? '20000');
  if (!Number.isSafeInteger(checkinMs) || checkinMs < 20000 || checkinMs > 60000)
    throw new Error('--checkin-ms must be 20000–60000; windows above 20000 are diagnostic only.');
  return { port, python: resolve(values.get('--python') ?? join(ROOT, 'output/freewili-runtime/bin/python')),
    audioDir: resolve(values.get('--audio-dir') ?? process.env.LIFELINE_WILI_AUDIO_DIR ?? join(ROOT, 'output/freewili-audio')), audioDevice, timeoutMs, checkinMs };
}

/** Recording transport only: persist fixture provenance without importing any cloud provider. */
export function recordSmokeOutbox(controller: Controller, records: RecordedOutbound[]): void {
  for (const lane of ['wearer', 'responders'] as const) for (let count = 0; count < 32; count++) {
    const action = controller.claimAction(lane); if (!action) break;
    if (!controller.actionPermitted(action)) throw new Error('Smoke outbox claimed a stale action.');
    const messageId = `smoke-recorded-${randomUUID()}`;
    records.push({ action: { ...action }, messageId, ...CHANNEL });
    controller.finishAction(action.id, 'provider_accepted', 'Synthetic recording transport accepted locally; no external message sent.', messageId, CHANNEL);
  }
}

export function verifySmokeWearerReply(transcript: string, decision: CheckinDecision, records: RecordedOutbound[]): RecordedOutbound {
  if (decision !== 'help_requested') throw new Error('Actual microphone transcript did not request help under the current policy.');
  if (!/\bankle\b/i.test(transcript)) throw new Error('Actual microphone transcript did not retain the ankle statement.');
  const quote = records.find(record => record.action.type === 'wearer_relay' && record.action.recipientId === RESPONDER.id
    && record.action.text.includes(`“${transcript}”`));
  if (!quote) throw new Error('The real recognized wearer quote did not reach the recording transport.');
  return quote;
}

/** Physical acoustic rehearsal; call only when the DISPLAY port is free. No production server/database is imported. */
export async function runWiliVoiceSmoke(options: VoiceSmokeOptions): Promise<unknown> {
  if (!(await stat(options.port)).isCharacterDevice()) throw new Error('The supplied DISPLAY port is unavailable.');
  if (!(await stat(options.python)).isFile()) throw new Error('The configured stock SDK Python runtime is unavailable.');
  const whisperModel = process.env.LIFELINE_WHISPER_MODEL;
  if (!whisperModel || !(await stat(whisperModel)).isFile()) throw new Error('Configure the actual LIFELINE_WHISPER_MODEL before running the physical smoke test.');
  if (!process.env.ELEVENLABS_API_KEY?.trim()) throw new Error('ElevenLabs credentials are required for actual responder synthesis.');
  if (!(await readStockVoiceManifest(options.audioDir))) throw new Error('Prepare the verified stock voice assets before running the physical smoke test.');
  try {
    const { stdout } = await promisify(execFile)('/usr/sbin/lsof', ['-t', '--', options.port], { timeout: 3000, maxBuffer: 4096 });
    if (stdout.trim()) throw new Error('The DISPLAY port is already open. Stop its foreground bridge before running this isolated test.');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 1)) throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-physical-voice-smoke-'));
  const token = randomBytes(24).toString('hex'), tokenFile = join(directory, 'pairing-token');
  const controller = new Controller(join(directory, 'smoke.sqlite'), [RESPONDER], Date.now,
    { checkinMs: options.checkinMs, acceptMs: 180000, progressMs: 180000 }, { wearerName: 'Smoke wearer' });
  const adapter = new FreeWili(), protocol = new WiliDeviceProtocol();
  const records: RecordedOutbound[] = [], stages: { stage: string; at: number }[] = [];
  const speechStatuses: { status: string; at: number }[] = [];
  let socket: WebSocket | null = null, child: ChildProcess | null = null, incident: Incident | null = null;
  let sampleCount = 0, sourceFailure: Error | null = null, stopping = false;
  let transcript: string | null = null, decision: CheckinDecision | null = null, spokenAt: number | null = null;
  let transcriptAt = 0, phraseStartedAt = 0, triggeredAt = 0, dispatchedAt = 0, responderSpeechId: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null, contextVersion = '';
  const audioSignals: (WiliCheckinAudio & { observedAt: number })[] = [];
  const abort = new AbortController(), end = performance.now() + options.timeoutMs;
  const watchdog = setTimeout(() => abort.abort(), options.timeoutMs); watchdog.unref();
  const stage = (name: string) => { stages.push({ stage: name, at: Date.now() }); console.error(`Voice smoke: ${name}.`); };
  const shutdownSignal = () => abort.abort();
  process.once('SIGINT', shutdownSignal); process.once('SIGTERM', shutdownSignal);
  const send = (packet: unknown) => {
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64000) throw new Error('Isolated physical bridge connection is unavailable.');
    socket.send(JSON.stringify(packet));
  };
  const ping = () => { if (protocol.hello && socket?.readyState === WebSocket.OPEN) send(adapter.ping()); };
  const context = () => {
    if (!protocol.hello || socket?.readyState !== WebSocket.OPEN) return;
    const current = controller.latest(), version = `${current?.id ?? ''}:${current?.version ?? ''}`;
    if (version === contextVersion) return; contextVersion = version;
    const voiceAsset = current?.phase === 'CONFIRMING' ? 'CHECKIN' : current?.phase === 'HELP_REQUESTED' ? 'HELP' : null;
    const packet: WiliIncidentContext = { type: 'incident.context', sessionId: protocol.hello.sessionId,
      incidentId: current?.id ?? null, checkinId: current?.checkinId ?? null, phase: current?.phase ?? null,
      checkinDeadline: current?.checkinDeadline ?? null, serverTime: Date.now(), ownerName: null,
      statusText: `SYNTHETIC VOICE SMOKE | ${current?.phase ?? 'READY'}`, voiceAsset };
    send(packet);
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ status: 'isolated-voice-smoke', externalMessaging: false }));
  });
  const ingest = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on('upgrade', (request, connection, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), candidate = Buffer.from(url.searchParams.get('token') ?? ''), expected = Buffer.from(token);
    if (url.pathname !== '/motion' || url.searchParams.get('source') !== 'body-wili' || socket
      || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      connection.write('HTTP/1.1 403 Forbidden\r\n\r\n'); connection.destroy(); return;
    }
    ingest.handleUpgrade(request, connection, head, ws => {
      socket = ws; adapter.connected();
      ws.on('error', () => { if (!stopping) sourceFailure = new Error('Physical smoke WebSocket failed.'); });
      ws.on('close', () => { adapter.disconnected(); if (!stopping) sourceFailure = new Error('Physical smoke bridge disconnected.'); });
      ws.on('message', bytes => {
        try {
          const packet = protocol.accept(JSON.parse(bytes.toString()));
          if (packet.type === 'device.hello') { ping(); context(); return; }
          if (packet.type === 'clock.pong') { adapter.pong(packet); return; }
          if (packet.type === 'accel.sample') {
            if (adapter.sample(packet)) { sampleCount++; if (adapter.view().alignmentUncertaintyMs === null) ping(); }
            return;
          }
          if (packet.type === 'checkin.audio') {
            const audio = packet;
            if (incident && audio.incidentId === incident.id && audio.checkinId === incident.checkinId) {
              audioSignals.push({ ...audio, observedAt: Date.now() }); stage(`board ${audio.stage}`);
              if (audio.stage === 'unavailable') throw new Error('Actual board microphone or local speech recognition reported unavailable.');
            }
            return;
          }
          if (packet.type === 'checkin.reply') {
            transcript = packet.transcript;
            transcriptAt = Date.now();
            decision = controller.recordCheckinReply({ incidentId: packet.incidentId, checkinId: packet.checkinId,
              transcript: packet.transcript, source: 'freewili-local-speech' });
            recordSmokeOutbox(controller, records); context(); return;
          }
          if (packet.type === 'voice.playback') {
            if (packet.eventId !== responderSpeechId || Date.now() < dispatchedAt)
              throw new Error('Responder playback belongs to another fixture or an earlier test step.');
            if (!controller.recordResponderPlayback(packet.eventId, packet.incidentId, packet.sessionId, packet.status))
              throw new Error('Uncorrelated physical responder playback.');
            speechStatuses.push({ status: packet.status, at: Date.now() });
            if (packet.status === 'spoken') spokenAt = Date.now();
            if (packet.status === 'failed') throw new Error('Actual responder synthesis or playback failed.');
            return;
          }
          if (packet.type === 'button.press') throw new Error('Unexpected physical button press interrupted the acoustic fixture.');
          if (packet.type === 'device.status') throw new Error('Physical board reported unavailable acquisition.');
          throw new Error('Unexpected physical smoke protocol packet.');
        } catch (error) {
          sourceFailure = error instanceof Error ? error : new Error('Physical smoke packet failed validation.');
          ws.close(1008, 'Isolated smoke failed.');
        }
      });
    });
  });
  server.on('error', () => { sourceFailure = new Error('Isolated smoke backend failed.'); });
  const waitFor = async (matches: () => boolean, description: string, windowMs: number) => {
    const until = Math.min(end, performance.now() + windowMs);
    for (;;) {
      if (abort.signal.aborted) throw new Error('Physical smoke test was interrupted.');
      if (sourceFailure) throw sourceFailure;
      if (matches()) return;
      if (performance.now() >= until) throw new Error(`Timed out waiting for ${description}.`);
      await pause(40, undefined, { signal: abort.signal });
    }
  };
  try {
    await writeFile(tokenFile, token, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:SPECTRUM_|PHOTON_|FINCH|LIFELINE_LLM_)/.test(key)) delete env[key];
    child = spawn(process.execPath, [join(ROOT, 'native/freewili/stock-bridge.ts'), '--port', options.port,
      '--backend', `http://127.0.0.1:${port}`, '--token-file', tokenFile, '--python', options.python, '--audio-dir', options.audioDir],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Consume diagnostics without logging URLs, tokens, transcripts or arbitrary child output.
    child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
    child.on('error', () => { sourceFailure = new Error('The actual stock bridge could not start.'); });
    child.once('exit', () => { if (!stopping) sourceFailure = new Error('The actual stock bridge exited before the smoke test completed.'); });
    let lastPing = 0;
    heartbeat = setInterval(() => {
      try {
        controller.tick(); recordSmokeOutbox(controller, records); context();
        if (performance.now() - lastPing >= 2000) { lastPing = performance.now(); ping(); }
        if (protocol.hello && socket?.readyState === WebSocket.OPEN) {
          const message = controller.claimResponderSpeech(protocol.hello.sessionId);
          if (message) {
            if (message.id !== responderSpeechId) throw new Error('Only the fresh synthetic responder reply may be dispatched.');
            dispatchedAt = Date.now();
            send({ type: 'conversation.speak', sessionId: protocol.hello.sessionId,
              eventId: message.id, incidentId: message.incidentId, speakerName: message.speakerName, text: message.text });
          }
        }
      } catch (error) { sourceFailure = error instanceof Error ? error : new Error('Isolated smoke controller failed.'); }
    }, 100);
    stage('wait for real board acquisition');
    await waitFor(() => sampleCount >= 3 && adapter.view().fresh, 'fresh actual stock acceleration', 60000);
    const initialSamples = sampleCount;
    triggeredAt = Date.now();
    incident = controller.trigger({ kind: 'synthetic', summary: 'SYNTHETIC PHYSICAL VOICE SMOKE: acoustic microphone and speaker pipeline; no fall asserted.' });
    recordSmokeOutbox(controller, records); context();
    stage('wait for authenticated microphone listening');
    await waitFor(() => audioSignals.some(audio => audio.stage === 'listening' && audio.observedAt >= triggeredAt), 'the board microphone to actually open', 15000);
    stage('play ankle phrase into actual board microphone');
    phraseStartedAt = Date.now();
    await promisify(execFile)('/usr/bin/say', ['-a', options.audioDevice, '-v', 'Samantha', '-r', '175', WEARER_STATEMENT],
      { signal: abort.signal, timeout: 8000, maxBuffer: 4096 });
    stage('wait for real local Whisper transcript');
    await waitFor(() => transcript !== null && decision !== null, 'actual local Whisper checkin.reply', 30000);
    if (transcriptAt < phraseStartedAt) throw new Error('The recognized transcript predates the fresh acoustic input step.');
    const recognized = transcript as unknown as string, classified = decision as unknown as CheckinDecision;
    const quote = verifySmokeWearerReply(recognized, classified, records);
    if (controller.active()?.phase !== 'HELP_REQUESTED') throw new Error('The actual spoken help decision did not escalate the isolated incident.');
    stage('inject labelled synthetic authorized responder reply');
    const inbound: ProviderInbound = { messageId: `smoke-synthetic-inbound-${randomUUID()}`, sender: RESPONDER.phone,
      kind: 'text', text: RESPONDER_REPLY, targetMessageId: quote.messageId, ...CHANNEL, providerTimestamp: Date.now() };
    if (!handleResponderRelay(inbound, controller)) throw new Error('The existing responder handler rejected the authorized synthetic fixture.');
    responderSpeechId = controller.conversation(incident.id).findLast(message => message.speaker === 'responder')?.id ?? null;
    if (!responderSpeechId) throw new Error('The synthetic responder reply was not persisted.');
    if (controller.active()?.ownerId !== null) throw new Error('A spoken responder relay incorrectly established ownership.');
    stage('wait for actual dynamic board playback');
    await waitFor(() => spokenAt !== null, 'the complete responder playback window', 65000);
    if (speechStatuses.map(p => p.status).join(',') !== 'queued,playing,spoken') throw new Error('Physical responder playback did not produce its ordered status sequence.');
    const beforeRecovery = sampleCount;
    stage('verify fresh sensor recovery after speech');
    await waitFor(() => sampleCount >= beforeRecovery + 3 && adapter.view().fresh, 'fresh post-playback acceleration', 15000);
    return { schemaVersion: 1, status: 'passed', fixture: 'synthetic acoustic wearer and synthetic authorized responder',
      incidentId: incident.id, externalMessagesSent: 0, transport: 'in-memory recording',
      wearerInput: { source: `macOS say through explicit ${options.audioDevice} to the board microphone`, requestedText: WEARER_STATEMENT,
        actualTranscript: recognized, engine: 'actual local whisper.cpp', decision: classified },
      recordedWearerQuote: quote.action.text, responderReply: { synthetic: true, text: RESPONDER_REPLY,
        speakerName: RESPONDER.name, statuses: speechStatuses, audibilityIndependentlyVerified: false },
      microphoneStages: audioSignals.map(audio => audio.stage), acquisition: { initialSamples, totalSamples: sampleCount,
        freshAfterPlayback: adapter.view().fresh, sampleHz: adapter.view().sampleHz, fallDetectionTested: false },
      timing: { configuredCheckinMs: options.checkinMs, diagnosticWindow: options.checkinMs > 20000,
        elapsedTranscriptMs: transcriptAt - incident.createdAt, withinNormal20Seconds: transcriptAt - incident.createdAt < 20000 }, stages };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Physical voice smoke test failed.';
    throw new VoiceSmokeFailure(message, { schemaVersion: 1, status: 'failed', detail: message,
      fixture: 'synthetic acoustic wearer and synthetic authorized responder', externalMessagesSent: 0,
      actualTranscript: transcript, decision, microphoneStages: audioSignals.map(audio => audio.stage),
      timing: { configuredCheckinMs: options.checkinMs, diagnosticWindow: options.checkinMs > 20000,
        elapsedTranscriptMs: transcriptAt && incident ? transcriptAt - incident.createdAt : null,
        withinNormal20Seconds: transcriptAt && incident ? transcriptAt - incident.createdAt < 20000 : false },
      playback: speechStatuses, samplesObserved: sampleCount, stages });
  } finally {
    stopping = true; abort.abort(); clearTimeout(watchdog); if (heartbeat) clearInterval(heartbeat);
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>(resolve => child!.once('close', () => resolve()));
      child.kill('SIGTERM'); const kill = setTimeout(() => child!.kill('SIGKILL'), 20000); kill.unref();
      await ended; clearTimeout(kill);
    }
    (socket as WebSocket | null)?.terminate(); ingest.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    controller.close(); await rm(directory, { recursive: true, force: true });
    process.removeListener('SIGINT', shutdownSignal); process.removeListener('SIGTERM', shutdownSignal);
  }
}

if (import.meta.main) {
  if (process.argv.includes('--help')) console.log('node --env-file-if-exists=.env scripts/wili-voice-smoke.ts --port <DISPLAY /dev/cu.*> [--python <SDK Python>] [--audio-dir <verified voice assets>] [--audio-device "MacBook Pro Speakers"] [--timeout-ms 150000] [--checkin-ms 20000]\nRuns a synthetic incident with real microphone/Whisper/board playback. No cloud messages. Uses the explicit output without changing the global audio route. The speaker must be acoustically audible to the WILi microphone. Stop the existing port-owning bridge first. Larger check-in windows are labelled diagnostic only.');
  else Promise.resolve().then(() => runWiliVoiceSmoke(parseVoiceSmokeArgs(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      if (error instanceof VoiceSmokeFailure) console.log(JSON.stringify(error.report, null, 2));
      console.error(error instanceof Error ? error.message : 'Physical voice smoke test failed.'); process.exitCode = 1;
    });
}
