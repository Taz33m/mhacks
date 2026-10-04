import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { get, request } from 'node:http';
import { WebSocket } from 'ws';
import type { Snapshot, Source } from './contracts.ts';

test('isolated HTTP/WS server accepts native packets, authenticates commands, and completes one incident', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-server-'));
  const child = spawn(process.execPath, ['--import', './src/test-helpers/offline.ts', './src/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_DEMO_MODE: '0', LIFELINE_LEGACY_PHONE: '1', LIFELINE_CHECKIN_MS: '1000', SPECTRUM_PROJECT_ID: '', SPECTRUM_PROJECT_SECRET: '', ELEVENLABS_API_KEY: '', LIFELINE_LLM_API_KEY: '',
      LIFELINE_WEARER_PHONE: '+12675550123',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Maya', phone: null }, { id: 'jordan', name: 'Jordan', phone: null }]) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const sockets: WebSocket[] = []; const intervals: ReturnType<typeof setInterval>[] = [];
  const exit = once(child, 'exit');
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server did not start.')), 5000);
      child.stdout.on('data', chunk => {
        const match = String(chunk).match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.on('error', reject); child.on('exit', () => { clearTimeout(timer); reject(new Error('Server stopped before ready.')); });
    });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/commands`, { method: 'POST', body: '{}' })).status, 401);
    const blockedHostStatus = await new Promise<number>((resolve, reject) => {
      get(`${base}/api/setup`, { headers: { Host: 'untrusted.example' } }, response => {
        response.resume(); resolve(response.statusCode!);
      }).on('error', reject);
    });
    assert.equal(blockedHostStatus, 403);
    const setup = await (await fetch(`${base}/api/setup`)).json() as { token: string; port: number; lanEnabled: boolean };
    assert.equal(setup.port, port);
    assert.equal(setup.lanEnabled, false);
    const commands = async (body: unknown) => fetch(`${base}/api/commands`, { method: 'POST', headers: { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const state = async () => await (await fetch(`${base}/api/state`)).json() as Snapshot;
    const preview = async (incidentId: string, question: unknown) => fetch(`${base}/api/context/question`, {
      method: 'POST', headers: { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId, question }),
    });
    assert.equal((await fetch(`${base}/api/context/question`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/patient-record`)).status, 401);
    assert.equal((await fetch(`${base}/api/patient-record/question`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/patient-record/refresh`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await preview('not-created', 'What is recorded?')).status, 400);
    const trialCommand = async (action: string, body: unknown = {}) => fetch(`${base}/api/trials/${action}`, { method: 'POST',
      headers: { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/trials/start`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await trialCommand('start', { label: '', scenario: 'other' })).status, 400);
    const started = await trialCommand('start', { label: 'Isolated protocol trial — synthetic samples.', scenario: 'other' });
    assert.equal(started.status, 200); const trial = await started.json();
    assert.equal((await trialCommand('start', { label: 'duplicate', scenario: 'other' })).status, 400);
    for (const source of ['chest-phone', 'waist-airpod'] as Source[]) {
      const sessionId = randomUUID(); let sequence = 0;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/motion?source=${source}&token=${setup.token}`); sockets.push(ws);
      ws.on('message', bytes => {
        const p = JSON.parse(String(bytes)); const received = performance.now();
        if (p.type === 'clock.ping') ws.send(JSON.stringify({ type: 'clock.pong', id: p.id, sessionId, deviceReceivedMs: received, deviceSentMs: performance.now() }));
      });
      await once(ws, 'open');
      intervals.push(setInterval(() => ws.send(JSON.stringify({ type: 'motion.sample', source,
        sensorLocation: source === 'chest-phone' ? 'phone' : 'Left', sessionId, sequence: sequence++,
        sensorTime: performance.now() / 1000, quaternion: [0,0,0,1], gravity: [0,-1,0], userAcceleration: [0,0,0], rotationRate: [0,0,0] })), 20));
    }
    await new Promise(resolve => setTimeout(resolve, 2200));
    const beforeCalibration = await state();
    const waist = beforeCalibration.sensors.find(s => s.source === 'waist-airpod')!;
    assert.equal((await commands({ type: 'calibrate', expectedSessionId: 'retired-session', expectedSensorLocation: 'Left' })).status, 400);
    assert.equal((await commands({ type: 'calibrate', expectedSessionId: waist.sessionId, expectedSensorLocation: 'Right' })).status, 400);
    assert.equal((await commands({ type: 'calibrate', expectedSessionId: waist.sessionId })).status, 400);
    assert.equal((await state()).sensors.every(s => !s.calibrated), true, 'stale or incomplete guided requests cannot establish a baseline');
    const guided = await commands({ type: 'calibrate', expectedSessionId: waist.sessionId, expectedSensorLocation: 'Left' });
    assert.equal(guided.status, 200);
    assert.deepEqual(await guided.json(), { ok: true, calibratedSources: ['waist-airpod'] });
    assert.equal((await state()).sensors.find(s => s.source === 'chest-phone')!.calibrated, false,
      'guided waist calibration cannot label a different sensor calibrated');
    const legacyCalibration = await commands({ type: 'calibrate' });
    assert.equal(legacyCalibration.status, 200);
    assert.deepEqual(await legacyCalibration.json(), { ok: true, calibratedSources: ['chest-phone', 'waist-airpod'] });
    const measured = await state();
    assert.equal(measured.sensors.every(s => s.fresh && s.calibrated && s.alignmentUncertaintyMs !== null), true);
    assert.equal(measured.trial!.sampleCounts['chest-phone'] > 30, true);
    assert.equal(measured.trial!.sampleCounts['waist-airpod'] > 30, true);
    assert.equal((await commands({ type: 'trigger', kind: 'synthetic', summary: 'Isolated protocol fixture; not a physical fall.' })).status, 200);
    const confirming = (await state()).incident!;
    assert.equal((await fetch(`${base}/api/incidents/${confirming.id}/brief`)).status, 401);
    const brief = await fetch(`${base}/api/incidents/${confirming.id}/brief`, { headers: { Authorization: `Bearer ${setup.token}` } });
    assert.equal(brief.status, 200);
    assert.equal(brief.headers.get('cache-control'), 'no-store');
    const care = await brief.json();
    assert.equal(care.lifelineObservations.incident.id, confirming.id);
    assert.match(care.lifelineObservations.source, /not hospital EHR entries/);
    assert.equal(confirming.phase, 'CONFIRMING');
    const companion = await state();
    assert.equal(companion.actions.filter(a => a.type === 'wearer_checkin').length, 1);
    assert.equal(companion.actions.filter(a => a.type === 'checkin').length, 1);
    assert.equal(companion.wearerMessaging.configured, false);
    assert.match(companion.wearerMessaging.detail, /Photon credentials/);
    assert.equal(JSON.stringify(companion).includes('+12675550123'), false);
    assert.equal((await trialCommand('start', { label: 'incident active', scenario: 'other' })).status, 400);
    assert.equal((await trialCommand('stop')).status, 200);
    assert.equal((await state()).incident?.phase, 'CONFIRMING');
    await new Promise(r => setTimeout(r, 30));
    assert.equal((await fetch(`${base}/api/trials/${trial.id}/download`)).status, 401);
    const recording = await fetch(`${base}/api/trials/${trial.id}/download`, { headers: { Authorization: `Bearer ${setup.token}` } });
    assert.equal(recording.status, 200);
    const records = (await recording.text()).trim().split('\n').map(line => JSON.parse(line));
    for (const type of ['trial.start', 'motion.sample', 'clock.ping', 'clock.pong', 'calibration', 'assessment', 'trial.stop'])
      assert.equal(records.some(record => record.type === type), true, type);
    const reply = async (transcript: string, checkinId = confirming.checkinId) => fetch(`${base}/api/checkin/reply`, {
      method: 'POST', headers: { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId: confirming.id, checkinId, transcript, source: 'ios-on-device-speech' })
    });
    assert.equal((await fetch(`${base}/api/checkin/reply`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/checkin/reply`, { method: 'POST', headers: {
      Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
      incidentId: confirming.id, checkinId: confirming.checkinId, transcript: 'I need help', source: 'photon-imessage' }) })).status, 400);
    assert.equal((await reply('I need help', 'old')).status, 400);
    assert.equal((await (await reply("I'm okay")).json()).decision, 'confirmation_required');
    assert.equal((await (await reply('I am not sure')).json()).decision, 'unresolved');
    assert.equal((await state()).incident?.phase, 'CONFIRMING');
    await new Promise(resolve => setTimeout(resolve, 1150));
    const i = (await state()).incident!; assert.equal(i.phase, 'HELP_REQUESTED');
    assert.equal((await state()).actions.find(a => a.type === 'wearer_checkin')?.status, 'cancelled');
    assert.equal((await commands({ type: 'accept', incidentId: i.id, responderId: 'maya' })).status, 200);
    assert.equal((await commands({ type: 'accept', incidentId: i.id, responderId: 'jordan' })).status, 400);
    assert.equal((await commands({ type: 'depart', incidentId: i.id, responderId: 'maya' })).status, 200);
    assert.equal((await commands({ type: 'arrive', incidentId: i.id, responderId: 'maya' })).status, 200);
    assert.equal((await commands({ type: 'resolve', incidentId: i.id, responderId: 'maya', outcome: 'Protocol test outcome recorded by assigned owner.' })).status, 200);
    assert.equal((await state()).incident?.phase, 'RESOLVED');
    assert.equal((await state()).actions.some(a => a.status === 'provider_accepted'), false);
    const beforePreview = await state();
    assert.equal((await preview('old-incident', 'What is recorded?')).status, 409);
    assert.equal((await preview(i.id, '')).status, 400);
    assert.equal((await preview(i.id, 5)).status, 400);
    assert.equal((await preview(i.id, 'x'.repeat(2001))).status, 400);
    const previewResult = await preview(i.id, 'Which allergies are in the returned record?');
    assert.equal(previewResult.status, 200);
    const answer = await previewResult.json();
    assert.equal(answer.incidentId, i.id);
    assert.equal(answer.generation, 'degraded');
    assert.match(answer.answer, /Health record unavailable/);
    const refusal = await (await preview(i.id, 'Should I give medicine?')).json();
    assert.equal(refusal.generation, 'policy_refusal');
    assert.match(refusal.answer, /cannot recommend treatment/);
    const afterPreview = await state();
    assert.deepEqual(afterPreview.incident, beforePreview.incident);
    assert.deepEqual(afterPreview.actions, beforePreview.actions);
    assert.deepEqual(afterPreview.timeline, beforePreview.timeline);
    const wearer = await (await fetch(`${base}/api/checkin`, { headers: { Authorization: `Bearer ${setup.token}` } })).json();
    assert.equal(wearer.incident.phase, 'RESOLVED');
    assert.equal(wearer.incident.outcome, 'Protocol test outcome recorded by assigned owner.');
    assert.equal(typeof wearer.serverTime, 'number');
    assert.deepEqual(wearer.responders, [{ id: 'maya', name: 'Maya' }, { id: 'jordan', name: 'Jordan' }]);
    assert.equal((await commands({ type: 'trigger', kind: 'synthetic', summary: 'Voice escalation fixture.' })).status, 200);
    const next = (await state()).incident!;
    const voiced = await new Promise<{status: number; body: {decision: string}}>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ incidentId: next.id, checkinId: next.checkinId,
        transcript: 'I’m not safe', source: 'ios-on-device-speech' }));
      const split = body.indexOf(Buffer.from('’')) + 1;
      const req = request(`${base}/api/checkin/reply`, { method: 'POST', headers: {
        Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' } }, res => {
        res.setEncoding('utf8'); let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => { try { resolve({status:res.statusCode!,body:JSON.parse(text)}); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.write(body.subarray(0, split));
      setTimeout(() => req.end(body.subarray(split)), 15);
    });
    assert.equal(voiced.status, 200); assert.equal(voiced.body.decision, 'help_requested');
    assert.equal((await state()).incident?.phase, 'HELP_REQUESTED');
  } finally {
    intervals.forEach(clearInterval); sockets.forEach(ws => ws.terminate());
    child.kill('SIGTERM'); await exit; rmSync(dir, { recursive: true, force: true });
  }
});
