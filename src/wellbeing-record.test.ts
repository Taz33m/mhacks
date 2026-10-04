import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wellbeing } from './wellbeing.ts';
import type { WellbeingRecordContext } from './wellbeing.ts';
import { normalizePatientRecord } from './patient-record.ts';
import { patientFixture } from './test-helpers/patient-fixture.ts';

const record = () => normalizePatientRecord(structuredClone(patientFixture), 1000);
function context(snapshot = record()): WellbeingRecordContext {
  return { source: 'finchnode-synthetic', synthetic: true, subjectId: snapshot.subject,
    subjectName: String(snapshot.records.find(r => r.category === 'demographics')!.fields.name),
    revision: snapshot.revision, sourceRecordIds: ['allergy-1'], retrievedAt: snapshot.fetchedAt, truncated: false };
}
function pending(w: Wellbeing, eventId = 'voice') {
  assert.equal(w.recordVoice({ eventId, conversationId: w.conversationId, sessionId: 'generated-board', transcript: 'What allergies are recorded?' }), true);
  return w.replyNeeded()!.id;
}
function store(path = ':memory:') {
  return new Wellbeing(path, { phone: '+15555550101', wearerName: 'Demo wearer' });
}

test('care journal retains the exact clinical answer and snapshot after mutation and restart, separate from local reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-care-journal-')), path = join(dir, 'state.sqlite');
  let w = store(path);
  try {
    const id = pending(w), snapshot = record(), metadata = context(snapshot);
    const text = 'Finch demo record — Fictional Patient (fictional; not your personal record).\nFictional substance [allergy-1]';
    assert.equal(w.queueRecordReply(id, text, 'ai', metadata, snapshot), true);
    assert.equal(w.queueRecordReply(id, text, 'ai', metadata, snapshot), false, 'a repeated answer never duplicates the outbox');
    const reply = w.view().messages.find(m => m.speaker === 'lifeline')!;
    assert.equal(reply.text, text); assert.equal(reply.delivery, 'queued');
    assert.deepEqual(reply.recordContext!.sourceRecordIds, ['allergy-1']);
    assert.equal(reply.recordContext!.requestMessageId, id);
    assert.equal('patientRecord' in reply, false, 'public conversation omits the full hospital snapshot');
    snapshot.records.find(r => r.category === 'demographics')!.fields.name = 'Later mutation'; metadata.sourceRecordIds.push('med-1');
    const action = w.claimAction()!;
    w.finishAction(action.id, 'provider_accepted', 'Fixture acceptance', 'private-native-message', { chatId: 'private-native-chat', lineId: 'private-native-line' });
    w.close(); w = store(path);
    const journal = w.careJournal(), saved = journal.hospitalRecords.snapshots[0];
    assert.equal(saved.requestMessageId, id); assert.equal(saved.replyMessageId, reply.id);
    assert.equal(saved.snapshot.records.find(r => r.category === 'demographics')!.fields.name, 'Fictional Patient');
    assert.equal(journal.lifelineObservations.messages[0].source, 'freewili-local-speech');
    assert.equal(journal.lifelineObservations.messages[1].delivery, 'provider_accepted');
    assert.deepEqual(journal.lifelineObservations.messages[1].recordContext!.sourceRecordIds, ['allergy-1']);
    const serialized = JSON.stringify(journal);
    for (const privateValue of ['private-native-message', 'private-native-chat', 'private-native-line', '+15555550101']) assert.equal(serialized.includes(privateValue), false);
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('record answer rejects mismatched revision, subject, source and citations without consuming pending message', () => {
  const w = store();
  try {
    const id = pending(w), snapshot = record(), valid = context(snapshot);
    for (const patch of [ { revision: 'another-revision' }, { subjectName: 'Actual wearer' }, { subjectId: 'another-patient' },
      { sourceRecordIds: ['invented-record'] }, { sourceRecordIds: ['allergy-1', 'allergy-1'] }, { retrievedAt: 2000 }, { synthetic: false }, { source: 'hospital' } ]) {
      assert.equal(w.queueRecordReply(id, 'Record answer.', 'ai', { ...valid, ...patch } as WellbeingRecordContext, snapshot), false);
      assert.equal(w.replyNeeded()!.id, id);
    }
    assert.equal(w.queueRecordReply(id, 'x'.repeat(6001), 'degraded', valid, snapshot), false);
    assert.equal(w.queueRecordReply(id, 'Record answer.', 'ai', valid, { ...snapshot, environment: 'live' } as unknown as typeof snapshot), false);
    assert.equal(w.queueRecordReply(id, 'Saved record answer.', 'degraded', valid, snapshot), true);
  } finally { w.close(); }
});

test('newer messages and explicit incident routing prevent a prepared record answer from entering the outbox', () => {
  const w = store();
  try {
    const old = pending(w, 'older'), next = pending(w, 'newer');
    assert.equal(w.queueRecordReply(old, 'Obsolete answer.', 'ai', context(), record()), false);
    w.markIncidentRouted(next);
    assert.equal(w.queueRecordReply(next, 'Obsolete after help request.', 'ai', context(), record()), false);
    assert.equal(w.careJournal().hospitalRecords.snapshots.length, 0);
    assert.equal(w.claimAction(), null);
  } finally { w.close(); }
});

test('unavailable clinical context stays explicitly unknown and never invents a hospital snapshot', () => {
  const w = store();
  try {
    const id = pending(w), unknown: WellbeingRecordContext = { source: 'finchnode-synthetic', synthetic: true,
      subjectId: null, subjectName: null, revision: null, sourceRecordIds: [], retrievedAt: null, truncated: false };
    assert.equal(w.queueRecordReply(id, 'Clinical record unavailable.', 'ai', unknown), false);
    assert.equal(w.queueRecordReply(id, 'Clinical record unavailable.', 'degraded', unknown), true);
    assert.equal(w.careJournal().hospitalRecords.snapshots.length, 0);
    assert.equal(w.view().messages.at(-1)!.recordContext!.revision, null);
  } finally { w.close(); }
});

test('care journal exports only snapshots belonging to visible conversation history', () => {
  const w = store();
  try {
    const id = pending(w, 'clinical');
    assert.equal(w.queueRecordReply(id, 'Saved historical source.', 'degraded', context(), record()), true);
    for (let index = 0; index < 41; index++) pending(w, `later-${index}`);
    assert.equal(w.view().messages.length, 40);
    assert.equal(w.careJournal().hospitalRecords.snapshots.length, 0);
  } finally { w.close(); }
});
