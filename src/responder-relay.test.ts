import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from './controller.ts';
import { handleResponderRelay } from './responder-relay.ts';
import { handleResponderQuestion } from './responder-questions.ts';
import type { ProviderInbound } from './contracts.ts';

const responders = [{ id: 'maya', name: 'Maya', phone: '+12025550101' }, { id: 'jordan', name: 'Jordan', phone: '+12025550102' }];
function setup() {
  const c = new Controller(':memory:', responders, () => 1000);
  const i = c.trigger({ kind: 'manual', summary: 'Offline relay fixture.' });
  for (const a of c.actions(i.id).filter(a => a.type === 'alert'))
    c.finishAction(a.id, 'provider_accepted', 'Offline native fixture.', `alert-${a.recipientId}`,
      { chatId: `dm-${a.recipientId}`, lineId: 'shared' });
  return { c, i };
}
function incoming(text: string, overrides: Partial<ProviderInbound> = {}): ProviderInbound {
  return { messageId: `inbound-${text}`, kind: 'text', sender: responders[0].phone,
    chatId: 'dm-maya', lineId: 'shared', providerTimestamp: 999, text, ...overrides };
}

test('natural untargeted human reply is recorded once without accepting or advancing the incident', () => {
  const { c, i } = setup();
  try {
    const before = c.active(); const actions = c.actions(i.id);
    const event = incoming('I’m coming downstairs now. Don’t try to stand.');
    assert.equal(handleResponderRelay(event, c), true);
    assert.equal(c.seenInbound(event.messageId), true);
    assert.equal(c.conversation(i.id).length, 1);
    const message = c.conversation(i.id)[0];
    assert.equal(message.speaker, 'responder'); assert.equal(message.speakerName, 'Maya');
    assert.equal(message.text, event.text); assert.equal(message.source, 'photon-imessage');
    assert.equal(message.at, 1000); assert.equal(message.delivery, 'recorded', 'care-team text is not spoken to the patient');
    const audit = JSON.parse(c.events(i.id).findLast(e => e.type === 'CONVERSATION_MESSAGE')!.detail);
    assert.equal(audit.transcript, event.text); assert.equal(audit.providerTimestamp, 999);
    assert.deepEqual(c.active(), before, 'free text cannot change owner, phase, version, or deadline');
    assert.deepEqual(c.actions(i.id), actions, 'relay does not create an acknowledgement or progress message');
    assert.equal(handleResponderRelay(event, c), false);
    assert.equal(c.conversation(i.id).length, 1);
  } finally { c.close(); }
});

test('native targeted statements preserve an acknowledged owner without claiming departure', () => {
  const { c, i } = setup();
  try {
    c.accept(i.id, 'maya');
    const a = c.actions(i.id).findLast(a => a.type === 'status' && a.recipientId === 'maya')!;
    c.finishAction(a.id, 'provider_accepted', 'Offline status.', 'status-maya', { chatId: 'dm-maya', lineId: 'shared' });
    const before = c.active();
    assert.equal(handleResponderRelay(incoming('Stay where you are. I can hear you.', { targetMessageId: 'status-maya' }), c), true);
    assert.deepEqual(c.active(), before);
    assert.equal(c.active()?.phase, 'ACKNOWLEDGED');
  } finally { c.close(); }
});

test('direct wearer communication questions queue attributed speech without implying ownership or progress', () => {
  const { c, i } = setup();
  try {
    const before = c.active();
    for (const text of ['Wearer, I’m coming downstairs now. Can you hear me?', 'Are you there?', 'Did you hear me?',
      'Could you hear me clearly?', 'Can you hear me']) {
      assert.equal(handleResponderRelay(incoming(text, { targetMessageId: 'alert-maya' }), c), true, text);
      const speech = c.claimResponderSpeech('offline-board-session');
      assert.equal(speech?.speakerName, 'Maya');
      assert.equal(speech?.text, text);
      assert.equal(speech?.incidentId, i.id);
      assert.equal(c.recordResponderPlayback(speech!.id, i.id, 'offline-board-session', 'playing'), true);
      assert.equal(c.recordResponderPlayback(speech!.id, i.id, 'offline-board-session', 'spoken'), true);
      assert.deepEqual(c.active(), before, 'speech never accepts responsibility or confirms departure');
    }
    assert.equal(c.conversation(i.id).length, 5);
  } finally { c.close(); }
});

test('an accepted exact wearer quote is a valid native target for an attributed responder reply', () => {
  const c = new Controller(':memory:', responders, () => 1000);
  try {
    const i = c.trigger({ kind: 'synthetic', summary: 'Offline spoken check-in.' });
    c.recordCheckinReply({ incidentId: i.id, checkinId: i.checkinId,
      transcript: 'I cannot stand up.', source: 'freewili-local-speech' });
    const quote = c.actions(i.id).find(a => a.type === 'wearer_relay' && a.recipientId === 'maya')!;
    c.finishAction(quote.id, 'provider_accepted', 'Offline accepted wearer quote.', 'wearer-quote-maya',
      { chatId: 'dm-maya', lineId: 'shared' });
    assert.equal(handleResponderRelay(incoming('Stay where you are. I can hear you.', { targetMessageId: 'wearer-quote-maya' }), c), true);
    assert.equal(c.conversation(i.id).at(-1)?.speakerName, 'Maya');
    assert.equal(c.active()?.ownerId, null); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
  } finally { c.close(); }
});

test('wrong sender, channel, explicit target, removal, malformed input and command text are rejected', () => {
  const { c, i } = setup();
  try {
    const invalid: Partial<ProviderInbound>[] = [
      { sender: '+12025550999' }, { sender: 'maya@example.test' }, { chatId: 'other-chat' }, { lineId: 'other-line' },
      { chatId: undefined }, { lineId: undefined }, { targetMessageId: 'missing' }, { targetMessageId: '' },
      { targetMessageId: 'alert-jordan' }, { removed: true }, { kind: 'reaction', reaction: '👍' },
      { messageId: '' }, { messageId: 'x'.repeat(501) }, { text: '' }, { text: ' ' }, { text: 'x'.repeat(501) },
      { text: 'I am here.\u0000' }, { text: 'ON IT.' }, { text: `DEPART ${i.id}` }, { text: 'ARRIVED' }, { text: 'DECLINE' },
      { text: 'RESOLVED: Person is with a friend.' }, { text: `${i.id} I am coming.` },
      { text: 'I am coming for LF-OLD00000.' },
    ];
    for (let n = 0; n < invalid.length; n++) {
      const event = incoming('I am coming downstairs.', { messageId: `invalid-${n}`, ...invalid[n] });
      assert.equal(handleResponderRelay(event, c), false, JSON.stringify(invalid[n]));
      assert.equal(c.seenInbound(event.messageId), false);
    }
    assert.equal(c.active()?.phase, 'HELP_REQUESTED'); assert.equal(c.active()?.ownerId, null);
  } finally { c.close(); }
});

test('an explicit unaccepted target and an accepted status without an accepted alert cannot authorize untargeted relay', () => {
  const { c, i } = setup();
  try {
    const alert = c.actions(i.id).find(a => a.type === 'alert' && a.recipientId === 'maya')!;
    c.finishAction(alert.id, 'unknown', 'Offline unknown outcome.', 'unknown-alert', { chatId: 'dm-maya', lineId: 'shared' });
    c.accept(i.id, 'maya');
    const status = c.actions(i.id).findLast(a => a.type === 'status' && a.recipientId === 'maya')!;
    c.finishAction(status.id, 'provider_accepted', 'Offline status.', 'status-maya', { chatId: 'dm-maya', lineId: 'shared' });
    assert.equal(c.matchesConversation(incoming('I am nearby.'), 'maya'), true);
    assert.equal(handleResponderRelay(incoming('I am nearby.', { targetMessageId: 'unknown-alert' }), c), false);
    assert.equal(handleResponderRelay(incoming('I am nearby.'), c), false);
    assert.equal(handleResponderRelay(incoming('I am nearby.', { targetMessageId: 'status-maya' }), c), true);
  } finally { c.close(); }
});

test('old incident targets cannot fall back to a current code and terminal incidents reject all relay', () => {
  const { c, i } = setup();
  try {
    c.reset();
    assert.equal(handleResponderRelay(incoming('I am nearby.'), c), false);
    const next = c.trigger({ kind: 'manual', summary: 'Second offline incident.' });
    const alert = c.actions(next.id).find(a => a.type === 'alert' && a.recipientId === 'maya')!;
    c.finishAction(alert.id, 'provider_accepted', 'Offline second alert.', 'new-alert', { chatId: 'dm-maya', lineId: 'shared' });
    assert.notEqual(next.id, i.id);
    assert.equal(handleResponderRelay(incoming(`I am nearby for ${next.id}.`, { targetMessageId: 'alert-maya' }), c), false);
    assert.equal(handleResponderRelay(incoming(`I am nearby for ${i.id}.`, { targetMessageId: 'new-alert' }), c), false);
  } finally { c.close(); }
});

test('medical questions and requests remain available to grounded Q&A instead of becoming human relay', async () => {
  const { c } = setup();
  try {
    for (const question of ['Which allergies are recorded?', 'What medications are recorded', 'Please list the medications',
      'Allergies', 'Any allergies to note', 'Medication list please',
      'Can you hear me? What allergies are recorded?', 'Please list the medications. Can you hear me?',
      'I’m coming downstairs now. Please list the allergies.', 'Are you there? What is the incident status?']) {
      const event = incoming(question, { targetMessageId: 'alert-maya' });
      assert.equal(handleResponderRelay(event, c), false, question);
      let generated = false;
      assert.equal(await handleResponderQuestion(event, c, async () => { generated = true; return 'Offline grounded answer.'; }), true);
      assert.equal(generated, true);
    }
  } finally { c.close(); }
});
