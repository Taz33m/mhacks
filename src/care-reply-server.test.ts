import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Snapshot } from './contracts.ts';
import type { Wellbeing, WellbeingMessage } from './wellbeing.ts';
import type { PatientRecordSnapshot } from './patient-record.ts';
import type { WiliHostPacket, WiliWellbeingContext } from '../native/freewili/protocol.ts';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Journal = ReturnType<Wellbeing['careJournal']>;
async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (matches(value)) return value; await pause(15); } while (Date.now() < deadline);
  throw new Error('Isolated care reply did not reach its expected fixture state.');
}

// Real server routing/storage with generated protocol and API/model responses.
// This does not establish physical transcription, personal EHR access or delivery.
test('everyday WILi questions retain exact fictional clinical context privately and export a bounded attributed journal', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-care-reply-'));
  const child = spawn(process.execPath, ['--import', './src/test-helpers/care-record-offline.ts', './src/server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC',
      LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1', LIFELINE_DISPATCH_MODE: 'live',
      LIFELINE_LEGACY_PHONE: '0', LIFELINE_WEARER_PHONE: '+12025550100', LIFELINE_WEARER_NAME: 'Offline wearer',
      LIFELINE_WELLBEING_ENABLED: '1', LIFELINE_WELLBEING_TIMEZONE: 'UTC',
      LIFELINE_WELLBEING_HOUR: String((new Date().getUTCHours() + 1) % 24),
      LIFELINE_LLM_API_KEY: 'isolated-model-placeholder', LIFELINE_LLM_MODEL: 'generated-selection-fixture',
      LIFELINE_LLM_BASE_URL: 'http://127.0.0.1:11999/v1',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Offline responder', phone: null }]) },
  });
  const exited = once(child, 'exit'); let ws: WebSocket | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Isolated care server did not start.')), 5000);
      child.stdout.on('data', bytes => {
        output = (output + bytes.toString()).slice(-8192); const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start isolated care server.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated care server exited before readiness.')); });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await (await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(2000) })).json() as { token: string };
    const headers = { Authorization: `Bearer ${setup.token}` };
    const state = async () => await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) })).json() as Snapshot;
    const journal = async () => {
      const response = await fetch(`${base}/api/wellbeing/brief`, { headers, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.match(response.headers.get('Content-Disposition') ?? '', /attachment/);
      return await response.json() as Journal;
    };
    assert.equal((await fetch(`${base}/api/wellbeing/brief`)).status, 401);
    assert.equal((await fetch(`${base}/api/wellbeing/brief`, { headers: { Authorization: 'Bearer incorrect-fixture-token' } })).status, 401);
    assert.equal((await state()).providers.photon.configured, false);
    assert.equal((await state()).wearerMessaging.configured, false);

    const sessionId = 'generated-care-record-board';
    const packets: WiliHostPacket[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/motion?source=body-wili&token=${setup.token}`);
    ws.on('error', () => {}); ws.on('message', bytes => packets.push(JSON.parse(bytes.toString()) as WiliHostPacket));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId,
      deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
      capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }));
    await waitFor(async () => packets, values => values.some(packet => packet.type === 'wellbeing.context' && packet.enabled));
    const conversationId = packets.find((packet): packet is WiliWellbeingContext => packet.type === 'wellbeing.context' && packet.enabled)!.conversationId;
    let sequence = 0;
    async function speak(transcript: string): Promise<{ wearer: WellbeingMessage; reply: WellbeingMessage; state: Snapshot }> {
      const before = (await state()).wellbeing!.messages.at(-1)?.id;
      ws!.send(JSON.stringify({ type: 'wellbeing.reply', source: 'body-wili', sessionId, eventId: `generated-care-voice-${sequence++}`,
        conversationId, transcript }));
      const recorded = await waitFor(state, value => value.wellbeing!.messages.some(message => message.id !== before
        && message.speaker === 'wearer' && message.text === transcript));
      const wearer = recorded.wellbeing!.messages.findLast(message => message.speaker === 'wearer' && message.text === transcript)!;
      const answered = await waitFor(state, value => {
        const messages = value.wellbeing!.messages, index = messages.findIndex(message => message.id === wearer.id);
        return index >= 0 && messages.slice(index + 1).some(message => message.speaker === 'lifeline' && message.source === 'agent');
      });
      const messages = answered.wellbeing!.messages, index = messages.findIndex(message => message.id === wearer.id);
      return { wearer, reply: messages.slice(index + 1).find(message => message.speaker === 'lifeline' && message.source === 'agent')!, state: answered };
    }
    // Cross the export's forty-message boundary using generated ordinary diary
    // exchanges before the clinical questions that must retain their snapshots.
    for (let index = 0; index < 22; index++) {
      const ordinary = await speak(`Today I enjoyed reading chapter ${index}.`);
      assert.equal(ordinary.state.incident, null); assert.equal(ordinary.reply.recordContext, undefined);
    }

    const allergy = await speak('What allergies are recorded?');
    assert.equal(allergy.state.incident, null); assert.equal(allergy.reply.generation, 'ai');
    assert.match(allergy.reply.text, /From your health record:/);
    assert.match(allergy.reply.text, /Fictional substance.*\[allergy-1\]/);
    assert.equal(allergy.wearer.source, 'freewili-local-speech');
    assert.deepEqual(allergy.reply.recordContext, {
      source: 'finchnode-synthetic', synthetic: true, subjectId: 'patient-demo-001', subjectName: 'Fictional Patient',
      revision: allergy.reply.recordContext!.revision, sourceRecordIds: ['allergy-1'],
      retrievedAt: allergy.reply.recordContext!.retrievedAt, truncated: false, requestMessageId: allergy.wearer.id,
    });
    assert.ok(allergy.reply.recordContext!.revision); assert.ok(Number.isFinite(allergy.reply.recordContext!.retrievedAt));
    const firstExport = await journal();
    const firstSaved = firstExport.hospitalRecords.snapshots.find(entry => entry.replyMessageId === allergy.reply.id)!;
    assert.equal(firstSaved.requestMessageId, allergy.wearer.id);
    assert.equal(firstSaved.snapshot.revision, allergy.reply.recordContext!.revision);
    assert.equal(firstSaved.snapshot.fetchedAt, allergy.reply.recordContext!.retrievedAt);
    assert.equal(firstSaved.snapshot.synthetic, true); assert.equal(firstSaved.snapshot.subject, 'patient-demo-001');
    const previousSnapshot = structuredClone(firstSaved.snapshot);

    assert.equal((await fetch(`${base}/api/patient-record/refresh`, { method: 'POST' })).status, 401);
    const refresh = await fetch(`${base}/api/patient-record/refresh`, { method: 'POST', headers, signal: AbortSignal.timeout(2000) });
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json() as PatientRecordSnapshot;
    assert.notEqual(refreshed.revision, previousSnapshot.revision, 'fixture source changes make the refreshed revision different');
    assert.deepEqual((await journal()).hospitalRecords.snapshots.find(entry => entry.replyMessageId === allergy.reply.id)!.snapshot, previousSnapshot,
      'refresh cannot replace the source snapshot that backed an earlier answer');
    const medication = await speak('What medications are recorded?');
    assert.equal(medication.state.incident, null); assert.equal(medication.reply.generation, 'ai');
    assert.match(medication.reply.text, /Fictional regimen.*\[med-1\]/);
    assert.equal(medication.reply.recordContext!.revision, refreshed.revision);
    assert.equal(medication.reply.recordContext!.requestMessageId, medication.wearer.id);
    assert.ok(medication.reply.recordContext!.sourceRecordIds.includes('med-1'));

    const socialText = 'I enjoyed the garden today.\nThe flowers were lovely.';
    const social = await speak(socialText);
    assert.equal(social.state.incident, null); assert.equal(social.wearer.text, socialText);
    assert.equal(social.wearer.recordContext, undefined); assert.equal(social.reply.recordContext, undefined);
    assert.equal(social.reply.generation, 'ai', 'ordinary companion fixture receives no clinical record values');
    const advice = await speak('Should I take a medication or change my dose?');
    assert.equal(advice.state.incident, null); assert.equal(advice.reply.generation, 'policy_refusal');
    assert.match(advice.reply.text, /cannot recommend treatment, select a dose, or establish a diagnosis/);
    assert.deepEqual(advice.reply.recordContext!.sourceRecordIds, []);

    const latest = await state(), exported = await journal();
    assert.equal(exported.lifelineObservations.messages.length, 40);
    assert.deepEqual(exported.lifelineObservations.messages, latest.wellbeing!.messages, 'export preserves exact message attribution, text, IDs, times and source');
    assert.match(exported.hospitalRecords.source, /FinchNode \(read-only\)/);
    assert.match(exported.lifelineObservations.source, /not hospital EHR entries/);
    assert.equal(exported.lifelineObservations.messages.some(message => message.text === socialText && message.source === 'freewili-local-speech'), true);
    assert.deepEqual(exported.hospitalRecords.snapshots.find(entry => entry.replyMessageId === allergy.reply.id)!.snapshot, previousSnapshot);
    assert.equal(exported.hospitalRecords.snapshots.find(entry => entry.replyMessageId === medication.reply.id)!.snapshot.revision, refreshed.revision);
    const publicState = JSON.stringify(latest);
    assert.doesNotMatch(publicState, /"patientRecord"|"snapshot"|"hospitalRecords"|"requestedCategories"|"consent"|"records"\s*:/);
    assert.equal(latest.incident, null); assert.equal(latest.wili!.accelerationG, null);
    assert.equal(latest.actions.some(action => action.status === 'provider_accepted'), false);

    ws.send(JSON.stringify({ type: 'wellbeing.reply', source: 'body-wili', sessionId,
      eventId: 'generated-care-explicit-help', conversationId, transcript: 'I need help' }));
    const help = await waitFor(state, value => value.incident?.phase === 'HELP_REQUESTED');
    assert.equal(help.incident!.evidence.kind, 'manual');
    assert.match(help.incident!.evidence.summary, /explicitly requested help.*wellbeing/);
    await waitFor(async () => packets, values => values.some(packet => packet.type === 'wellbeing.context' && !packet.enabled));
    assert.equal(help.actions.every(action => action.providerMessageId === null), true);
  } finally {
    ws?.terminate(); if (child.exitCode === null) child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise(resolve => {
      timer = setTimeout(() => { child.kill('SIGKILL'); void exited.then(resolve); }, 2000);
    })]); } finally { if (timer) clearTimeout(timer); }
    rmSync(dir, { recursive: true, force: true });
  }
});
