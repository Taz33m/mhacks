import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

// Foreground development transport. Uses the existing paired CoreDevice tunnel;
// it does not install an app, create a tunnel, change pairing, or restart itself.
const PORT = 8877;
const BUNDLE = 'org.lifeline.chestphone';
const HTTP_ROUTES = new Set(['GET /health', 'GET /api/checkin', 'GET /api/state',
  'GET /api/audio/checkin', 'POST /api/checkin/reply', 'POST /api/commands']);
const children = new Set<ChildProcess>();
const sockets = new Set<Duplex>();
const requests = new Set<ClientRequest>();
const abort = new AbortController();
let server: ReturnType<typeof createServer> | null = null;
let temporary: string | null = null;
let stopping = false;

function cleanup(code = 0): void {
  if (stopping) return;
  stopping = true; process.exitCode = code; abort.abort();
  for (const child of children) child.kill('SIGKILL');
  for (const req of requests) req.destroy();
  for (const socket of sockets) socket.destroy();
  server?.close(() => {});
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
function track(socket: Duplex): void {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function prefix64(address: string): string | null {
  const value = address.split('%')[0].toLowerCase();
  if (isIP(value) !== 6 || value.includes('.')) return null;
  const [left, right] = value.split('::');
  const head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
  const words = right !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  return words.slice(0, 4).map(word => Number.parseInt(word, 16).toString(16).padStart(4, '0')).join(':');
}
async function coreDevice(args: string[], output: string, failure: string): Promise<unknown> {
  if (stopping) throw new Error('Stopped.');
  const child = spawn('/usr/bin/xcrun', ['devicectl', ...args, '--timeout', '15', '--json-output', output], { stdio: 'ignore' });
  children.add(child);
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Could not run xcrun/devicectl. Select the installed Xcode toolchain.')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error(failure)));
    });
  } finally { clearTimeout(timer); children.delete(child); }
  if (stopping) throw new Error('Stopped.');
  chmodSync(output, 0o600);
  if (readFileSync(output).length > 2_000_000) throw new Error('Unexpectedly large CoreDevice result.');
  try { return JSON.parse(readFileSync(output, 'utf8')); }
  catch { throw new Error('CoreDevice returned unreadable JSON.'); }
}
function pathOf(req: IncomingMessage): URL | null {
  try { return new URL(req.url ?? '/', 'http://usb.invalid'); } catch { return null; }
}
function deny(socket: Duplex, code: number): void {
  socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function upstream(req: IncomingMessage, path: URL, host: string, upstreamPort: number): ClientRequest {
  // Never let a phone-supplied Host appear local to the loopback backend.
  const headers = { ...req.headers, host };
  const outgoing = request({ hostname: '127.0.0.1', port: upstreamPort, method: req.method,
    path: path.pathname + path.search, headers });
  requests.add(outgoing); outgoing.once('close', () => requests.delete(outgoing));
  outgoing.on('socket', track);
  return outgoing;
}
function proxyHttp(req: IncomingMessage, res: ServerResponse, host: string, upstreamPort: number): void {
  const path = pathOf(req);
  if (!path) { res.writeHead(400).end(); return; }
  if (path.pathname.startsWith('/api/setup')) { res.writeHead(403).end(); return; }
  if (!HTTP_ROUTES.has(`${req.method} ${path.pathname}`)) { res.writeHead(404).end(); return; }
  const outgoing = upstream(req, path, host, upstreamPort);
  outgoing.on('response', response => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.on('error', () => res.destroy()); response.pipe(res);
  });
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
  outgoing.setTimeout(10_000, () => outgoing.destroy());
  req.on('aborted', () => outgoing.destroy());
  res.on('close', () => outgoing.destroy());
  req.pipe(outgoing);
}
function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, host: string, upstreamPort: number): void {
  const path = pathOf(req);
  if (!path || req.method !== 'GET' || path.pathname !== '/motion') { deny(socket, 403); return; }
  const outgoing = upstream(req, path, host, upstreamPort);
  let opened = false;
  outgoing.setTimeout(5000, () => outgoing.destroy());
  outgoing.on('upgrade', (response, remote, remoteHead) => {
    if (stopping || socket.destroyed) { remote.destroy(); return; }
    opened = true; track(remote); remote.setTimeout(0);
    const headers = response.rawHeaders;
    let handshake = `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}\r\n`;
    for (let i = 0; i < headers.length; i += 2) handshake += `${headers[i]}: ${headers[i + 1]}\r\n`;
    socket.write(handshake + '\r\n');
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    socket.once('close', () => remote.destroy()); remote.once('close', () => socket.destroy());
    socket.pipe(remote); remote.pipe(socket);
  });
  outgoing.on('response', response => { response.resume(); deny(socket, response.statusCode ?? 502); });
  outgoing.on('error', () => { if (!opened && !socket.destroyed) deny(socket, 502); });
  socket.once('close', () => { if (!opened) outgoing.destroy(); });
  outgoing.end();
}

/** host is the forced HTTP Host header, normally [discovered-IPv6]:8877. */
export function createUsbRelay(host: string, upstreamPort = PORT): ReturnType<typeof createServer> {
  const relay = createServer((req, res) => proxyHttp(req, res, host, upstreamPort));
  relay.on('connection', track);
  relay.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, host, upstreamPort));
  relay.on('connect', (_req, socket) => deny(socket, 403));
  relay.on('clientError', (_error, socket) => deny(socket, 400));
  return relay;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: npm run device:usb -- DEVICE_UDID\nRequires the backend on localhost:8877, an installed paired DEBUG app, and an unlocked/trusted USB iPhone with a connected CoreDevice tunnel.\nRuns in the foreground until Ctrl-C; saved Wi-Fi pairing remains unchanged.');
    return;
  }
  if (args.length !== 1 || !/^[a-fA-F0-9-]{8,80}$/.test(args[0])) throw new Error('Provide the physical device UDID: npm run device:usb -- DEVICE_UDID');
  if (process.platform !== 'darwin') throw new Error('This development helper requires macOS and Xcode.');
  const response = await fetch(`http://127.0.0.1:${PORT}/health`, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]), redirect: 'error' });
  const health = record(await response.json());
  if (!response.ok || health.status !== 'ok' || !Array.isArray(health.motionSources)) throw new Error('Start the LIFELINE backend on localhost:8877 first.');
  temporary = mkdtempSync(join(tmpdir(), 'lifeline-usb-')); chmodSync(temporary, 0o700);
  const details = record(record(await coreDevice(['device', 'info', 'details', '--device', args[0]],
    join(temporary, 'device.json'), 'CoreDevice discovery failed. Unlock and trust the USB-connected iPhone.')).result);
  const properties = record(details.properties), modern = record(properties.connection), legacy = record(details.connectionProperties);
  const hardware = record(properties.hardware), legacyHardware = record(details.hardwareProperties);
  const udid = hardware.udid ?? legacyHardware.udid;
  if (typeof udid !== 'string' || udid.toLowerCase() !== args[0].toLowerCase()) throw new Error('CoreDevice did not return the requested physical UDID.');
  const state = modern.state ?? legacy.tunnelState, transport = modern.transportType ?? legacy.transportType;
  const peer = modern.tunnelIPAddressString ?? legacy.tunnelIPAddress;
  if (state !== 'connected' || transport !== 'wired' || typeof peer !== 'string' || !prefix64(peer))
    throw new Error('A connected wired CoreDevice tunnel is required. This helper does not create one.');
  const matches = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    /^utun\d+$/.test(name) ? (addresses ?? []).filter(a => a.family === 'IPv6' && !a.internal
      && prefix64(a.address) === prefix64(peer) && a.address.split('%')[0] !== peer.split('%')[0])
      .map(a => ({ name, address: a.address })) : []);
  if (matches.length !== 1) throw new Error('Could not uniquely match the Mac utun IPv6 address to the device tunnel /64.');
  const selected = matches[0], host = `[${selected.address}]:${PORT}`;
  server = createUsbRelay(host);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen({ host: selected.address, port: PORT, ipv6Only: true }, () => { server!.removeListener('error', reject); resolve(); });
  });
  server.on('error', () => { console.error('USB relay listener failed. Check the cable/tunnel and restart this helper.'); cleanup(1); });
  if (stopping) return;
  console.log(`USB development relay bound only to ${selected.name}, port ${PORT}. Local setup access is blocked.`);
  console.log('Launching the already-installed DEBUG app. Saved Wi-Fi host and pairing remain unchanged.');
  await coreDevice(['device', 'process', 'launch', '--device', args[0], '--terminate-existing',
    '--environment-variables', JSON.stringify({ LIFELINE_RELAY_HOST: selected.address, LIFELINE_START_MONITORING: '1' }), BUNDLE],
  join(temporary, 'launch.json'), 'App launch failed. Install the signed DEBUG app first and keep the phone unlocked.');
  console.log('Keep the USB cable connected and this foreground command running. Ctrl-C closes the relay; stop monitoring on the phone afterward.');
  rmSync(temporary, { recursive: true, force: true }); temporary = null;
}
if (import.meta.main) {
  process.once('SIGINT', () => cleanup());
  process.once('SIGTERM', () => cleanup());
  void main().catch(error => {
    if (stopping) return;
    // Do not print child output, request paths, headers, or raw network errors.
    const message = error instanceof Error && !('cause' in error) ? error.message : 'Backend/network access failed. Check localhost:8877 and the USB tunnel.';
    console.error(`USB helper stopped: ${message}`); cleanup(1);
  });
}
