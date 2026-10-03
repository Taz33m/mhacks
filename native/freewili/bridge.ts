import { spawn } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WiliDeviceProtocol, WiliNdjson, validHostPacket } from './protocol.ts';
import type { WiliAudioCommand } from './protocol.ts';

/** Offline protocol check. It never opens a serial port, socket, or provider. */
export async function checkWiliFile(path: string): Promise<Record<string, unknown>> {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 10_000_000) throw new Error('Offline WILi input must be a local file under 10 MB.');
  const decoder = new WiliNdjson(), protocol = new WiliDeviceProtocol();
  const counts: Record<string, number> = {};
  for await (const bytes of createReadStream(path, { highWaterMark: 4096 })) {
    for (const value of decoder.push(bytes as Buffer)) {
      const packet = protocol.accept(value); counts[packet.type] = (counts[packet.type] ?? 0) + 1;
    }
  }
  decoder.finish();
  if (!protocol.hello) throw new Error('Offline WILi input has no device hello.');
  return { mode: 'offline-protocol-check', physicalHardwareVerified: false,
    source: 'body-wili', deviceModel: protocol.hello.deviceModel, counts,
    timing: 'Packet ordering only; clock reconstruction is covered separately by adapter tests.' };
}

interface BridgeOptions { port: string; base: string; tokenFile: string; python: string }
export async function runWiliBridge(options: BridgeOptions): Promise<void> {
  if (!/^\/dev\/(cu\.[\w.-]+|tty(?:ACM|USB)\d+)$/.test(options.port) || !statSync(options.port).isCharacterDevice())
    throw new Error('Choose an explicit /dev/cu.* or /dev/ttyACM*/ttyUSB* serial character device.');
  const base = new URL(options.base);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('Use a plain backend origin, for example http://127.0.0.1:8877.');
  const tokenStat = statSync(options.tokenFile);
  if (!tokenStat.isFile() || tokenStat.size > 1024 || (tokenStat.mode & 0o077) !== 0)
    throw new Error('Pairing token must be a small private local file; use chmod 600.');
  const token = readFileSync(options.tokenFile, 'utf8').trim();
  if (!/^[\w-]{16,200}$/.test(token)) throw new Error('Pairing token file is invalid.');
  const endpoint = new URL('/motion', base); endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('source', 'body-wili'); endpoint.searchParams.set('token', token);
  const serial = spawn(options.python, [fileURLToPath(new URL('./serial_io.py', import.meta.url)), '--port', options.port],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new WiliNdjson(), protocol = new WiliDeviceProtocol();
  const clocks = new Map<string, number>(), audio = new Map<string, WiliAudioCommand>();
  let socket: WebSocket | null = null, stopped = false, dropped = 0, forwarded = 0;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const childExit = new Promise<void>(resolve => serial.once('close', () => resolve()));
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const stop = (failure?: string) => {
    if (stopped) return; stopped = true;
    if (failure) { process.exitCode = 1; console.error(failure); }
    if (helloTimer) clearTimeout(helloTimer);
    socket?.terminate(); serial.stdin.end(); serial.kill('SIGTERM');
    killTimer = setTimeout(() => serial.kill('SIGKILL'), 1000); killTimer.unref();
    finish();
  };
  const signal = () => stop();
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  const writeDevice = (value: unknown) => {
    if (serial.stdin.writableLength > 64_000 || !serial.stdin.writable) { stop('WILi serial output stalled; bridge stopped.'); return; }
    serial.stdin.write(JSON.stringify(value) + '\n');
  };
  const connect = () => {
    if (socket || stopped) return;
    if (helloTimer) clearTimeout(helloTimer);
    socket = new WebSocket(endpoint, { handshakeTimeout: 5000, maxPayload: 4096, followRedirects: false });
    socket.on('open', () => {
      if (!protocol.hello || stopped) return;
      socket!.send(JSON.stringify(protocol.hello));
      console.log('WILi serial/WebSocket bridge connected. Custom firmware required; no hardware verification is implied.');
    });
    socket.on('message', bytes => {
      try {
        const packet: unknown = JSON.parse(bytes.toString());
        if (!validHostPacket(packet)) throw new Error();
        if (packet.type !== 'clock.ping' && packet.sessionId !== protocol.hello?.sessionId) throw new Error();
        if (packet.type === 'clock.ping') {
          if (clocks.has(packet.id)) throw new Error();
          while (clocks.size >= 8) clocks.delete(clocks.keys().next().value!);
          clocks.set(packet.id, performance.now());
        } else if (packet.type === 'audio.command') {
          if (audio.has(packet.commandId) || audio.size >= 8) throw new Error();
          audio.set(packet.commandId, packet);
        }
        writeDevice(packet);
      } catch { stop('Invalid or stale server-to-WILi command; bridge stopped.'); }
    });
    socket.on('error', () => stop('WILi backend connection failed. Check body-wili server support and the private pairing token.'));
    socket.on('close', () => stop('WILi backend connection closed; rerun the foreground bridge when ready.'));
  };
  serial.stdout.on('data', (bytes: Buffer) => {
    try {
      for (const value of decoder.push(bytes)) {
        const packet = protocol.accept(value);
        if (packet.type === 'device.hello') { connect(); continue; }
        if (packet.type === 'clock.pong') {
          const sent = clocks.get(packet.id); clocks.delete(packet.id);
          if (sent === undefined || performance.now() - sent > 10_000) continue;
        }
        if (packet.type === 'audio.ack') {
          const command = audio.get(packet.commandId);
          if (!command || command.incidentId !== packet.incidentId || command.checkinId !== packet.checkinId
            || (command.action === 'stop' && !['stopped', 'failed'].includes(packet.status))
            || (command.action === 'play' && packet.status === 'stopped')) throw new Error();
          if (packet.status !== 'started') audio.delete(packet.commandId);
        }
        if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64_000) {
          if (packet.type === 'accel.sample' || packet.type === 'device.status') { dropped++; continue; }
          throw new Error();
        }
        socket.send(JSON.stringify(packet)); forwarded++;
      }
    } catch { stop('Malformed, replayed, or undeliverable WILi packet; bridge stopped.'); }
  });
  serial.stderr.on('data', () => stop('WILi serial worker failed. Check port access, cable, and DTR support.'));
  serial.on('error', () => stop('Could not start the existing Python runtime for serial transport.'));
  serial.stdin.on('error', () => stop('WILi serial input closed.'));
  serial.once('close', () => stop(stopped ? undefined : 'WILi serial connection ended.'));
  helloTimer = setTimeout(() => stop('No compatible device.hello in five seconds. This bridge does not support stock firmware implicitly.'), 5000);
  console.log('Foreground WILi bridge: keep the cable connected; Ctrl-C stops it. No flashing or pairing preferences are changed.');
  await finished; await childExit;
  if (killTimer) clearTimeout(killTimer);
  process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
  console.log(`Bridge stopped: ${forwarded} forwarded packets, ${dropped} dropped while unavailable. No delivery acknowledgement is implied.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log('Offline: node native/freewili/bridge.ts --check <local.ndjson>\nHardware: node native/freewili/bridge.ts --port /dev/cu.usbmodem... --token-file <private file> [--backend http://127.0.0.1:8877] [--python /usr/bin/python3]');
    return;
  }
  if (args.length === 2 && args[0] === '--check') { console.log(JSON.stringify(await checkWiliFile(args[1]))); return; }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--port', '--token-file', '--backend', '--python'].includes(args[index]) || !args[index + 1] || values.has(args[index]))
      throw new Error('Invalid bridge arguments; use --help.');
    values.set(args[index], args[index + 1]);
  }
  if (!values.has('--port') || !values.has('--token-file')) throw new Error('An explicit serial port and private token file are required.');
  await runWiliBridge({ port: values.get('--port')!, tokenFile: values.get('--token-file')!,
    base: values.get('--backend') ?? 'http://127.0.0.1:8877', python: values.get('--python') ?? '/usr/bin/python3' });
}
if (import.meta.main) main().catch(() => { console.error('WILi bridge failed; check arguments/files and use --help. No device recovery or firmware changes were attempted.'); process.exitCode = 1; });
