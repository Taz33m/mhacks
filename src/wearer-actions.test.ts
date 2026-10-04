import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, PolicyError } from './controller.ts';
import type { Incident } from './contracts.ts';

const responders = [{ id: 'maya', name: 'Maya', phone: null }, { id: 'jordan', name: 'Jordan', phone: null }];
const policy = { checkinMs: 20_000, acceptMs: 60_000, progressMs: 120_000 };
function setup(t: TestContext) {
  let now = 1000; const c = new Controller(':memory:', responders, () => now, policy);
  t.after(() => c.close());
  return { c, advance: (ms: number) => { now += ms; } };
}
const reply = (i: Incident, transcript: string) => ({ incidentId: i.id, checkinId: i.checkinId, transcript });
const checkins = (c: Controller, id: string) => c.actions(id).filter(a => a.type === 'checkin' || a.type === 'wearer_checkin');

test('new check-in has one wearer outbox action while native speech stays phone-owned; repeat triggers preserve deadline', t => {
  const { c, advance } = setup(t);
  const i = c.trigger({ kind: 'synthetic', summary: 'Wearer outbox protocol fixture.' });
  assert.equal(i.phase, 'CONFIRMING');
  const actions = checkins(c, i.id); assert.equal(actions.length, 2);
  assert.deepEqual(actions.map(a => [a.type, a.recipientId]), [['checkin', null], ['wearer_checkin', null]]);
  const wearer = actions[1];
  assert.ok(wearer.text.includes('I noticed a possible fall. Are you okay?'));
  assert.ok(!wearer.text.includes(i.id), 'the patient never sees incident codes'); assert.match(wearer.text, /help/i); assert.match(wearer.text, /reply|tap/i);
  advance(5000);
  const repeated = c.trigger({ kind: 'synthetic', summary: 'Repeated evidence.' });
  assert.equal(repeated.id, i.id); assert.equal(repeated.checkinId, i.checkinId);
  assert.equal(repeated.checkinDeadline, i.checkinDeadline); assert.equal(checkins(c, i.id).length, 2);
  const claimed = c.claimAction()!; assert.equal(claimed.id, wearer.id); assert.equal(claimed.type, 'wearer_checkin');
  assert.equal(claimed.attempts, 1); c.finishAction(claimed.id, 'provider_accepted', 'Protocol fixture accepted.', 'wearer-message');
  assert.equal(c.claimAction(), null); assert.equal(c.actions(i.id).find(a => a.type === 'checkin')?.status, 'queued');
  c.cancel(i.id, i.checkinId);
  for (let fyi = c.claimAction('responders'), k = 0; fyi; fyi = c.claimAction('responders'), k++) { assert.match(fyi.text, /LIFELINE FYI/); c.finishAction(fyi.id, 'provider_accepted', 'FYI fixture accepted.', `fyi-message-${k}`); }
  const next = c.trigger({ kind: 'synthetic', summary: 'Next distinct check-in.' });
  assert.notEqual(next.id, i.id); assert.notEqual(next.checkinId, i.checkinId);
  assert.equal(checkins(c, next.id).length, 2); assert.equal(c.claimAction()?.type, 'wearer_checkin');
});

test('manual help immediately cancels both queued check-ins and repeating it creates no duplicate actions', t => {
  for (const confirmingFirst of [false, true]) {
    const { c } = setup(t);
    const prior = confirmingFirst ? c.trigger({ kind: 'synthetic', summary: 'Possible incident.' }) : null;
    const i = c.trigger({ kind: 'manual', summary: 'Explicit help control.' });
    assert.equal(i.phase, 'HELP_REQUESTED'); if (prior) assert.equal(i.id, prior.id);
    assert.equal(checkins(c, i.id).length, 2); assert.ok(checkins(c, i.id).every(a => a.status === 'cancelled'));
    const count = c.actions(i.id).length;
    assert.equal(c.trigger({ kind: 'manual', summary: 'Repeated help control.' }).id, i.id);
    assert.equal(c.actions(i.id).length, count); assert.equal(c.actions(i.id).filter(a => a.type === 'alert').length, 2);
    assert.equal(c.claimAction()?.type, 'alert');
  }
});

test('wearer failed sends retry only before the original deadline, even before the timer has ticked', t => {
  const { c, advance } = setup(t); const i = c.trigger({ kind: 'synthetic', summary: 'Retry deadline fixture.' });
  const first = c.claimAction()!; assert.equal(first.type, 'wearer_checkin');
  c.finishAction(first.id, 'failed', 'Confirmed provider rejection.');
  advance(9999); assert.equal(c.claimAction(), null);
  advance(1); const retry = c.claimAction()!;
  assert.equal(retry.id, first.id); assert.equal(retry.attempts, 2);
  c.finishAction(retry.id, 'failed', 'Second confirmed rejection.');
  advance(10_000); assert.equal(c.active()?.phase, 'CONFIRMING'); assert.equal(c.active()?.checkinDeadline, i.checkinDeadline);
  advance(10_000); // Retry is due, but the persisted deadline expired without a timer tick.
  assert.equal(c.claimAction(), null);
  c.tick(); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
  assert.ok(checkins(c, i.id).every(a => a.status === 'cancelled')); assert.equal(c.claimAction()?.type, 'alert');
});

test('expired queued and phase-ended failed wearer actions are never claimed', t => {
  const queued = setup(t); const expired = queued.c.trigger({ kind: 'synthetic', summary: 'Queued expiry fixture.' });
  queued.advance(policy.checkinMs); assert.equal(queued.c.claimAction(), null);
  queued.c.tick(); assert.equal(queued.c.active()?.phase, 'HELP_REQUESTED');
  assert.ok(checkins(queued.c, expired.id).every(a => a.status === 'cancelled'));
  const failed = setup(t); const cancelled = failed.c.trigger({ kind: 'synthetic', summary: 'Phase-ended failure fixture.' });
  const action = failed.c.claimAction()!; failed.c.finishAction(action.id, 'failed', 'Confirmed rejection.');
  failed.c.cancel(cancelled.id, cancelled.checkinId); failed.advance(10_000);
  const closure = failed.c.claimAction('wearer')!;
  assert.equal(closure.type, 'wearer_status'); assert.match(closure.text, /check-in closed/);
  assert.equal(failed.c.claimAction('wearer'), null); assert.equal(failed.c.actions(cancelled.id).find(a => a.id === action.id)?.status, 'cancelled');
});

test('a slow wearer send cannot block the responder lane, and lanes never claim each other’s actions', t => {
  const { c, advance } = setup(t); const i = c.trigger({ kind: 'synthetic', summary: 'Independent outbox lane fixture.' });
  assert.equal(c.claimAction('responders'), null);
  const wearer = c.claimAction('wearer')!; assert.equal(wearer.type, 'wearer_checkin');
  advance(policy.checkinMs); c.tick(); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
  assert.equal(c.actions(i.id).find(a => a.id === wearer.id)?.status, 'attempting');
  const escalation = c.claimAction('wearer')!;
  assert.equal(escalation.type, 'wearer_status'); assert.match(escalation.text, /getting help for you now/);
  const alert = c.claimAction('responders')!; assert.equal(alert.type, 'alert');
  assert.equal(c.actions(i.id).find(a => a.id === wearer.id)?.status, 'attempting');
  const expired = setup(t); expired.c.trigger({ kind: 'synthetic', summary: 'Expired wearer lane fixture.' });
  expired.advance(policy.checkinMs); assert.equal(expired.c.claimAction('wearer'), null);
});

test('wearer replies preserve positive/ambiguous incidents, escalate exact help and dedupe the Photon audit', t => {
  const { c, advance } = setup(t); const i = c.trigger({ kind: 'synthetic', summary: 'Wearer reply fixture.' });
  assert.equal(c.recordWearerCheckinReply(reply(i, "I'm okay"), 'positive-message'), 'confirmation_required');
  assert.equal(c.recordWearerCheckinReply(reply(i, 'I need help but never mind'), 'ambiguous-message'), 'unresolved');
  assert.equal(c.active()?.phase, 'CONFIRMING'); assert.equal(c.active()?.checkinDeadline, i.checkinDeadline);
  const before = c.events(i.id).length;
  assert.equal(c.recordWearerCheckinReply(reply(i, 'I need help'), 'positive-message'), null);
  assert.equal(c.events(i.id).length, before); assert.equal(c.active()?.phase, 'CONFIRMING');
  advance(500);
  assert.equal(c.recordWearerCheckinReply(reply(i, "I’m not safe!"), 'help-message'), 'help_requested');
  assert.equal(c.active()?.phase, 'HELP_REQUESTED'); assert.equal(c.actions(i.id).filter(a => a.type === 'alert').length, 2);
  const audit = c.events(i.id).filter(e => e.type === 'CHECKIN_REPLY'); assert.equal(audit.length, 3);
  assert.ok(audit.every(e => e.actor === 'photon-imessage'));
  assert.deepEqual(JSON.parse(audit.at(-1)!.detail), { transcript: "I’m not safe!", decision: 'help_requested' });
  const after = c.events(i.id).length;
  assert.equal(c.recordWearerCheckinReply(reply(i, "I’m not safe!"), 'help-message'), null);
  assert.equal(c.events(i.id).length, after); assert.ok(checkins(c, i.id).every(a => a.status === 'cancelled'));
});

test('stale IDs and replies at the deadline cannot change state or consume an inbound ID', t => {
  const { c, advance } = setup(t); const i = c.trigger({ kind: 'synthetic', summary: 'Wearer stale-reply fixture.' });
  assert.throws(() => c.recordWearerCheckinReply({ ...reply(i, 'I need help'), incidentId: 'LF-OLD' }, 'stale-incident'), PolicyError);
  assert.throws(() => c.recordWearerCheckinReply({ ...reply(i, 'I need help'), checkinId: 'old-checkin' }, 'stale-checkin'), PolicyError);
  advance(policy.checkinMs);
  assert.throws(() => c.recordWearerCheckinReply(reply(i, 'I need help'), 'late-message'), PolicyError);
  assert.equal(c.active()?.phase, 'CONFIRMING'); assert.equal(c.events(i.id).some(e => e.type === 'CHECKIN_REPLY'), false);
  for (const id of ['stale-incident', 'stale-checkin', 'late-message']) assert.equal(c.seenInbound(id), false);
  c.tick(); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
});

test('wearer reply dedupe and audit roll back with a failed incident transition', t => {
  const { c } = setup(t); const i = c.trigger({ kind: 'synthetic', summary: 'Atomic reply fixture.' });
  c.db.exec(`CREATE TEMP TRIGGER reject_help BEFORE UPDATE OF phase ON incidents
    WHEN NEW.phase = 'HELP_REQUESTED' BEGIN SELECT RAISE(ABORT, 'Injected persistence failure'); END;`);
  assert.throws(() => c.recordWearerCheckinReply(reply(i, 'I need help'), 'retryable-inbound'), /Injected persistence failure/);
  assert.equal(c.seenInbound('retryable-inbound'), false); assert.equal(c.active()?.phase, 'CONFIRMING');
  assert.equal(c.events(i.id).some(e => e.type === 'CHECKIN_REPLY'), false);
  assert.equal(c.actions(i.id).some(a => a.type === 'alert'), false);
  assert.ok(checkins(c, i.id).every(a => a.status === 'queued'));
  c.db.exec('DROP TRIGGER reject_help');
  assert.equal(c.recordWearerCheckinReply(reply(i, 'I need help'), 'retryable-inbound'), 'help_requested');
  assert.equal(c.seenInbound('retryable-inbound'), true); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
});

test('message lookup matches only the current wearer check-in and never native/responder or historical actions', t => {
  const { c } = setup(t); const i = c.trigger({ kind: 'synthetic', summary: 'Message association fixture.' });
  const wearer = c.claimAction()!; c.finishAction(wearer.id, 'provider_accepted', 'Protocol fixture accepted.', 'wearer-message');
  assert.equal(c.wearerIncidentForMessage('wearer-message')?.id, i.id);
  assert.equal(c.wearerIncidentForMessage('missing-message'), null);
  // A native speech action never belongs to the messaging worker, even with a stored message ID.
  const native = c.actions(i.id).find(a => a.type === 'checkin')!;
  c.finishAction(native.id, 'provider_accepted', 'Association fixture only.', 'native-message');
  assert.equal(c.wearerIncidentForMessage('native-message'), null);
  c.cancel(i.id, i.checkinId); for (let fyi = c.claimAction('responders'), k = 0; fyi; fyi = c.claimAction('responders'), k++) { assert.match(fyi.text, /LIFELINE FYI/); c.finishAction(fyi.id, 'provider_accepted', 'FYI fixture accepted.', `fyi-message-${k}`); }
  const next = c.trigger({ kind: 'manual', summary: 'New manual incident.' });
  const alert = c.claimAction()!; assert.equal(alert.type, 'alert');
  c.finishAction(alert.id, 'provider_accepted', 'Protocol fixture accepted.', 'responder-message');
  assert.notEqual(next.id, i.id); assert.equal(c.wearerIncidentForMessage('wearer-message'), null);
  assert.equal(c.wearerIncidentForMessage('responder-message'), null);
});

test('interrupted wearer sends recover as unknown without automatic retry and keep the persisted deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-wearer-outbox-')); const path = join(directory, 'state.sqlite');
  let now = 1000; let c = new Controller(path, responders, () => now, policy);
  try {
    const i = c.trigger({ kind: 'synthetic', summary: 'Wearer restart fixture.' }); const attempted = c.claimAction()!;
    assert.equal(attempted.type, 'wearer_checkin'); c.close(); now += 10_000;
    c = new Controller(path, responders, () => now, policy);
    const recovered = c.actions(i.id).find(a => a.id === attempted.id)!;
    assert.equal(recovered.status, 'unknown'); assert.equal(recovered.attempts, 1);
    assert.equal(c.claimAction(), null); assert.equal(c.active()?.checkinId, i.checkinId);
    assert.equal(c.active()?.checkinDeadline, i.checkinDeadline);
    now = i.checkinDeadline; c.tick(); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    assert.equal(c.actions(i.id).find(a => a.id === attempted.id)?.status, 'unknown');
    assert.equal(c.actions(i.id).find(a => a.type === 'checkin')?.status, 'cancelled');
    assert.equal(c.claimAction()?.type, 'alert');
  } finally { c.close(); rmSync(directory, { recursive: true, force: true }); }
});
