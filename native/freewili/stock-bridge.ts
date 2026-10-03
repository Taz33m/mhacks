import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WiliDeviceProtocol, WiliNdjson, validHostPacket } from './protocol.ts';
import type { WiliIncidentContext } from './protocol.ts';
import { readMonoPcm16Wav } from './audio.ts';

/** Official stock SDK transport. Only the child process owns the DISPLAY serial port. */
export async function runStockBridge(options: { port: string; python: string; tokenFile: string; base: string; audioDir: string }): Promise<void> {
  if (!/^\/dev\/cu\.[\w.-]+$/.test(options.port) || !statSync(options.port).isCharacterDevice()) throw new Error('Select the actual DISPLAY serial port.');
  const base = new URL(options.base);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('Use a plain backend origin.');
  const tokenStat = statSync(options.tokenFile);
  if (!tokenStat.isFile() || tokenStat.size > 1024 || (tokenStat.mode & 0o077)) throw new Error('Pairing token file must be private.');
  const token = readFileSync(options.tokenFile, 'utf8').trim();
  if (!/^[\w-]{16,200}$/.test(token)) throw new Error('Invalid local pairing token.');
  const endpoint = new URL('/motion', base); endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('source', 'body-wili'); endpoint.searchParams.set('token', token);
  const child = spawn(options.python, [fileURLToPath(new URL('./stock_io.py', import.meta.url)), '--port', options.port,
    '--audio-dir', resolve(options.audioDir)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const protocol = new WiliDeviceProtocol(), decoder = new WiliNdjson(140_000);
  let socket: WebSocket | null = null, context: WiliIncidentContext | null = null;
  let stopped = false, transcribing = false, samples = 0, dropped = 0, audioWindows = 0;
  let firstSampleAt = 0, lastSampleAt = 0, maxGapMs = 0;
  const pendingClocks = new Set<string>();
  const sttAbort = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const childClosed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = (reason?: string) => {
    if (stopped) return; stopped = true; sttAbort.abort();
    if (reason) { console.error(reason); process.exitCode = 1; }
    socket?.terminate(); child.stdin.end(); child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); killTimer.unref(); finish();
  };
  const signal = () => stop();
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  const sendChild = (packet: unknown) => {
    if (!child.stdin.writable || child.stdin.writableLength > 64_000) { stop('Stock WILi command queue stalled.'); return; }
    child.stdin.write(JSON.stringify(packet) + '\n');
  };
  const sendBackend = (packet: unknown): boolean => {
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64_000) return false;
    socket.send(JSON.stringify(packet)); return true;
  };
  const matchingCheckin = (p: { incidentId?: unknown; checkinId?: unknown }) => context?.phase === 'CONFIRMING'
    && context.incidentId === p.incidentId && context.checkinId === p.checkinId
    && context.checkinDeadline !== null && Date.now() < context.checkinDeadline;
  const utterance = async (p: Record<string, unknown>) => {
    if (transcribing || !matchingCheckin(p) || p.sessionId !== protocol.hello?.sessionId) return;
    if (p.format !== 'wav' || p.sampleRate !== 8000 || typeof p.audioBase64 !== 'string'
      || p.audioBase64.length > 128_100 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.audioBase64)
      || typeof p.eventId !== 'string' || !/^[\w-]{1,80}$/.test(p.eventId)) throw new Error('Invalid bounded microphone utterance.');
    const wav = Buffer.from(p.audioBase64, 'base64');
    const parsed = readMonoPcm16Wav(wav);
    if (parsed.sampleRate !== 8000 || parsed.durationMs > 6000) throw new Error('Invalid microphone duration.');
    audioWindows++; transcribing = true;
    try {
      const { transcribeOgUtterance } = await import('./audio-transcription.ts');
      const result = await transcribeOgUtterance(wav, { signal: sttAbort.signal });
      if (!stopped && result.status === 'transcribed' && result.transcript && matchingCheckin(p)) {
        const reply = protocol.accept({ type: 'checkin.reply', source: 'body-wili', sessionId: p.sessionId,
          eventId: p.eventId, incidentId: p.incidentId, checkinId: p.checkinId, transcript: result.transcript });
        sendBackend(reply); console.log('A local WILi speech transcript reached the incident policy.');
      } else if (!stopped && result.status === 'unavailable') console.error('No usable WILi speech transcript; the check-in timer continues.');
    } catch { if (!stopped) console.error('Local WILi transcription unavailable; the check-in timer continues.'); }
    finally { wav.fill(0); transcribing = false; }
  };
  child.stdout.on('data', (bytes: Buffer) => {
    try {
      for (const value of decoder.push(bytes)) {
        if (!value || typeof value !== 'object') throw new Error();
        const p = value as Record<string, unknown>;
        if (p.type === 'stock.status') {
          if (typeof p.status === 'string' && /^[a-z-]{1,40}$/.test(p.status)) console.log(`Stock WILi: ${p.status}.`);
          continue;
        }
        if (p.type === 'stock.utterance') { void utterance(p).catch(() => stop('Invalid stock microphone packet.')); continue; }
        const packet = protocol.accept(value);
        if (packet.type === 'device.hello') {
          if (socket || packet.transport !== 'stock-sdk') throw new Error();
          socket = new WebSocket(endpoint, { handshakeTimeout: 5000, maxPayload: 4096, followRedirects: false });
          socket.on('open', () => { sendBackend(packet); console.log('FREE-WILi stock SDK connected: real acceleration, display, and buttons.'); });
          socket.on('message', raw => {
            try {
              const hostPacket: unknown = JSON.parse(raw.toString());
              if (!validHostPacket(hostPacket)) throw new Error();
              if (hostPacket.type === 'clock.ping') {
                while (pendingClocks.size >= 8) pendingClocks.delete(pendingClocks.values().next().value!);
                pendingClocks.add(hostPacket.id);
              }
              else {
                if (hostPacket.sessionId !== packet.sessionId) throw new Error();
                if (hostPacket.type === 'incident.context') context = hostPacket;
              }
              if (hostPacket.type === 'audio.command') {
                if (context?.phase === 'CONFIRMING' && context.incidentId === hostPacket.incidentId && context.checkinId === hostPacket.checkinId
                  && hostPacket.action === 'play' && hostPacket.asset === 'safe-confirmation')
                  sendChild({ type: 'voice.asset', sessionId: packet.sessionId, name: 'OKAY', incidentId: hostPacket.incidentId, checkinId: hostPacket.checkinId });
              } else sendChild(hostPacket);
            } catch { stop('Invalid backend WILi context.'); }
          });
          socket.on('error', () => stop('WILi backend connection unavailable.'));
          socket.on('close', () => stop(stopped ? undefined : 'WILi backend disconnected; restart the foreground bridge.'));
          continue;
        }
        if (packet.type === 'clock.pong' && !pendingClocks.delete(packet.id)) continue;
        if (packet.type === 'accel.sample') {
          const at = performance.now(); samples++;
          if (!firstSampleAt) firstSampleAt = at;
          if (lastSampleAt) maxGapMs = Math.max(maxGapMs, at - lastSampleAt);
          lastSampleAt = at;
        }
        if (!sendBackend(packet)) {
          if (packet.type === 'accel.sample') dropped++;
          else if (packet.type !== 'device.status') throw new Error('Undelivered physical action.');
        }
      }
    } catch { stop('Invalid or undeliverable stock WILi packet.'); }
  });
  child.stderr.on('data', () => { if (!stopped) console.error('Stock SDK reported a diagnostic; device availability is checked separately.'); });
  child.on('error', () => stop('WILi SDK Python runtime unavailable; run setup:freewili.'));
  child.stdin.on('error', () => stop(stopped ? undefined : 'WILi worker input closed.'));
  child.once('close', () => stop(stopped ? undefined : 'Stock WILi serial worker ended.'));
  const report = setInterval(() => console.log(`WILi: ${samples} real samples, ${samples > 1 ? ((samples - 1) * 1000 / (lastSampleAt - firstSampleAt)).toFixed(1) : '0'} Hz observed, ${Math.round(maxGapMs)} ms maximum receipt gap, ${audioWindows} microphone windows, ${dropped} unavailable-backend drops.`), 10_000);
  await finished; clearInterval(report); await childClosed;
  if (killTimer) clearTimeout(killTimer);
  process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
}

async function main() {
  const args = process.argv.slice(2), values = new Map<string,string>();
  if (args.includes('--help')) { console.log('node native/freewili/stock-bridge.ts --port <DISPLAY /dev/cu.*> [--backend http://127.0.0.1:8877] [--python output/freewili-runtime/bin/python] [--token-file data/pairing-token] [--audio-dir output/freewili-audio]'); return; }
  for (let i=0; i<args.length; i+=2) {
    if (!['--port','--backend','--python','--token-file','--audio-dir'].includes(args[i]) || !args[i+1] || values.has(args[i])) throw new Error('Invalid stock bridge arguments.');
    values.set(args[i],args[i+1]);
  }
  if (!values.has('--port')) throw new Error('An explicit DISPLAY port is required.');
  await runStockBridge({port:values.get('--port')!, base:values.get('--backend') ?? 'http://127.0.0.1:8877',
    python:values.get('--python') ?? resolve('output/freewili-runtime/bin/python'), tokenFile:values.get('--token-file') ?? 'data/pairing-token',
    audioDir:values.get('--audio-dir') ?? process.env.LIFELINE_WILI_AUDIO_DIR ?? 'output/freewili-audio'});
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : 'Stock WILi bridge failed.'); process.exitCode=1; });
