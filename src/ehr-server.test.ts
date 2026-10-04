import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Incident, Snapshot } from './contracts.ts';
import type { EhrWorkspace } from './ehr.ts';
import type { PatientRecordSnapshot } from './patient-record.ts';
import type { Wellbeing } from './wellbeing.ts';
import type { WiliHostPacket, WiliWellbeingContext } from '../native/freewili/protocol.ts';

type CareJournal = ReturnType<Wellbeing['careJournal']>;
interface EhrBrief {
  schemaVersion: 1; kind: string; context: EhrWorkspace['context'];
  hospitalRecords: { source: string; snapshot: PatientRecordSnapshot | null;
    incidentSnapshot: PatientRecordSnapshot | null; answerSnapshots: CareJournal['hospitalRecords']['snapshots'] };
  lifelineObservations: { source: string; wearer: EhrWorkspace['care']['subject'];
    wellbeing: CareJournal['lifelineObservations']; incident: EhrWorkspace['care']['selectedIncident'] };
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (matches(value)) return value; await pause(15); } while (Date.now() < deadline);
  throw new Error('Isolated EHR fixture did not reach its expected state.');
}

async function startFixture(failFirst = false) {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-ehr-'));
  // Deliberately whitelist this child environment: no inherited provider keys,
  // private database, native Find My, actual contacts or external model URL.
  const child = spawn(process.execPath, ['--import', './src/test-helpers/ehr-offline.ts', './src/server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC',
      LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_DISPATCH_MODE: 'live', LIFELINE_LEGACY_PHONE: '0',
      LIFELINE_WEARER_PHONE: '+12025550100', LIFELINE_WEARER_NAME: 'Generated EHR wearer',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'ehr-fixture-responder', name: 'Generated EHR responder', phone: '+12025550101' }]),
      LIFELINE_WELLBEING_ENABLED: '1', LIFELINE_WELLBEING_TIMEZONE: 'UTC',
      LIFELINE_WELLBEING_HOUR: String((new Date().getUTCHours() + 1) % 24),
      LIFELINE_EHR_FIXTURE_FAIL_FIRST: failFirst ? '1' : '0' },
  });
  child.stderr.resume();
  const exited = once(child, 'exit');
  async function close() {
    if (child.exitCode === null) child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise(resolve => {
      timer = setTimeout(() => { child.kill('SIGKILL'); void exited.then(resolve); }, 2000);
    })]); } finally { if (timer) clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); }
  }
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Isolated EHR server startup timed out.')), 5000);
      child.stdout.on('data', bytes => {
        output = (output + bytes.toString()).slice(-8192);
        const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start isolated EHR server.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated EHR server exited before readiness.')); });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await (await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(2000) })).json() as { token: string };
    const headers = { Authorization: `Bearer ${setup.token}` };
    const request = (path: string, options: RequestInit = {}) => fetch(`${base}${path}`, { headers,
      signal: AbortSignal.timeout(2000), ...options });
    async function json<T>(path: string, options: RequestInit = {}): Promise<T> {
      const response = await request(path, options); assert.equal(response.status, 200, `Expected successful isolated ${path.split('?')[0]} read.`);
      return await response.json() as T;
    }
    const state = () => json<Snapshot>('/api/state');
    const workspace = (incidentId?: string) => json<EhrWorkspace>(`/api/ehr${incidentId ? `?incidentId=${incidentId}` : ''}`);
    async function brief(incidentId?: string): Promise<EhrBrief> {
      const response = await request(`/api/ehr/brief${incidentId ? `?incidentId=${incidentId}` : ''}`);
      assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.match(response.headers.get('Content-Disposition') ?? '', /attachment;.*lifeline-care-record\.json/);
      return await response.json() as EhrBrief;
    }
    async function command(body: unknown) { await json('/api/commands', { method: 'POST', body: JSON.stringify(body) }); }
    async function trigger(summary: string): Promise<Incident> {
      await command({ type: 'trigger', kind: 'synthetic', summary });
      const captured = await waitFor(state, value => value.incident?.phase === 'CONFIRMING'
        && value.incident.evidence.summary === summary && Boolean(value.incident.handoffGeneration)
        && value.timeline.some(event => event.type === 'HEALTH_CONTEXT_BOUND'));
      return captured.incident!;
    }
    const cancel = (incident: Incident) => command({ type: 'cancel', incidentId: incident.id, checkinId: incident.checkinId });
    return { base, port, token: setup.token, request, json, state, workspace, brief, command, trigger, cancel, close };
  } catch (error) { await close(); throw error; }
}

function noPrivateControls(workspace: EhrWorkspace, token: string, sessionId?: string) {
  const serialized = JSON.stringify(workspace);
  for (const secret of [token, '+12025550100', '+12025550101', ...(sessionId ? [sessionId] : [])])
    assert.equal(serialized.includes(secret), false, 'EHR projection excludes configured private contacts and transport identities.');
  assert.doesNotMatch(serialized, /"(?:checkinId|checkinDeadline|progressDeadline|contacts|declines|sourceSessions|providerMessageId|providerChatId|providerLineId|replyToMessageId|replyChatId|replyLineId|inboundId|chatId|lineId|providerTimestamp)"\s*:/);
}
const policyState = (state: Snapshot) => ({ incident: state.incident, timeline: state.timeline,
  actions: state.actions, conversation: state.conversation, wellbeing: state.wellbeing });

// Generated source/protocol inputs exercise the actual HTTP server, Controller
// and private source snapshot storage. No physical sensor, speech or send claim.
test('EHR authenticates, separates sources and keeps incident/answer snapshots immutable while current clinical context refreshes', { timeout: 20_000 }, async () => {
  const fixture = await startFixture(); let ws: WebSocket | undefined;
  try {
    for (const endpoint of ['/api/ehr', '/api/ehr/brief']) {
      assert.equal((await fetch(`${fixture.base}${endpoint}`)).status, 401);
      assert.equal((await fetch(`${fixture.base}${endpoint}?incidentId=LF-UNKNOWN`)).status, 401);
      assert.equal((await fixture.request(endpoint, { headers: { Authorization: 'Bearer incorrect-fixture-token' } })).status, 401);
      assert.equal((await fixture.request(`${endpoint}?incidentId=LF-UNKNOWN`)).status, 404);
      assert.equal((await fixture.request(`${endpoint}?incidentId=../private`)).status, 400);
      assert.equal((await fixture.request(`${endpoint}?incidentId=LF-A&incidentId=LF-B`)).status, 400);
    }
    const initial = await fixture.workspace();
    assert.equal(initial.schemaVersion, 1); assert.ok(Number.isFinite(initial.generatedAt));
    assert.deepEqual(initial.context, { scope: 'current', incidentId: null, revision: initial.patientRecord!.revision });
    assert.equal(initial.care.selectedIncident, null); assert.deepEqual(initial.care.incidents, []);
    assert.deepEqual(initial.care.subject, { name: 'Generated EHR wearer', recordLink: 'unlinked' });
    assert.equal(initial.patientRecord!.subject, 'patient-demo-001'); assert.equal(initial.patientRecord!.synthetic, true);
    assert.match(initial.sources.hospital, /FinchNode \(read-only\)/);
    assert.match(initial.sources.observations, /LIFELINE care log/);
    assert.equal((await fixture.state()).providers.photon.configured, false);
    assert.equal((await fixture.state()).wearerMessaging.configured, false);

    const sessionId = 'generated-ehr-board-session'; const packets: WiliHostPacket[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/motion?source=body-wili&token=${fixture.token}`);
    ws.on('error', () => {}); ws.on('message', bytes => packets.push(JSON.parse(bytes.toString()) as WiliHostPacket));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId,
      deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
      capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }));
    await waitFor(async () => packets, values => values.some(packet => packet.type === 'wellbeing.context' && packet.enabled));
    const conversationId = packets.find((packet): packet is WiliWellbeingContext => packet.type === 'wellbeing.context' && packet.enabled)!.conversationId;
    ws.send(JSON.stringify({ type: 'wellbeing.reply', source: 'body-wili', sessionId,
      eventId: 'generated-ehr-allergy-question', conversationId, transcript: 'What allergies are recorded?' }));
    const answered = await waitFor(fixture.state, value => value.wellbeing!.messages.some(message => message.recordContext?.sourceRecordIds.includes('allergy-1')));
    assert.equal(answered.incident, null);
    const answer = answered.wellbeing!.messages.find(message => message.recordContext?.sourceRecordIds.includes('allergy-1'))!;
    assert.match(answer.text, /^From your health record:\n(?!From the health record)/);
    const savedAnswers = (await fixture.brief()).hospitalRecords.answerSnapshots;
    assert.equal(savedAnswers.length, 1); assert.equal(savedAnswers[0].replyMessageId, answer.id);
    assert.equal(savedAnswers[0].snapshot.revision, initial.patientRecord!.revision);

    const first = await fixture.trigger('Generated EHR fixture incident 0; not a measured event.');
    ws.send(JSON.stringify({ type: 'checkin.reply', source: 'body-wili', sessionId,
      eventId: 'generated-ehr-incident-report', incidentId: first.id, checkinId: first.checkinId,
      transcript: 'I bumped my knee in this generated rehearsal.' }));
    await waitFor(fixture.state, value => Boolean(value.conversation?.some(message => message.text === 'I bumped my knee in this generated rehearsal.')));
    await waitFor(fixture.state, value => value.timeline.filter(event => event.type === 'HANDOFF_PREPARED').length >= 2);
    const firstView = await fixture.workspace(first.id), savedPatient = structuredClone(firstView.patientRecord!);
    assert.deepEqual(firstView.context, { scope: 'incident', incidentId: first.id, revision: savedPatient.revision });
    assert.equal(firstView.care.selectedIncident!.clinicalRevision, savedPatient.revision);
    assert.equal(firstView.care.selectedIncident!.incident.evidence.kind, 'synthetic');
    assert.deepEqual(firstView.care.selectedIncident!.incident.evidence, { kind: 'synthetic', summary: first.evidence.summary, measurements: null });
    assert.equal(firstView.care.selectedIncident!.conversation[0].source, 'freewili-local-speech');
    assert.equal(firstView.care.selectedIncident!.conversation[0].text, 'I bumped my knee in this generated rehearsal.');
    noPrivateControls(firstView, fixture.token, sessionId);

    const refreshed = await fixture.json<PatientRecordSnapshot>('/api/patient-record/refresh', { method: 'POST' });
    assert.notEqual(refreshed.revision, savedPatient.revision);
    const current = await fixture.workspace();
    assert.deepEqual(current.context, { scope: 'current', incidentId: null, revision: refreshed.revision });
    assert.deepEqual(current.patientRecord, refreshed);
    assert.equal(current.care.selectedIncident!.incident.id, first.id);
    assert.equal(current.care.selectedIncident!.clinicalRevision, savedPatient.revision,
      'latest care activity remains explicitly bound to its original clinical revision');
    assert.deepEqual((await fixture.workspace(first.id)).patientRecord, savedPatient);
    const exported = await fixture.brief(first.id);
    assert.deepEqual(exported.context, firstView.context);
    assert.deepEqual(exported.hospitalRecords.snapshot, savedPatient);
    assert.deepEqual(exported.hospitalRecords.incidentSnapshot, savedPatient);
    assert.deepEqual(exported.hospitalRecords.answerSnapshots, savedAnswers);
    assert.deepEqual(exported.lifelineObservations.wearer, initial.care.subject);
    assert.deepEqual(exported.lifelineObservations.wellbeing.messages, (await fixture.state()).wellbeing!.messages);
    assert.deepEqual(exported.lifelineObservations.incident, (await fixture.workspace(first.id)).care.selectedIncident);
    assert.match(exported.hospitalRecords.source, /FinchNode \(read-only\)/);
    assert.match(exported.lifelineObservations.source, /LIFELINE care log/);

    const oldQuestion = await fixture.json<{ answer: string; revision: string }>('/api/patient-record/question', {
      method: 'POST', body: JSON.stringify({ incidentId: first.id, revision: savedPatient.revision, question: 'What allergies are recorded?' }) });
    assert.equal(oldQuestion.revision, savedPatient.revision);
    assert.match(oldQuestion.answer, /generated EHR retrieval 1/); assert.doesNotMatch(oldQuestion.answer, /generated EHR retrieval 2/);
    assert.equal((await fixture.request('/api/patient-record/question', { method: 'POST',
      body: JSON.stringify({ revision: savedPatient.revision, question: 'What allergies are recorded?' }) })).status, 409);

    const beforeReads = policyState(await fixture.state());
    await fixture.workspace(); await fixture.workspace(first.id); await fixture.brief(); await fixture.brief(first.id);
    assert.deepEqual(policyState(await fixture.state()), beforeReads, 'workspace/export reads do not advance policy, write audit events or create outbox actions');
    await fixture.cancel(first);
    const createdIds = [first.id];
    for (let index = 1; index < 14; index++) {
      const incident = await fixture.trigger(`Generated EHR fixture incident ${index}; not a measured event.`);
      createdIds.push(incident.id); await fixture.cancel(incident);
    }
    const history = await fixture.workspace();
    assert.equal(history.care.incidents.length, 12);
    assert.deepEqual(history.care.incidents.map(incident => incident.id), createdIds.toReversed().slice(0, 12));
    assert.ok(history.care.incidents.every((incident, index, rows) => index === 0 || rows[index - 1].createdAt >= incident.createdAt));
    assert.equal(history.care.incidents.some(incident => incident.id === first.id), false);
    const olderSelection = await fixture.workspace(first.id);
    assert.equal(olderSelection.care.selectedIncident!.incident.id, first.id);
    assert.equal(olderSelection.care.selectedIncident!.incident.phase, 'CANCELLED_FALSE_ALARM');
    assert.deepEqual(olderSelection.patientRecord, savedPatient, 'an older known incident stays selectable outside the twelve-row summary');
    noPrivateControls(history, fixture.token, sessionId); noPrivateControls(olderSelection, fixture.token, sessionId);
    assert.equal((await fixture.state()).actions.some(action => action.providerMessageId !== null), false);
    for (const [path, mime] of [['/ehr', 'text/html'], ['/ehr.js', 'text/javascript'], ['/ehr.css', 'text/css']]) {
      const response = await fixture.request(path); assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type') ?? '', new RegExp(mime));
    }
    assert.notEqual((await fixture.request('/.env')).status, 200);
  } finally { ws?.terminate(); await fixture.close(); }
});

test('EHR keeps an unavailable incident snapshot absent after the current source recovers', { timeout: 10_000 }, async () => {
  const fixture = await startFixture(true);
  try {
    const unavailable = await fixture.workspace();
    assert.equal(unavailable.patientRecord, null); assert.equal(unavailable.context.revision, null);
    assert.equal(unavailable.context.scope, 'current');
    const incident = await fixture.trigger('Generated incident while the fictional source is unavailable.');
    const captured = await fixture.workspace(incident.id);
    assert.equal(captured.patientRecord, null); assert.equal(captured.context.scope, 'incident');
    assert.equal(captured.context.incidentId, incident.id); assert.equal(captured.context.revision, null);
    assert.equal(captured.care.selectedIncident!.clinicalRevision, null);
    const refreshed = await fixture.json<PatientRecordSnapshot>('/api/patient-record/refresh', { method: 'POST' });
    assert.ok(refreshed.revision); assert.deepEqual((await fixture.workspace()).patientRecord, refreshed);
    const stillAbsent = await fixture.workspace(incident.id);
    assert.equal(stillAbsent.patientRecord, null); assert.equal(stillAbsent.context.revision, null);
    const brief = await fixture.brief(incident.id);
    assert.equal(brief.hospitalRecords.snapshot, null); assert.equal(brief.hospitalRecords.incidentSnapshot, null);
    assert.equal(brief.context.revision, null);
    assert.equal((await fixture.request('/api/patient-record/question', { method: 'POST', body: JSON.stringify({
      incidentId: incident.id, revision: refreshed.revision, question: 'What allergies are recorded?' }) })).status, 503);
    const before = policyState(await fixture.state());
    await fixture.workspace(incident.id); await fixture.brief(incident.id);
    assert.deepEqual(policyState(await fixture.state()), before);
    noPrivateControls(stillAbsent, fixture.token); await fixture.cancel(incident);
  } finally { await fixture.close(); }
});
