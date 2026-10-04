import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Snapshot } from './contracts.ts';
import type { BodyWiliSample } from './freewili.ts';
import type { WiliHostPacket, WiliIncidentContext } from '../native/freewili/protocol.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 3500): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const value = await read(); if (matches(value)) return value;
    await pause(20);
  } while (Date.now() < end);
  throw new Error('Isolated WILi server did not reach the expected fixture state.');
}

test('isolated stock WILi acquisition, speech and buttons preserve policy and reported responder progress', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-wili-server-'));
  const child = spawn(process.execPath, ['--import', './src/test-helpers/offline.ts', './src/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_LEGACY_PHONE: '0', LIFELINE_DEMO_MODE: '0', LIFELINE_CHECKIN_MS: '5000',
      SPECTRUM_PROJECT_ID: '', SPECTRUM_PROJECT_SECRET: '', ELEVENLABS_API_KEY: '', LIFELINE_LLM_API_KEY: '',
      LIFELINE_LLM_BASE_URL: '', LIFELINE_LLM_MODEL: '', LIFELINE_WEARER_PHONE: '',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Maya', phone: null }, { id: 'jordan', name: 'Jordan', phone: null }]) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const sockets: WebSocket[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Isolated WILi server did not start.')), 5000);
      child.stdout.on('data', bytes => {
        output += bytes.toString(); const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start isolated WILi server.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated WILi server exited before ready.')); });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await (await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(2000) })).json() as { token: string };
    const state = async () => await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) })).json() as Snapshot;
    const command = async (body: unknown) => fetch(`${base}/api/commands`, { method: 'POST', signal: AbortSignal.timeout(2000),
      headers: { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const rejected = async (source: string, token: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/motion?source=${source}&token=${token}`); sockets.push(ws);
      ws.on('error', () => {});
      return await new Promise<number>((resolve, reject) => {
        ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); });
        ws.once('open', () => reject(new Error('Rejected fixture unexpectedly opened.')));
      });
    };
    assert.equal(await rejected('chest-phone', setup.token), 403, 'ordinary phone sensor ingestion is disabled');
    assert.equal(await rejected('body-wili', 'incorrect-private-token'), 403);
    assert.equal((await state()).sensors.some(sensor => sensor.source === 'chest-phone'), false);

    const sessionId = 'synthetic-server-og-boot';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/motion?source=body-wili&token=${setup.token}`); sockets.push(ws);
    const contexts: WiliHostPacket[] = [];
    const context = async (incidentId: string, phase: string) => {
      const packets = await waitFor(async () => contexts, value => value.some(packet =>
        packet.type === 'incident.context' && packet.incidentId === incidentId && packet.phase === phase));
      return packets.findLast((packet): packet is WiliIncidentContext =>
        packet.type === 'incident.context' && packet.incidentId === incidentId && packet.phase === phase)!;
    };
    let sequence = 0;
    ws.on('message', bytes => {
      const packet = JSON.parse(bytes.toString()) as WiliHostPacket;
      if (packet.type === 'clock.ping') ws.send(JSON.stringify({ type: 'clock.pong', id: packet.id, sessionId,
        deviceReceivedMs: performance.now(), deviceSentMs: performance.now() }));
      else contexts.push(packet);
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId,
      deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
      capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }));
    // A hello-time pong can arrive before the first sample initializes the adapter session.
    // The first accepted sample must request alignment without waiting for the periodic ping.
    await pause(50);
    const sample = (): BodyWiliSample => ({ type: 'accel.sample', source: 'body-wili', sessionId, sequence: sequence++,
      sensorTime: performance.now() / 1000, captureClock: 'host-receipt', accelerationG: [0, 0, 1.7],
      frameTimestamp: String(1015894500660534528n + BigInt(sequence) * 33000n),
      fullScaleG: 2, fresh: true, saturated: false, quality: 'measured' });
    ws.send(JSON.stringify(sample()));
    intervals.push(setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(sample())); }, 10));
    const measured = await waitFor(state, value => value.wili?.usable === true, 1000);
    assert.equal(measured.wili!.source, 'body-wili'); assert.equal(measured.wili!.sessionId, sessionId);
    assert.equal(measured.wili!.quality, 'measured'); assert.equal(measured.wili!.totalG, 1.7);
    assert.equal(measured.wili!.fullScaleG, 2); assert.equal(measured.wili!.captureClock, 'host-receipt');
    assert.equal(typeof measured.wili!.alignmentUncertaintyMs, 'number');
    assert.equal(measured.sensors.some(sensor => sensor.source === 'waist-airpod' && sensor.fresh), false);
    assert.equal(measured.incident, null, 'board-only motion cannot open an incident without waist corroboration');
    assert.equal(contexts.some(packet => packet.type === 'incident.context' && packet.incidentId === null), true);
    await pause(50);
    const recording = readFileSync(join(dir, 'recordings', `body-wili-${sessionId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(recording.length > 2, true);
    assert.equal(recording.every(packet => packet.source === 'body-wili' && packet.captureClock === 'host-receipt'
      && packet.fullScaleG === 2 && /^\d{1,20}$/.test(packet.frameTimestamp)
      && Number.isFinite(packet.hostMonotonicMs) && Number.isFinite(packet.receivedAt)), true);
    assert.equal(recording.some(packet => 'quaternion' in packet || 'gravity' in packet || 'rotationRate' in packet), false);

    const press = (action: 'help' | 'cancel', eventId: string, incidentId: string | null, checkinId: string | null) => {
      ws.send(JSON.stringify({ type: 'button.press', source: 'body-wili', sessionId, eventId, action, incidentId, checkinId }));
    };
    press('help', 'synthetic-help-1', null, null);
    const help = (await waitFor(state, value => value.incident?.phase === 'HELP_REQUESTED')).incident!;
    assert.equal(help.evidence.kind, 'manual'); assert.match(help.evidence.summary, /explicitly pressed.*help button/);
    assert.equal((await state()).timeline.some(event => event.actor === 'freewili-button'), true);
    press('cancel', 'synthetic-cancel-escalated', help.id, help.checkinId);
    await pause(30); assert.equal((await state()).incident?.phase, 'HELP_REQUESTED', 'board cannot cancel after escalation');
    const unassigned = await context(help.id, 'HELP_REQUESTED');
    assert.equal(unassigned.ownerName, null); assert.match(unassigned.statusText!, /WAITING FOR RESPONDER/);
    assert.equal((await command({ type: 'accept', incidentId: help.id, responderId: 'maya' })).status, 200);
    const accepted = await context(help.id, 'ACKNOWLEDGED');
    assert.equal(accepted.ownerName, 'Maya'); assert.equal(accepted.voiceAsset, 'ACCEPTED');
    assert.match(accepted.statusText!, /Maya ACCEPTED\nDEPARTURE NOT REPORTED/);
    assert.doesNotMatch(accepted.statusText!, /EN ROUTE/);
    assert.equal((await command({ type: 'depart', incidentId: help.id, responderId: 'maya' })).status, 200);
    const enRoute = await context(help.id, 'RESPONDER_EN_ROUTE');
    assert.equal(enRoute.ownerName, 'Maya'); assert.equal(enRoute.voiceAsset, 'ENROUTE');
    assert.match(enRoute.statusText!, /Maya EN ROUTE/);
    assert.equal((await command({ type: 'arrive', incidentId: help.id, responderId: 'maya' })).status, 200);
    const onScene = await context(help.id, 'ON_SCENE');
    assert.equal(onScene.ownerName, 'Maya'); assert.match(onScene.statusText!, /Maya ON SCENE/);
    assert.equal((await command({ type: 'resolve', incidentId: help.id, responderId: 'maya',
      outcome: 'Synthetic protocol fixture resolved by assigned test responder.' })).status, 200);
    const resolved = await context(help.id, 'RESOLVED');
    assert.equal(resolved.ownerName, 'Maya'); assert.equal(resolved.voiceAsset, 'RESOLVED');
    assert.match(resolved.statusText!, /RESOLVED\nOUTCOME RECORDED/);
    press('help', 'synthetic-stale-help', help.id, help.checkinId);
    await pause(30); assert.equal((await state()).incident?.phase, 'RESOLVED', 'stale help does not reopen a terminal incident');
    assert.equal(contexts.findLast(packet => packet.type === 'incident.context')?.type, 'incident.context');
    assert.equal(contexts.findLast(packet => packet.type === 'incident.context'), resolved,
      'the board retains the latest terminal context instead of returning to a ready screen');

    assert.equal((await command({ type: 'trigger', kind: 'synthetic', summary: 'Synthetic board-local speech fixture; no physical event.' })).status, 200);
    const spoken = (await state()).incident!; assert.equal(spoken.phase, 'CONFIRMING');
    await waitFor(state, value => value.incident?.handoffGeneration === 'degraded');
    const audioStatus = (eventId: string, stage: string, incidentId = spoken.id, checkinId = spoken.checkinId) =>
      ws.send(JSON.stringify({ type: 'checkin.audio', source: 'body-wili', sessionId, eventId, incidentId, checkinId, stage }));
    audioStatus('synthetic-mic-open', 'listening');
    const listening = await waitFor(state, value => value.checkinAudio?.stage === 'listening');
    assert.equal(listening.checkinAudio?.sessionId, sessionId);
    assert.equal(listening.incident?.phase, 'CONFIRMING', 'microphone status cannot change incident policy');
    assert.equal(listening.incident?.checkinDeadline, spoken.checkinDeadline);
    audioStatus('synthetic-stale-mic-status', 'transcribing', help.id, help.checkinId);
    await pause(30);
    assert.equal((await state()).checkinAudio?.stage, 'listening', 'earlier incidents cannot overwrite current microphone status');
    const reply = (eventId: string, transcript: string) => ws.send(JSON.stringify({ type: 'checkin.reply',
      source: 'body-wili', sessionId, eventId, incidentId: spoken.id, checkinId: spoken.checkinId, transcript }));
    const spokenDecision = (transcript: string, decision: string) => waitFor(state, value => value.timeline.some(event =>
      event.incidentId === spoken.id && event.type === 'CHECKIN_REPLY' && event.actor === 'freewili-local-speech'
      && event.detail === JSON.stringify({ transcript, decision })));
    reply('synthetic-positive-speech', "I'm okay");
    const positive = await spokenDecision("I'm okay", 'confirmation_required');
    assert.equal(positive.incident!.phase, 'CONFIRMING');
    assert.equal(positive.incident!.checkinDeadline, spoken.checkinDeadline, 'positive speech never extends the server deadline');
    await waitFor(async () => contexts, packets => packets.some(packet => packet.type === 'audio.command'
      && packet.commandId === 'speech-synthetic-positive-speech' && packet.asset === 'safe-confirmation'
      && packet.incidentId === spoken.id && packet.checkinId === spoken.checkinId && packet.action === 'play'));
    const acknowledgements = contexts.filter(packet => packet.type === 'audio.command').length;
    reply('synthetic-ambiguous-speech', 'I think maybe');
    const ambiguous = await spokenDecision('I think maybe', 'unresolved');
    assert.equal(ambiguous.incident!.phase, 'CONFIRMING');
    assert.equal(ambiguous.incident!.checkinDeadline, spoken.checkinDeadline);
    assert.equal(contexts.filter(packet => packet.type === 'audio.command').length, acknowledgements,
      'an ambiguous reply does not receive a safe acknowledgement');
    const ankleReport = "I fell pretty hard. My ankle hurts and I can't stand up.";
    reply('synthetic-help-speech', ankleReport);
    const requested = await spokenDecision(ankleReport, 'help_requested');
    assert.equal(requested.incident!.phase, 'HELP_REQUESTED', 'an exact help command escalates before the silence deadline');
    assert.equal(requested.incident!.checkinDeadline, spoken.checkinDeadline);
    assert.equal(requested.serverTime < spoken.checkinDeadline, true);
    audioStatus('synthetic-post-help-mic-status', 'listening');
    await pause(30);
    assert.equal((await state()).checkinAudio?.at, listening.checkinAudio?.at,
      'a microphone-open report after escalation cannot reopen listening');
    audioStatus('synthetic-transcription-complete', 'complete');
    await waitFor(state, value => value.checkinAudio?.stage === 'complete');
    const refreshed = await waitFor(state, value => value.incident?.handoff.includes(ankleReport) === true);
    const recordedReport = refreshed.conversation!.find(message => message.text === ankleReport)!;
    assert.match(refreshed.incident!.handoff, /local observations, not hospital records/);
    assert.ok(refreshed.incident!.handoff.includes(`[conversation:${recordedReport.id}]`),
      'speech arriving after initial composition refreshes the handoff with its exact source citation');
    const beforeQuestion = await state();
    const question = await fetch(`${base}/api/context/question`, { method: 'POST', headers: {
      Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId: spoken.id, question: 'What did the wearer say?' }) });
    assert.equal(question.status, 200);
    const answer = await question.json();
    assert.equal(answer.generation, 'degraded', 'offline source quote cannot be labelled AI');
    assert.ok(answer.answer.includes(ankleReport));
    assert.ok(answer.answer.includes(`[conversation:${recordedReport.id}]`));
    const afterQuestion = await state();
    assert.deepEqual(afterQuestion.actions, beforeQuestion.actions, 'local clinical rehearsal sends no messages');
    assert.equal(afterQuestion.incident!.phase, beforeQuestion.incident!.phase);
    assert.equal(afterQuestion.incident!.ownerId, null);
    for (const type of ['accept', 'depart', 'arrive'] as const)
      assert.equal((await command({ type, incidentId: spoken.id, responderId: 'maya' })).status, 200);
    assert.equal((await command({ type: 'resolve', incidentId: spoken.id, responderId: 'maya',
      outcome: 'Synthetic speech fixture resolved by assigned test responder.' })).status, 200);

    assert.equal((await command({ type: 'trigger', kind: 'synthetic', summary: 'Synthetic WILi button policy fixture; no physical event.' })).status, 200);
    const confirming = (await state()).incident!; assert.equal(confirming.phase, 'CONFIRMING');
    press('cancel', 'synthetic-stale-cancel', help.id, help.checkinId);
    await pause(30); assert.equal((await state()).incident?.phase, 'CONFIRMING');
    press('cancel', 'synthetic-current-cancel', confirming.id, confirming.checkinId);
    const cancelled = await waitFor(state, value => value.incident?.phase === 'CANCELLED_FALSE_ALARM');
    assert.equal(cancelled.incident!.id, confirming.id);
    assert.equal(cancelled.timeline.some(event => event.actor === 'freewili-button' && event.type === 'CANCELLED_FALSE_ALARM'), true);
    const closedCheckin = await context(confirming.id, 'CANCELLED_FALSE_ALARM');
    // A closed check-in must not replay instructions to press green again.
    assert.equal(closedCheckin.voiceAsset, null); assert.match(closedCheckin.statusText!, /EXPLICIT CONTROL CONFIRMED/);

    intervals.forEach(clearInterval); intervals.length = 0;
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'device.status', source: 'body-wili', sessionId, status: 'sample-unavailable' }));
    await closed;
    const unavailable = await waitFor(state, value => value.wili?.connected === false);
    assert.equal(unavailable.wili!.fresh, false); assert.equal(unavailable.wili!.usable, false);
    assert.equal(unavailable.wili!.accelerationG, null, 'explicit acquisition failure clears formerly fresh evidence');
    assert.equal(unavailable.checkinAudio, null, 'disconnected microphone status is cleared');

    const ackSocket = new WebSocket(`ws://127.0.0.1:${port}/motion?source=body-wili&token=${setup.token}`); sockets.push(ackSocket);
    await once(ackSocket, 'open');
    const ackSession = 'synthetic-unsolicited-audio';
    ackSocket.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId: ackSession,
      deviceModel: 'freewili-og', fullScaleG: 8,
      capabilities: { accelerometer: true, speaker: true, microphone: false, buttons: true } }));
    const ackClosed = once(ackSocket, 'close');
    ackSocket.send(JSON.stringify({ type: 'audio.ack', source: 'body-wili', sessionId: ackSession,
      eventId: 'unsolicited-audio-event', commandId: 'not-issued-command', incidentId: confirming.id,
      checkinId: confirming.checkinId, status: 'finished' }));
    const [closeCode] = await Promise.race([ackClosed, pause(1000).then(() => { throw new Error('Unsolicited audio acknowledgement was not rejected.'); })]);
    assert.equal(closeCode, 1008);
  } finally {
    intervals.forEach(clearInterval); sockets.forEach(socket => socket.terminate());
    child.kill('SIGTERM'); await exited; rmSync(dir, { recursive: true, force: true });
  }
});
