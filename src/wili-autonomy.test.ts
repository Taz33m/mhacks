import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Snapshot } from './contracts.ts';
import type { WiliHostPacket, WiliIncidentContext } from '../native/freewili/protocol.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Generated protocol streams exercise the autonomous server path. This is not
// mounted-device accuracy, microphone recognition, or live Photon validation.
test('paired stock acceleration and waist motion open check-in without an operator trigger', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-paired-autonomy-'));
  const child = spawn(process.execPath, ['--import', './src/test-helpers/offline.ts', './src/server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_LEGACY_PHONE: '0', LIFELINE_DEMO_MODE: '0', LIFELINE_CHECKIN_MS: '20000',
      SPECTRUM_PROJECT_ID: '', SPECTRUM_PROJECT_SECRET: '', ELEVENLABS_API_KEY: '',
      LIFELINE_LLM_API_KEY: '', LIFELINE_LLM_BASE_URL: '', LIFELINE_LLM_MODEL: '', LIFELINE_WEARER_PHONE: '',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Maya', phone: null }]) },
  });
  const exited = once(child, 'exit');
  const sockets: WebSocket[] = [], intervals: ReturnType<typeof setInterval>[] = [];
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Isolated paired server did not start.')), 5000);
      child.stdout.on('data', bytes => {
        output += bytes.toString(); const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated paired server exited before ready.')); });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await (await fetch(`${base}/api/setup`)).json() as { token: string };
    const state = async () => await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) })).json() as Snapshot;
    async function waitFor(matches: (s: Snapshot) => boolean, timeout = 6500): Promise<Snapshot> {
      const end = Date.now() + timeout;
      do { const value = await state(); if (matches(value)) return value; await pause(25); } while (Date.now() < end);
      throw new Error('Generated paired stream did not reach the expected state.');
    }
    const bodySession = 'generated-paired-stock', waistSession = 'generated-paired-waist';
    const contexts: WiliIncidentContext[] = [];
    let bodySequence = 0, waistSequence = 0, waistMovingUntil = -Infinity;
    const body = new WebSocket(`ws://127.0.0.1:${port}/motion?source=body-wili&token=${setup.token}`);
    const waist = new WebSocket(`ws://127.0.0.1:${port}/motion?source=waist-airpod&token=${setup.token}`);
    sockets.push(body, waist);
    for (const [socket, sessionId] of [[body, bodySession], [waist, waistSession]] as const) {
      socket.on('error', () => {});
      socket.on('message', bytes => {
        const packet = JSON.parse(bytes.toString()) as WiliHostPacket;
        if (packet.type === 'clock.ping') socket.send(JSON.stringify({ type: 'clock.pong', id: packet.id, sessionId,
          deviceReceivedMs: performance.now(), deviceSentMs: performance.now() }));
        else if (socket === body && packet.type === 'incident.context') contexts.push(packet);
      });
    }
    await Promise.all(sockets.map(socket => once(socket, 'open')));
    body.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId: bodySession,
      deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
      capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }));
    const sendBody = (g = 1) => {
      if (body.readyState !== WebSocket.OPEN) return;
      body.send(JSON.stringify({ type: 'accel.sample', source: 'body-wili', sessionId: bodySession,
        sequence: bodySequence++, sensorTime: performance.now() / 1000, captureClock: 'host-receipt',
        accelerationG: [0, 0, g], frameTimestamp: String(1000000000000n + BigInt(bodySequence)),
        fullScaleG: 2, fresh: true, saturated: false, quality: 'measured' }));
    };
    const sendWaist = () => {
      if (waist.readyState !== WebSocket.OPEN) return;
      const moving = performance.now() < waistMovingUntil;
      waist.send(JSON.stringify({ type: 'motion.sample', source: 'waist-airpod', sessionId: waistSession,
        sensorLocation: 'Right', sequence: waistSequence++, sensorTime: performance.now() / 1000,
        quaternion: [0, 0, 0, 1], gravity: [0, 0, -1], userAcceleration: [moving ? .7 : 0, 0, 0],
        rotationRate: [0, moving ? 1.4 : 0, 0] }));
    };
    sendBody(); sendWaist();
    intervals.push(setInterval(() => sendBody(), 1000), setInterval(sendWaist, 20));
    const ready = await waitFor(s => s.wili?.usable === true && s.sensors.some(v => v.source === 'waist-airpod'
      && v.fresh && v.alignmentUncertaintyMs !== null));
    assert.equal(ready.incident, null);
    assert.equal(ready.sensors.find(v => v.source === 'waist-airpod')?.calibrated, false,
      'the current combined acceleration detector does not need standing tilt calibration');
    waistMovingUntil = performance.now() + 250;
    sendWaist(); sendBody(1.75);
    const confirming = (await waitFor(s => s.incident?.phase === 'CONFIRMING')).incident!;
    assert.equal(confirming.evidence.kind, 'cross-body');
    assert.deepEqual(confirming.evidence.sourceSessions, { 'body-wili': bodySession, 'waist-airpod': waistSession });
    assert.equal(confirming.evidence.assessment?.detector, 'wili-waist-provisional-v1');
    assert.equal(confirming.evidence.assessment?.impact.captureClock, 'host-receipt');
    assert.equal(confirming.evidence.assessment?.impact.totalG, 1.75);
    assert.ok((confirming.evidence.assessment?.quietWaist.durationMs ?? 0) >= 2200);
    await waitFor(() => contexts.some(c => c.incidentId === confirming.id && c.phase === 'CONFIRMING'
      && c.voiceAsset === 'CHECKIN' && /CHECKING ON YOU/.test(c.statusText ?? '')));
    const transcript = "My ankle hurts and I can't stand up.";
    body.send(JSON.stringify({ type: 'checkin.reply', source: 'body-wili', sessionId: bodySession,
      eventId: 'generated-paired-help', incidentId: confirming.id, checkinId: confirming.checkinId, transcript }));
    const requested = await waitFor(s => s.incident?.phase === 'HELP_REQUESTED');
    assert.equal(requested.incident!.id, confirming.id);
    assert.equal(requested.incident!.checkinDeadline, confirming.checkinDeadline);
    assert.ok(requested.serverTime < confirming.checkinDeadline);
    assert.equal(requested.conversation?.some(m => m.text === transcript && m.source === 'freewili-local-speech'), true);
    assert.equal(requested.timeline.some(e => e.type === 'DEVICE_BUTTON' || e.actor === 'development-operator'), false);
    await waitFor(() => contexts.some(c => c.incidentId === confirming.id && c.phase === 'HELP_REQUESTED'
      && /GETTING HELP/.test(c.statusText ?? '')));
  } finally {
    intervals.forEach(clearInterval); sockets.forEach(socket => socket.terminate());
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
