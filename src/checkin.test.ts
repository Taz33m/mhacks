import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckinReply, reportsCurrentSeizure } from './checkin.ts';

test('current first-person seizure reports request help, without interpreting history or quoted speech', () => {
  for (const reply of ["I'm having a seizure", 'I am having a seizure right now!', 'I’m seizing', 'Please help I am having a seizure']) {
    assert.equal(reportsCurrentSeizure(reply), true, reply);
    assert.equal(classifyCheckinReply(reply), 'help_requested', reply);
  }
  for (const reply of ["I'm not having a seizure", 'I had a seizure yesterday', 'He is having a seizure',
    'If I am having a seizure call Maya', 'Am I having a seizure?', 'The TV said I am having a seizure',
    '“I am having a seizure”', 'I think I might be having a seizure', 'I am having a seizure but never mind']) {
    assert.equal(reportsCurrentSeizure(reply), false, reply);
    assert.equal(classifyCheckinReply(reply), 'unresolved', reply);
  }
});
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
    assert.throws(() => c.recordCheckinReply({ ...reply, source: 'model' } as unknown as CheckinReply), /device transcript/);
    assert.throws(() => c.recordCheckinReply({ ...reply, transcript: 'x'.repeat(501) }), /1–500/);
    assert.equal(c.events(i.id).some(e => e.type === 'CHECKIN_REPLY'), false);
    now = i.checkinDeadline;
    assert.throws(() => c.recordCheckinReply(reply), /before its deadline/);
    assert.throws(() => c.cancel(i.id, i.checkinId), /current unresolved check-in/);
    c.tick(); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
  } finally { c.close(); }
});

test('first-person inability to stand or get up requests help without turning pain alone into a clinical judgment', () => {
  for (const reply of ['I fell pretty hard. My ankle hurts and I can’t stand up.',
    'I cannot get up right now.', 'I can’t stand.', 'My legs hurt. I cannot stand up.'])
    assert.equal(classifyCheckinReply(reply), 'help_requested', reply);
  for (const reply of ['My ankle hurts.', 'My friend cannot stand up.', 'He said I cannot get up.',
    'The TV says “I can’t stand up.”', "'I cannot get up'", 'Can you help if I cannot get up?',
    'I cannot stand up?', 'If I cannot get up I will call someone.',
    "I can't stand this music.", "I can't get up but I don't need help.", "I don't think I can't stand up."])
    assert.equal(classifyCheckinReply(reply), 'unresolved', reply);
  assert.equal(classifyCheckinReply("I'm okay."), 'confirmation_required');
});

test('the supplied physical distress statement promptly escalates a current FREE-WILi check-in', () => {
  const c = new Controller(':memory:', [{ id: 'maya', name: 'Maya', phone: null }], () => 1000);
  try {
    const i = c.trigger({ kind: 'synthetic', summary: 'Offline board speech fixture.' });
    const transcript = 'I fell pretty hard. My ankle hurts and I can’t stand up.';
    assert.equal(c.recordCheckinReply({ incidentId: i.id, checkinId: i.checkinId,
      transcript, source: 'freewili-local-speech' }), 'help_requested');
    assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    assert.equal(c.active()?.ownerId, null);
    assert.equal(c.actions(i.id).filter(a => a.type === 'alert').length, 1);
    const firstAlert = c.actions(i.id).find(a => a.type === 'alert')!;
    assert.ok(firstAlert.text.includes(`“${transcript}”`),
      'the urgent alert carries exact distress before clinical inference finishes');
    const report = c.conversation(i.id).find(message => message.speaker === 'wearer')!;
    c.setHandoff(i.id, `Wearer report: “${transcript}” [conversation:${report.id}]\nSynthetic record context.`);
    const updatedAlert = c.actions(i.id).find(a => a.type === 'alert')!;
    assert.equal(updatedAlert.text.split(transcript).length - 1, 1,
      'a refreshed, cited handoff includes the report once in the alert');
    const event = c.events(i.id).findLast(e => e.type === 'CHECKIN_REPLY')!;
    assert.equal(event.actor, 'freewili-local-speech');
    assert.deepEqual(JSON.parse(event.detail), { transcript, decision: 'help_requested' });
  } finally { c.close(); }
});
