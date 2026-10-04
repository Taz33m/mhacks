import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import type { Action, Incident, Phase, Snapshot } from './contracts.ts';
import type { WiliConversationSpeak, WiliHostPacket, WiliIncidentContext } from '../native/freewili/protocol.ts';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read(); if (matches(value)) return value;
    await pause(20);
  } while (Date.now() < deadline);
  throw new Error('Isolated simulated dispatch did not reach the expected fixture state.');
}

// Generated wire packets verify the local demo orchestration only. No physical
// sensing, microphone recognition, audio audibility, GPS or Photon receipt is inferred.
test('isolated wearable rehearsal cancels check-ins and resolves a spoken report through autonomous Maya with honest provenance', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-simulated-dispatch-'));
  const child = spawn(process.execPath, ['--import', './src/test-helpers/offline.ts', './src/server.ts'], {
    cwd: process.cwd(),
    // A whitelist prevents ambient project, model, audio and messaging credentials
    // from reaching this child. Its preloader also rejects every external fetch.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC',
      LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_DISPATCH_MODE: 'simulated', LIFELINE_SIMULATED_STEP_MS: '200',
      LIFELINE_DEMO_MODE: '0', LIFELINE_LEGACY_PHONE: '0', LIFELINE_WELLBEING_ENABLED: '0',
      LIFELINE_WEARER_NAME: 'Offline wearer' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const sockets: WebSocket[] = [];
  let database: DatabaseSync | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Isolated simulated server did not start.')), 5000);
      child.stdout.on('data', bytes => {
        output = (output + bytes.toString()).slice(-8192);
        const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start isolated simulated server.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated simulated server exited before readiness.')); });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await (await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(2000) })).json() as { token: string };
    const state = async () => await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) })).json() as Snapshot;
    const initial = await state();
    assert.equal(initial.dispatch?.mode, 'simulated');
    assert.deepEqual(initial.responders, [{ id: 'demo-maya', name: 'Maya', phone: null, simulated: true }]);
    assert.equal(initial.policy.checkinMs, 20_000, 'simulated dispatch does not shorten the wearer response window');
    assert.equal(initial.policy.demoMode, false);
    assert.equal(initial.providers.photon.configured, false);
    assert.equal(initial.wearerMessaging.configured, false, 'no wearer iMessage receipt is fabricated');

    const sessionId = 'generated-simulated-dispatch-boot';
    const contexts: WiliIncidentContext[] = [], speech: WiliConversationSpeak[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/motion?source=body-wili&token=${setup.token}`); sockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', bytes => {
      const packet = JSON.parse(bytes.toString()) as WiliHostPacket;
      if (packet.type === 'incident.context') contexts.push(packet);
      if (packet.type !== 'conversation.speak') return;
      speech.push(packet);
      // Protocol acknowledgements are explicitly generated: they test queue
      // completion, not a successful physical playback or an ElevenLabs call.
      for (const status of ['queued', 'playing', 'spoken'] as const) ws.send(JSON.stringify({
        type: 'voice.playback', source: 'body-wili', sessionId, eventId: packet.eventId,
        incidentId: packet.incidentId, status,
      }));
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId,
      deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
      capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }));
    await waitFor(async () => contexts, packets => packets.some(packet => packet.incidentId === null));
    const press = (action: 'help' | 'cancel' | 'rehearse', eventId: string, incidentId: string | null, checkinId: string | null) =>
      ws.send(JSON.stringify({ type: 'button.press', source: 'body-wili', sessionId, eventId, action, incidentId, checkinId }));

    // Generated Yellow is the only rehearsal trigger; no operator drives the
    // incident. Packets establish transport behavior, not a physical button test.
    press('rehearse', 'generated-yellow-cancellation', null, null);
    const confirming = (await waitFor(state, value => value.incident?.phase === 'CONFIRMING')).incident!;
    assert.equal(confirming.dispatchMode, 'simulated');
    assert.equal(confirming.checkinDeadline - confirming.createdAt, 20_000);
    await waitFor(async () => contexts, packets => packets.some(packet => packet.incidentId === confirming.id
      && packet.phase === 'CONFIRMING' && /^LIFELINE\n/.test(packet.statusText ?? '') && !/DEMO/.test(packet.statusText ?? '')));
    press('cancel', 'generated-green-before-dispatch', confirming.id, confirming.checkinId);
    const cancelled = await waitFor(state, value => value.incident?.phase === 'CANCELLED_FALSE_ALARM');
    assert.equal(cancelled.incident!.id, confirming.id);
    assert.ok(cancelled.timeline.some(event => event.type === 'CANCELLED_FALSE_ALARM' && event.actor === 'freewili-button'));
    await pause(1100);
    const stillCancelled = await state();
    assert.equal(stillCancelled.incident!.phase, 'CANCELLED_FALSE_ALARM');
    assert.equal(stillCancelled.incident!.ownerId, null);
    assert.equal(stillCancelled.actions.some(action => action.status === 'simulated'), false);
    assert.equal(stillCancelled.conversation?.some(message => message.source === 'simulated-dispatch'), false);

    press('rehearse', 'generated-yellow-starts-spoken-rehearsal', null, null);
    const spokenCheckin = (await waitFor(state, value => value.incident?.id !== confirming.id
      && value.incident?.phase === 'CONFIRMING')).incident!;
    await waitFor(async () => contexts, packets => packets.some(packet => packet.incidentId === spokenCheckin.id
      && packet.phase === 'CONFIRMING' && packet.voiceAsset === 'CHECKIN'));
    const exactQuote = "I fell, I can't stand up.";
    ws.send(JSON.stringify({ type: 'checkin.reply', source: 'body-wili', sessionId,
      eventId: 'generated-voice-reply', incidentId: spokenCheckin.id, checkinId: spokenCheckin.checkinId,
      transcript: exactQuote }));
    const requested = await waitFor(state, value => value.incident?.id !== confirming.id && value.incident?.phase === 'HELP_REQUESTED');
    const incidentId = requested.incident!.id;
    assert.equal(requested.incident!.dispatchMode, 'simulated');
    assert.equal(requested.incident!.evidence.kind, 'synthetic');
    assert.equal(requested.conversation?.find(message => message.speaker === 'wearer')?.text, exactQuote);
    assert.ok(requested.timeline.some(event => event.type === 'DEVICE_BUTTON' && event.actor === 'freewili-button'));
    const resolved = await waitFor(state, value => value.incident?.id === incidentId && value.incident.phase === 'RESOLVED'
      && value.actions.some(action => action.type === 'alert' && action.status === 'simulated'));
    assert.equal(resolved.incident!.ownerId, 'demo-maya');
    assert.equal(resolved.incident!.resolutionActor, 'simulated-dispatch:demo-maya');
    assert.match(resolved.incident!.outcome!, /reached the wearer and stayed with them/);
    assert.match(resolved.incident!.outcome!, /arranging further assistance\./);
    const expected: Phase[] = ['HELP_REQUESTED', 'ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED'];
    assert.deepEqual(resolved.timeline.filter(event => expected.includes(event.type as Phase)).map(event => event.type), expected);
    assert.ok(resolved.timeline.filter(event => expected.slice(1).includes(event.type as Phase))
      .every(event => event.actor === 'simulated-dispatch:demo-maya'));
    await waitFor(async () => contexts, packets => packets.some(packet => packet.incidentId === incidentId && packet.phase === 'RESOLVED'));
    const incidentContexts = contexts.filter(packet => packet.incidentId === incidentId);
    const phases = incidentContexts.reduce<string[]>((list, packet) => {
      if (packet.phase && list.at(-1) !== packet.phase) list.push(packet.phase); return list;
    }, []);
    assert.deepEqual(phases, ['CONFIRMING', ...expected]);
    assert.ok(incidentContexts.every(packet => !/DEMO/.test(packet.statusText ?? '')));
    assert.equal(speech.filter(packet => packet.incidentId === incidentId).length, 3);
    assert.ok(speech.every(packet => packet.speakerName === 'Maya'));
    const reports = resolved.conversation!.filter(message => message.speaker === 'responder');
    assert.equal(reports.length, 4); assert.ok(reports.every(message => message.source === 'simulated-dispatch'));
    assert.equal(reports.slice(0, 3).every(message => message.delivery === 'spoken'), true);
    assert.equal(reports.at(-1)!.delivery, 'recorded');
    assert.ok(resolved.actions.some(action => action.recipientId === 'demo-maya' && action.status === 'simulated'));
    assert.ok(resolved.actions.every(action => action.providerMessageId === null));
    assert.equal(resolved.actions.some(action => action.status === 'provider_accepted'), false);
    assert.equal(resolved.sensors.some(sensor => sensor.fresh), false);
    assert.equal(resolved.wili!.fresh, false); assert.equal(resolved.wili!.accelerationG, null);
    assert.equal(resolved.location?.wearer, null); assert.equal(resolved.location?.responder, null); assert.equal(resolved.location?.eta, null);

    // Check persisted private records as well as the redacted API, so stripping
    // a forged native receipt from the snapshot cannot make this assertion pass.
    database = new DatabaseSync(join(dir, 'lifeline.sqlite'), { readOnly: true });
    const persisted = JSON.parse(String(database.prepare('SELECT body FROM incidents WHERE id=?').get(incidentId)!.body)) as Incident;
    assert.equal(persisted.dispatchMode, 'simulated');
    assert.equal(persisted.resolutionActor, 'simulated-dispatch:demo-maya');
    const actions = database.prepare('SELECT body FROM actions WHERE incident_id=?').all(incidentId)
      .map(row => JSON.parse(String(row.body)) as Action);
    for (const action of actions) {
      assert.equal(action.providerMessageId, null); assert.equal(action.providerChatId, undefined); assert.equal(action.providerLineId, undefined);
      assert.equal(action.replyToMessageId, undefined); assert.equal(action.replyChatId, undefined); assert.equal(action.replyLineId, undefined);
    }
    assert.equal(Number(database.prepare('SELECT count(*) AS n FROM location_native_positions').get()!.n), 0);
    assert.equal(Number(database.prepare('SELECT count(*) AS n FROM location_positions').get()!.n), 0);
  } finally {
    database?.close(); sockets.forEach(socket => socket.terminate());
    if (child.exitCode === null) child.kill('SIGTERM');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise(resolve => {
        killTimer = setTimeout(() => { child.kill('SIGKILL'); void exited.then(resolve); }, 2000);
      })]);
    } finally { if (killTimer) clearTimeout(killTimer); }
    rmSync(dir, { recursive: true, force: true });
  }
});
