import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckinReply } from './checkin.ts';
import { Controller } from './controller.ts';
import type { CheckinReply } from './contracts.ts';

test('negation, mixed replies, and quoted safety phrases never cancel a check-in', () => {
  for (const reply of ["I'm not okay", "I am not safe, but I don't need help", 'the TV said I am safe',
    'maybe', 'no', 'I do not think I am okay', 'I need help but never mind']) {
    assert.equal(classifyCheckinReply(reply), 'unresolved', reply);
  }
  assert.equal(classifyCheckinReply("I’m not safe!"), 'help_requested');
  assert.equal(classifyCheckinReply('Yes, I need help.'), 'help_requested');
  assert.equal(classifyCheckinReply("I don't need help."), 'confirmation_required');
});

test('positive and ambiguous voice replies preserve phase and deadline; help escalates with evidence', () => {
  let now = 1000;
  const c = new Controller(':memory:', [{ id: 'maya', name: 'Maya', phone: null }], () => now);
  try {
    const i = c.trigger({ kind: 'synthetic', summary: 'Speech policy fixture.' });
    const reply = (transcript: string): CheckinReply => ({ incidentId: i.id, checkinId: i.checkinId,
      transcript, source: 'ios-on-device-speech' });
    assert.equal(c.recordCheckinReply(reply("I'm okay")), 'confirmation_required');
    assert.equal(c.recordCheckinReply(reply('I do not know')), 'unresolved');
    assert.equal(c.active()?.phase, 'CONFIRMING');
    assert.equal(c.active()?.checkinDeadline, i.checkinDeadline);
    now += 500;
    assert.equal(c.recordCheckinReply(reply('I need help')), 'help_requested');
    assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    assert.equal(c.actions(i.id).filter(a => a.type === 'alert').length, 1);
    const event = c.events(i.id).filter(e => e.type === 'CHECKIN_REPLY').at(-1)!;
    assert.equal(event.actor, 'ios-on-device-speech');
    assert.deepEqual(JSON.parse(event.detail), { transcript: 'I need help', decision: 'help_requested' });
    assert.throws(() => c.recordCheckinReply(reply("I'm okay")), /current check-in/);
  } finally { c.close(); }
});

test('invalid or stale replies and late cancellation cannot alter state', () => {
  let now = 1000;
  const c = new Controller(':memory:', [], () => now);
  try {
    const i = c.trigger({ kind: 'synthetic', summary: 'Deadline fixture.' });
    const reply: CheckinReply = { incidentId: i.id, checkinId: i.checkinId,
      transcript: 'I need help', source: 'ios-on-device-speech' };
    assert.throws(() => c.recordCheckinReply({ ...reply, checkinId: 'old' }), /current check-in/);
    assert.throws(() => c.recordCheckinReply({ ...reply, source: 'model' } as unknown as CheckinReply), /on-device/);
    assert.throws(() => c.recordCheckinReply({ ...reply, transcript: 'x'.repeat(501) }), /1–500/);
    assert.equal(c.events(i.id).some(e => e.type === 'CHECKIN_REPLY'), false);
    now = i.checkinDeadline;
    assert.throws(() => c.recordCheckinReply(reply), /before its deadline/);
    assert.throws(() => c.cancel(i.id, i.checkinId), /current unresolved check-in/);
    c.tick(); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
  } finally { c.close(); }
});
