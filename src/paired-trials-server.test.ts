import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { analyseRecording } from '../scripts/replay-motion.ts';
import type { Evidence, Snapshot, TrialRecord, TrialView } from './contracts.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Actual isolated server, generated streams. No mounted-device or physical event claim.
test('isolated paired trial rejects faster pre-sample clocks and replays exact features while preserving its initial baseline', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-paired-trial-server-'));
  const child = spawn(process.execPath, ['--import', './src/test-helpers/offline.ts', './src/server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1', LIFELINE_LEGACY_PHONE: '0',
      LIFELINE_DEMO_MODE: '0', LIFELINE_CHECKIN_MS: '20000', LIFELINE_WEARER_PHONE: '',
      SPECTRUM_PROJECT_ID: '', SPECTRUM_PROJECT_SECRET: '', ELEVENLABS_API_KEY: '',
      LIFELINE_LLM_API_KEY: '', LIFELINE_LLM_BASE_URL: '', LIFELINE_LLM_MODEL: '',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Maya', phone: null }]),
    },
  });
  const exited = once(child, 'exit'), sockets: WebSocket[] = [], intervals: ReturnType<typeof setInterval>[] = [];
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Isolated trial server did not start.')), 5000);
      child.stdout.on('data', bytes => { output += bytes.toString(); const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated trial server exited before ready.')); });
    });
    const base = `http://127.0.0.1:${port}`, setup = await (await fetch(`${base}/api/setup`)).json() as { token: string };
    const state = async () => await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) })).json() as Snapshot;
    const post = async (path: string, body: unknown) => await fetch(`${base}${path}`, { method: 'POST',
      headers: { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    async function waitFor(matches: (s: Snapshot) => boolean, timeout = 6500): Promise<Snapshot> {
      const end = Date.now() + timeout;
      do { const value = await state(); if (matches(value)) return value; await pause(25); } while (Date.now() < end);
      throw new Error('Isolated generated trial did not reach the expected state.');
    }
    const bodySession = 'generated-recorded-stock', waistSession = 'generated-recorded-waist';
    let bodySequence = 0, waistSequence = 0, movingUntil = -Infinity;
    let clockStage: 'ordinary' | 'before-samples' | 'after-samples' = 'ordinary';
    const bootstrapPings = new Map<string, string>();
    const board = new WebSocket(`ws://127.0.0.1:${port}/motion?source=body-wili&token=${setup.token}`);
    const waist = new WebSocket(`ws://127.0.0.1:${port}/motion?source=waist-airpod&token=${setup.token}`);
    sockets.push(board, waist);
    for (const [socket, sessionId, source] of [[board, bodySession, 'body-wili'], [waist, waistSession, 'waist-airpod']] as const) {
      socket.on('error', () => {});
      socket.on('message', bytes => {
        const p = JSON.parse(bytes.toString());
        if (p.type === 'clock.ping') {
          const reply = () => {
            if (socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({ type: 'clock.pong', id: p.id, sessionId,
              deviceReceivedMs: performance.now(), deviceSentMs: performance.now() }));
          };
          // Retained-session bootstrap replies are immediate; post-sample replies take a longer return path.
          if (clockStage === 'before-samples') { reply(); bootstrapPings.set(source, p.id); }
          else if (clockStage === 'after-samples') setTimeout(reply, 100);
          else reply();
        }
      });
    }
    await Promise.all(sockets.map(socket => once(socket, 'open')));
    board.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId: bodySession,
      deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
      capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }));
    function sendBody(g = 1) {
      if (board.readyState !== WebSocket.OPEN) return;
      board.send(JSON.stringify({ type: 'accel.sample', source: 'body-wili', sessionId: bodySession, sequence: bodySequence++,
        sensorTime: performance.now() / 1000, captureClock: 'host-receipt', accelerationG: [0, 0, g],
        frameTimestamp: String(1015894500660534528n + BigInt(bodySequence)), fullScaleG: 2, fresh: true, saturated: false, quality: 'measured' }));
    }
    function sendWaist() {
      if (waist.readyState !== WebSocket.OPEN) return;
      const moving = performance.now() < movingUntil;
      waist.send(JSON.stringify({ type: 'motion.sample', source: 'waist-airpod', sessionId: waistSession,
        sensorLocation: 'Right', sequence: waistSequence++, sensorTime: performance.now() / 1000,
        quaternion: [0, 0, 0, 1], gravity: [0, 0, -1], userAcceleration: [moving ? .7 : 0, 0, 0],
        rotationRate: [0, moving ? 1.4 : 0, 0] }));
    }
    sendBody(); sendWaist(); intervals.push(setInterval(() => sendBody(), 1000), setInterval(sendWaist, 20));
    await pause(1300);
    const calibrated = await post('/api/commands', { type: 'calibrate', expectedSessionId: waistSession, expectedSensorLocation: 'Right' });
    assert.equal(calibrated.status, 200); assert.deepEqual(await calibrated.json(), { ok: true, calibratedSources: ['waist-airpod'] });
    assert.equal((await state()).sensors.find(s => s.source === 'waist-airpod')!.calibrated, true);
    intervals.splice(0).forEach(clearInterval);
    const start = await post('/api/trials/start', { label: 'Generated paired server fixture', scenario: 'other' });
    assert.equal(start.status, 200); const trial = await start.json() as TrialView;
    assert.equal(trial.captureMode, 'wili-waist');
    assert.equal((await state()).sensors.find(s => s.source === 'waist-airpod')!.calibrated, true, 'paired start preserves fresh same-session standing baseline');
    clockStage = 'before-samples';
    await waitFor(() => bootstrapPings.size === 2);
    await pause(50);
    const bootstrapState = await state();
    assert.equal(bootstrapState.trial!.sampleCounts['body-wili'], 0);
    assert.equal(bootstrapState.trial!.sampleCounts['waist-airpod'], 0);
    assert.equal(bootstrapState.wili!.alignmentUncertaintyMs, null, 'pre-sample board pong must not establish an unreplayable clock');
    assert.equal(bootstrapState.sensors.find(s => s.source === 'waist-airpod')!.alignmentUncertaintyMs, null,
      'pre-sample waist pong must not establish an unreplayable clock');
    clockStage = 'after-samples'; sendBody(); sendWaist();
    intervals.push(setInterval(() => sendBody(), 1000), setInterval(sendWaist, 20));
    assert.equal((await fetch(`${base}/api/trials/marker`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await post('/api/trials/marker', { label: 'line\nbreak' })).status, 400);
    assert.equal((await post('/api/trials/marker', { label: 'Generated impact begins' })).status, 200);
    const ready = await waitFor(s => s.wili?.usable === true && s.trial!.sampleCounts['body-wili'] > 0
      && s.sensors.some(v => v.source === 'waist-airpod' && v.fresh && v.alignmentUncertaintyMs !== null));
    assert.equal(ready.incident, null);
    movingUntil = performance.now() + 250; sendWaist(); sendBody(1.75);
    const confirming = await waitFor(s => s.incident?.phase === 'CONFIRMING');
    assert.equal(confirming.incident!.evidence.kind, 'cross-body');
    assert.equal(confirming.incident!.evidence.assessment!.impact.captureClock, 'host-receipt');
    assert.equal((await post('/api/trials/marker', { label: 'Autonomous check-in observed in generated fixture' })).status, 200);
    await pause(180); assert.equal((await post('/api/trials/stop', {})).status, 200);
    await waitFor(s => s.trial?.status === 'stopped');
    const response = await fetch(`${base}/api/trials/${trial.id}/download`, { headers: { Authorization: `Bearer ${setup.token}` } });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as TrialRecord);
    for (const type of ['trial.start', 'device.hello', 'accel.sample', 'motion.sample', 'clock.ping', 'clock.pong', 'trial.marker', 'assessment', 'trial.stop'])
      assert.ok(events.some(r => r.type === type), `missing ${type}`);
    const recordedCandidate = events.find(r => r.type === 'assessment' && (r.payload as { candidate?: EvidenceLike }).candidate)!;
    assert.ok(recordedCandidate); assert.equal((recordedCandidate.payload as { candidate: EvidenceLike }).candidate.assessment.assessedAtMs, recordedCandidate.atMs);
    for (const [source, pingId] of bootstrapPings) {
      assert.ok(events.some(e => e.type === 'clock.ping' && e.source === source && (e.payload as { id: string }).id === pingId));
      assert.ok(!events.some(e => e.type === 'clock.pong' && (e.payload as { id: string }).id === pingId),
        'the faster pre-sample pong was rejected before mutating or recording alignment');
    }
    for (const source of ['body-wili', 'waist-airpod']) {
      const pong = events.find(e => e.type === 'clock.pong' && e.source === source)!;
      assert.ok(pong, 'post-sample alignment is actually recorded');
      const ping = events.find(e => e.type === 'clock.ping' && (e.payload as { id: string }).id === (pong.payload as { id: string }).id)!;
      assert.ok(pong.atMs - ping.atMs >= 90, 'the accepted exchange has the deliberately longer return path');
    }
    const result = analyseRecording(join(dir, 'trials', `trial-${trial.id}.jsonl`)); assert.equal(result.format, 'trial-events-v2');
    assert.ok('trials' in result);
    const replay = result.trials[0] as { status: string; candidates: { evidence: Evidence }[]; discrepancyCount: number;
      preservedCalibration: { sessionId: string }[]; skippedActiveIncidentAssessments: number; markers: unknown[] };
    assert.equal(replay.status, 'replayed'); assert.equal(replay.candidates.length, 1);
    assert.equal(replay.discrepancyCount, 0, 'recorded server features must reconstruct exactly offline');
    assert.deepEqual(replay.candidates[0].evidence, (recordedCandidate.payload as { candidate: Evidence }).candidate);
    assert.equal(replay.preservedCalibration[0].sessionId, waistSession);
    assert.ok(replay.skippedActiveIncidentAssessments > 0); assert.equal(replay.markers.length, 2);
  } finally {
    intervals.forEach(clearInterval); sockets.forEach(socket => socket.terminate());
    if (child.exitCode === null) child.kill('SIGTERM'); await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
type EvidenceLike = { assessment: { assessedAtMs: number } };
