import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller.ts';
import { handleResponderProgress } from './responder.ts';
import { handleResponderQuestion } from './responder-questions.ts';
import type { HealthContext, ProviderInbound } from './contracts.ts';
import { normalizePatientRecord } from './patient-record.ts';
import { patientFixture } from './test-helpers/patient-fixture.ts';

const responders = [{ id: 'maya', name: 'Maya', phone: '+12025550101' }, { id: 'jordan', name: 'Jordan', phone: '+12025550102' }];
function setup(path = ':memory:') {
  const c = new Controller(path, responders, () => 1000);
  const i = c.active() ?? c.trigger({ kind: 'manual', summary: 'Synthetic possible incident.' });
  for (const a of c.actions(i.id).filter(a => a.type === 'alert'))
    c.finishAction(a.id, 'provider_accepted', 'Offline native fixture.', `alert-${a.recipientId}`, { chatId: `dm-${a.recipientId}`, lineId: 'shared' });
  return { c, i };
}
function incoming(text: string, overrides: Partial<ProviderInbound> = {}): ProviderInbound {
  return { messageId: `inbound-${text}`, kind: 'text', sender: responders[0].phone,
    chatId: 'dm-maya', lineId: 'shared', providerTimestamp: 999,
    targetMessageId: 'alert-maya', text, ...overrides };
}
test('bound native acceptance, natural progress, outcome, and wearer updates complete one loop', async () => {
  const { c, i } = setup();
  try {
    assert.equal(handleResponderProgress(incoming('', { kind: 'reaction', reaction: '👍' }), c), true);
    assert.equal(c.active()?.phase, 'ACKNOWLEDGED');
    assert.equal(c.actions(i.id).findLast(a => a.type === 'wearer_status')!.text, 'Maya has answered your alert.');
    assert.equal(handleResponderProgress(incoming('leaving'), c), true);
    assert.equal(c.active()?.phase, 'RESPONDER_EN_ROUTE');
    assert.equal(handleResponderProgress(incoming('Arrived'), c), true);
    assert.equal(c.active()?.phase, 'ON_SCENE');
    assert.equal(handleResponderProgress(incoming('Arrived'), c), false, 'replayed provider input is consumed once');
    const outcome = 'Wearer requested no further help; Maya stayed until their family arrived.';
    assert.equal(handleResponderProgress(incoming(`resolved: ${outcome}`), c), true);
    assert.equal(c.latest()?.outcome, outcome);
    assert.equal(c.latest()?.phase, 'RESOLVED');
    const reports = c.events(i.id).filter(e => e.type === 'RESPONDER_REPORT');
    assert.equal(reports.length, 4);
    assert.equal(JSON.parse(reports[2].detail).providerTimestamp, 999);
    assert.equal(c.claimAction('wearer'), null, 'the care-team outcome is not narrated to the patient');
  } finally { c.close(); }
});
test('wrong conversation, sending line, target, sender, bare text and negation cannot advance', () => {
  const { c, i } = setup();
  try {
    c.accept(i.id, 'maya');
    for (const extra of [{ chatId: 'different' }, { lineId: 'different' }, { targetMessageId: 'alert-jordan' },
      { targetMessageId: 'old-alert', text: `arrived ${i.id}` }, { targetMessageId: undefined },
      { text: "I haven't arrived" }, { text: 'arriving soon' }, { sender: '+12025550999' }, { removed: true }]) {
      assert.equal(handleResponderProgress(incoming('arrived', extra), c), false);
      assert.equal(c.active()?.phase, 'ACKNOWLEDGED');
    }
    assert.throws(() => handleResponderProgress(incoming('arrived', { sender: responders[1].phone, chatId: 'dm-jordan', targetMessageId: 'alert-jordan' }), c), /assigned owner/);
    assert.equal(handleResponderProgress(incoming(`arrived ${i.id}`, { targetMessageId: undefined }), c), true);
  } finally { c.close(); }
});
test('bound Q&A persists native reply routing, survives restart, and rejects another chat before generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-threaded-')); let c: Controller | null = null;
  try {
    ({ c } = setup(join(dir, 'state.sqlite')));
    const i = c.active()!;
    assert.equal(await handleResponderQuestion(incoming('Which allergies are recorded?', { chatId: 'other-chat' }), c,
      async () => { throw new Error('Wrong chat disclosed records'); }), false);
    assert.equal(await handleResponderQuestion(incoming('Which allergies are recorded?'), c, async () => ({ text: 'Synthetic allergy [a-1].', generation: 'ai' })), true);
    c.close(); c = new Controller(join(dir, 'state.sqlite'), responders, () => 1000);
    const a = c.claimAction('responders')!;
    assert.equal(a.type, 'answer'); assert.equal(a.replyChatId, 'dm-maya'); assert.equal(a.replyLineId, 'shared');
    assert.equal(a.replyToMessageId, 'inbound-Which allergies are recorded?');
    assert.equal(c.matchesConversation(incoming('status?'), 'maya'), true);
    assert.equal(c.seenInbound('inbound-Which allergies are recorded?'), true);
    assert.equal(c.active()?.id, i.id);
  } finally { c?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('clinical context is bound once and persists independently of refreshed patient context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-clinical-')); let c: Controller | null = null;
  try {
    ({ c } = setup(join(dir, 'state.sqlite'))); const id = c.active()!.id;
    const record = normalizePatientRecord(patientFixture, 1000);
    const first: HealthContext = { summary: 'Synthetic original record.', recordIds: ['med-a'], retrievedAt: 1000, available: true, patientRecord: record };
    c.bindHealthContext(id, first);
    assert.deepEqual(c.bindHealthContext(id, { ...first, summary: 'Changed record.', recordIds: ['med-b'] }), first);
    assert.throws(() => c!.setHandoff(id, 'Wrong revision', { generation: 'ai', healthRevision: 'different-revision' }), /must match/);
    assert.notEqual(c.incident(id)?.handoff, 'Wrong revision');
    c.setHandoff(id, 'Source-grounded handoff', { generation: 'ai', healthRevision: record.revision });
    c.close(); c = new Controller(join(dir, 'state.sqlite'), responders);
    assert.deepEqual(c.healthContext(id), first);
    assert.equal(c.incident(id)?.healthRevision, record.revision);
    assert.equal(c.incident(id)?.handoffGeneration, 'ai');
    assert.deepEqual(JSON.parse(c.events(id).find(e => e.type === 'HANDOFF_PREPARED')!.detail), { generation: 'ai', clinicalRevision: record.revision });
  } finally { c?.close(); rmSync(dir, { recursive: true, force: true }); }
});
