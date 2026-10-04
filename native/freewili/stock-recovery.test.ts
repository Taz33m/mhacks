import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { StockBridgeFailure, backendTransportFailure, backendCloseFailure, backendHttpFailure,
  selectedPortFailure, superviseStockBridge } from './stock-recovery.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Recovery fixture did not reach expected state.'); await pause(15); }
}

test('only explicit USB/network availability failures are recoverable; auth/protocol/config remain fatal', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']) assert.equal(backendTransportFailure({ code }).recoverable, true);
  for (const code of ['ENOTFOUND', 'CERT_HAS_EXPIRED', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH']) assert.equal(backendTransportFailure({ code }).recoverable, false);
  for (const status of [401, 403, 404]) assert.equal(backendHttpFailure(status).recoverable, false);
  for (const code of [1002, 1007, 1008, 1009]) assert.equal(backendCloseFailure(code).recoverable, false);
  assert.equal(backendHttpFailure(503).recoverable, true); assert.equal(backendCloseFailure(1001).recoverable, true);
  assert.equal(selectedPortFailure({ code: 'ENOENT' }).recoverable, true);
  assert.equal(selectedPortFailure({ code: 'EACCES' }).recoverable, false);
});

test('bounded supervisor cancels retry wait, stops fatal/clean attempts, and expires stalled recovery', async () => {
  const abort = new AbortController(); let attempts = 0;
  await superviseStockBridge({ signal: abort.signal, attempt: async () => { attempts++; throw selectedPortFailure({ code: 'ENOENT' }); },
    onRetry: () => abort.abort() }); assert.equal(attempts, 1);
  const fatal = new StockBridgeFailure('protocol', 'Generated malformed fixture.');
  await assert.rejects(superviseStockBridge({ signal: new AbortController().signal, attempt: async () => { throw fatal; } }), error => error === fatal);
  attempts = 0; await superviseStockBridge({ signal: new AbortController().signal, attempt: async () => { attempts++; } }); assert.equal(attempts, 1);
  let active = false, cleanupComplete = false;
  await assert.rejects(superviseStockBridge({ signal: new AbortController().signal, recoveryWindowMs: 50, stableMs: 10,
    baseDelayMs: 5, maxDelayMs: 10, attempt: async signal => {
      if (!active) { active = true; throw selectedPortFailure({ code: 'ENOENT' }); }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await pause(10); cleanupComplete = true;
    } }), error => error instanceof StockBridgeFailure && error.kind === 'recovery-exhausted');
  assert.equal(cleanupComplete, true, 'deadline waits for cooperative attempt cleanup before failing');
});

test('supervisor retries only after an actual child is reaped and active cancellation does not relaunch', async () => {
  const abort = new AbortController(), events: string[] = []; let attempts = 0, workers = 0, maximum = 0;
  await superviseStockBridge({ signal: abort.signal, baseDelayMs: 5, maxDelayMs: 10, recoveryWindowMs: 1000, stableMs: 30,
    attempt: async signal => {
      const index = ++attempts, child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      workers++; maximum = Math.max(maximum, workers); events.push(`start:${index}`);
      const closed = once(child, 'close');
      const cancel = () => child.kill('SIGTERM'); signal.addEventListener('abort', cancel, { once: true });
      if (index === 1) child.kill('SIGTERM'); else setTimeout(() => abort.abort(), 20);
      await closed; signal.removeEventListener('abort', cancel); workers--; events.push(`closed:${index}`);
      if (index === 1) throw new StockBridgeFailure('backend-transport', 'Generated transport closure.', true);
    } });
  assert.equal(maximum, 1); assert.equal(workers, 0); assert.equal(attempts, 2);
  assert.deepEqual(events, ['start:1', 'closed:1', 'start:2', 'closed:2']);
});

// The actual CLI runs in a subprocess with an isolated fs/spawn preload. The
// selected /dev path is virtual in that subprocess only; no serial port is opened.
// Its child emits generated protocol fixtures, never measured physical readings.
function createFixture(readyDelay = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-stock-recovery-'));
  const lifecycle = join(dir, 'lifecycle.jsonl'), commands = join(dir, 'commands.jsonl');
  const worker = join(dir, 'worker.mjs'), preload = join(dir, 'preload.mjs'), missing = join(dir, 'missing');
  const token = join(dir, 'token'); writeFileSync(token, 'isolated-recovery-token-123456', { mode: 0o600 });
  writeFileSync(worker, `import {appendFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto'; import {createInterface} from 'node:readline';
const lifecycle=${JSON.stringify(lifecycle)}, commands=${JSON.stringify(commands)}, sessionId=randomUUID();
const log=kind=>appendFileSync(lifecycle,JSON.stringify({kind,pid:process.pid,sessionId})+'\\n');
const emit=p=>process.stdout.write(JSON.stringify(p)+'\\n'); let sequence=0,stopping=false;
log('start'); emit({type:'device.hello',protocolVersion:1,source:'body-wili',sessionId,deviceModel:'freewili-og',fullScaleG:2,transport:'stock-sdk',capabilities:{accelerometer:true,speaker:true,microphone:true,buttons:true}});
let timer;const ready=()=>{if(stopping)return;log('ready');emit({type:'stock.status',status:'ready'});timer=setInterval(()=>emit({type:'accel.sample',source:'body-wili',sessionId,sequence:sequence++,sensorTime:performance.now()/1000,captureClock:'host-receipt',frameTimestamp:String(1000000+sequence),accelerationG:[0,0,1],fullScaleG:2,fresh:true,saturated:false,quality:'measured'}),30)};
const readyTimer=setTimeout(ready,${readyDelay});
const stop=()=>{if(stopping)return;stopping=true;clearTimeout(readyTimer);clearInterval(timer);log('stopping');setTimeout(()=>{log('exit');process.exit(0)},700)};
process.on('SIGTERM',stop);process.on('SIGINT',stop);const input=createInterface({input:process.stdin});input.on('close',stop);
input.on('line',line=>{const p=JSON.parse(line);appendFileSync(commands,JSON.stringify(p)+'\\n');if(p.type==='clock.ping')emit({type:'clock.pong',id:p.id,sessionId,deviceReceivedMs:performance.now(),deviceSentMs:performance.now()})});`, { mode: 0o600 });
  writeFileSync(preload, `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const stat=fs.statSync,spawn=cp.spawn;fs.statSync=function(path,...args){if(String(path)==='/dev/cu.lifeline-recovery-fixture'){if(fs.existsSync(${JSON.stringify(missing)}))throw Object.assign(new Error('generated unavailable'),{code:'ENOENT'});return {isCharacterDevice:()=>true}}return stat.call(this,path,...args)};
cp.spawn=function(command,args,options){if(args?.[0]?.endsWith('/stock_io.py'))return spawn.call(this,process.execPath,[${JSON.stringify(worker)}],options);return spawn.call(this,command,args,options)};syncBuiltinESMExports();`, { mode: 0o600 });
  const lines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as { kind: string; sessionId: string; type?: string; incidentId?: string; id?: string }[] : [];
  return { dir, preload, token, missing, lifecycle, commands, lines };
}

async function cliFixture(kind: 'recover' | 'backend' | 'auth' | 'protocol' | 'setup') {
  const f = createFixture(kind === 'setup' ? 500 : 0), server = createServer(), backend = new WebSocketServer({ noServer: true }), sockets: WebSocket[] = [];
  const received: { sessionId: string; type: string; id?: string }[] = [];
  server.on('upgrade', (req, socket, head) => {
    if (kind === 'auth') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    backend.handleUpgrade(req, socket, head, ws => {
      sockets.push(ws); ws.on('message', bytes => {
        const p = JSON.parse(bytes.toString()); received.push(p);
        if (p.type === 'device.hello') {
          if (kind === 'protocol') ws.close(1008, 'Generated rejected session.');
          else ws.send(JSON.stringify({ type: 'incident.context', sessionId: p.sessionId, incidentId: 'expired-fixture',
            checkinId: 'expired-checkin', phase: 'CONFIRMING', checkinDeadline: Date.now() - 1000, serverTime: Date.now(), voiceAsset: 'CHECKIN' }));
          if (kind === 'setup') for (let i=0;i<80;i++) ws.send(JSON.stringify({ type:'clock.ping',id:`setup-${i}`,serverSentMs:Date.now() }));
        }
      });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, ['--import', f.preload, 'native/freewili/stock-bridge.ts', '--reconnect',
    '--port', '/dev/cu.lifeline-recovery-fixture', '--backend', `http://127.0.0.1:${port}`, '--token-file', f.token,
    '--audio-dir', f.dir, '--python', process.execPath, '--no-ui'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); let output = '';
  child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    if (kind === 'setup') {
      await waitFor(() => received.some(p => p.type === 'accel.sample'));
      sockets[0].send(JSON.stringify({type:'clock.ping',id:'after-ready',serverSentMs:Date.now()}));
      await waitFor(() => received.some(p => p.type === 'clock.pong' && p.id === 'after-ready'));
      assert.deepEqual(f.lines(f.commands).filter(p => p.type === 'clock.ping').map(p => p.id),['after-ready']);
      child.kill('SIGTERM');
    }
    if (kind === 'recover' || kind === 'backend') {
      await waitFor(() => received.some(p => p.type === 'accel.sample'));
      if (kind === 'recover') {
        writeFileSync(f.missing, 'generated USB absence');
        await waitFor(() => f.lines(f.lifecycle).some(e => e.kind === 'stopping'));
        unlinkSync(f.missing); // Port returns before the first worker close: failure must remain recoverable.
      } else sockets[0].close(1001, 'Generated backend restart.');
      await waitFor(() => new Set(received.filter(p => p.type === 'accel.sample').map(p => p.sessionId)).size === 2);
      child.kill('SIGTERM');
    }
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let code: unknown;
    try { [code] = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('Foreground fixture failed to stop.')), 5000);
    })]); } finally { if (watchdog) clearTimeout(watchdog); }
    const lifecycle = f.lines(f.lifecycle), starts = lifecycle.filter(e => e.kind === 'start'), exits = lifecycle.filter(e => e.kind === 'exit');
    assert.equal(starts.length, ['recover', 'backend'].includes(kind) ? 2 : 1); assert.equal(exits.length, starts.length);
    for (let i = 1; i < starts.length; i++) assert.ok(lifecycle.indexOf(exits[i - 1]) < lifecycle.indexOf(starts[i]), 'old worker must exit before new worker starts');
    if (kind === 'recover' || kind === 'backend') {
      assert.equal(code, 0); assert.notEqual(starts[0].sessionId, starts[1].sessionId);
      assert.match(output, kind === 'recover' ? /unavailable \(usb-unavailable\)/ : /unavailable \(backend-transport\)/);
      assert.equal(f.lines(f.commands).some(p => p.type === 'incident.context' && p.incidentId === 'expired-fixture'), false,
        'reconnection cannot replay an expired check-in');
    } else if (kind === 'setup') assert.equal(code, 0);
    else { assert.equal(code, 1); assert.doesNotMatch(output, /retry 1/); }
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
    sockets.forEach(s => s.terminate()); backend.close(); server.close(); await once(server, 'close');
    rmSync(f.dir, { recursive: true, force: true });
  }
}
test('actual foreground CLI recovers confirmed port disappearance with one reaped worker/fresh session, then stops on SIGTERM', { timeout: 10_000 }, async () => cliFixture('recover'));
test('actual foreground CLI recovers backend transport closure with fresh session and no expired context replay', { timeout: 10_000 }, async () => cliFixture('backend'));
test('actual foreground CLI treats HTTP authentication rejection as fatal without relaunch', { timeout: 10_000 }, async () => cliFixture('auth'));
test('actual foreground CLI treats protocol/policy close as fatal without relaunch', { timeout: 10_000 }, async () => cliFixture('protocol'));
test('long initial setup discards old clock pings instead of overflowing the serial worker queue', { timeout: 10_000 }, async () => cliFixture('setup'));
