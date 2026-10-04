import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wellbeing } from './wellbeing.ts';
import { Controller } from './controller.ts';
import type { ProviderInbound } from './contracts.ts';

const phone = '+12025550100';
const chatId = `any;-;${phone}`, lineId = 'shared';
function setup(path = ':memory:', options: Partial<ConstructorParameters<typeof Wellbeing>[1]> = {}) {
  let at = Date.parse('2026-10-03T18:00:00Z');
  const w = new Wellbeing(path, { phone, wearerName: 'Tazeem', ...options }, () => at);
  return { w, set: (date: string) => { at = Date.parse(date); } };
}
function accepted(w: Wellbeing, messageId = 'private-provider-message') {
  assert.equal(w.queueDailyCheckin(), true);
  const action = w.claimAction()!; assert.ok(action); assert.equal(action.attempts, 1);
  w.finishAction(action.id, 'provider_accepted', 'Offline acceptance only, not delivery.', messageId, { chatId, lineId });
  return action;
}
function incoming(extra: Partial<ProviderInbound> = {}): ProviderInbound {
  return { messageId: 'private-inbound-message', sender: phone, kind: 'text', text: 'I feel a little lonely today.', chatId, lineId, ...extra };
}
function voice(w: Wellbeing, eventId: string, transcript = 'I would like to talk.') {
  return w.recordVoice({ eventId, conversationId: w.conversationId, transcript, sessionId: 'offline-board-session' });
}

test('local daily scheduling respects timezone, due hour, six-hour window and one prompt per date', () => {
  const { w, set } = setup();
  try {
    set('2026-10-03T17:59:59Z'); w.tick(false); assert.equal(w.view().lastCheckinDate, null);
    set('2026-10-03T18:00:00Z'); w.tick(false);
    assert.equal(w.view().lastCheckinDate, '2026-10-03'); assert.equal(w.view().schedule.hour, 14);
    for (let n = 0; n < 10; n++) w.tick(false);
    assert.equal(w.view().messages.length, 1); assert.equal(w.view().messages[0].source, 'daily-checkin');
    assert.equal(w.view().messages[0].text, 'Hi Tazeem, how are you feeling today? Reply here, or hold the blue button on WILi, speak, and release.');
    set('2026-10-04T00:00:00Z'); w.tick(false); assert.equal(w.claimAction(), null, '20:00 local is outside the six-hour window');
    assert.equal(w.view().messages[0].delivery, 'cancelled');
    set('2026-10-04T18:00:00Z'); w.tick(false);
    assert.equal(w.view().lastCheckinDate, '2026-10-04'); assert.equal(w.view().messages.length, 2, 'unanswered yesterday never suppresses today');
  } finally { w.close(); }
});

test('DST and configured timezone determine the local due time without UTC-hour assumptions', () => {
  const { w, set } = setup();
  const utc = setup(':memory:', { timezone: 'UTC' });
  try {
    set('2026-11-01T18:59:00Z'); w.tick(false); assert.equal(w.view().lastCheckinDate, null);
    set('2026-11-01T19:00:00Z'); w.tick(false); assert.equal(w.view().lastCheckinDate, '2026-11-01');
    utc.set('2026-10-03T14:00:00Z'); utc.w.tick(false); assert.equal(utc.w.view().lastCheckinDate, '2026-10-03');
    assert.equal(utc.w.view().schedule.timeZone, 'UTC');
  } finally { w.close(); utc.w.close(); }
});

test('blocked scheduling can resume inside the window but does not catch up at night', () => {
  const { w, set } = setup();
  try {
    w.tick(true); assert.equal(w.claimAction(), null);
    set('2026-10-03T21:00:00Z'); w.tick(false); const action = w.claimAction()!;
    assert.ok(action); assert.equal(w.actionPermitted(action, true), false); assert.equal(w.actionPermitted(action, false), true);
    w.finishAction(action.id, 'cancelled', 'An incident interrupted preparation.');
    set('2026-10-05T01:00:00Z'); w.tick(false); assert.equal(w.view().messages.length, 1);
  } finally { w.close(); }
});

test('explicit same-date check-in works outside the schedule, dedupes, and expires on date change', () => {
  const { w, set } = setup();
  try {
    set('2026-10-04T02:00:00Z'); w.tick(false); assert.equal(w.view().messages.length, 0);
    assert.equal(w.queueDailyCheckin(), true); assert.equal(w.queueDailyCheckin(), false);
    const action = w.claimAction()!; assert.ok(action); assert.equal(w.actionPermitted(action, false), true);
    set('2026-10-04T04:00:00Z'); assert.equal(w.actionPermitted(action, false), false);
    assert.equal(w.view().messages[0].delivery, 'cancelled');
    assert.equal(w.queueDailyCheckin(), true, 'next local date has an independent explicit prompt');
  } finally { w.close(); }
});

test('persistent daily dedupe and interrupted submissions survive restart without retrying unknown or failed actions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-wellbeing-')), path = join(directory, 'state.sqlite');
  let w = setup(path).w;
  try {
    const id = w.conversationId; w.tick(false); const action = w.claimAction()!; w.close();
    w = setup(path).w; assert.equal(w.conversationId, id); assert.equal(w.queueDailyCheckin(), false);
    assert.equal(w.view().messages[0].delivery, 'unknown'); assert.equal(w.claimAction(), null);
    w.finishAction(action.id, 'failed', 'Cannot rewrite an unknown outcome.'); assert.equal(w.view().messages[0].delivery, 'unknown');
    assert.equal(voice(w, 'voice-before-failed'), true); const pending = w.replyNeeded()!;
    assert.equal(w.queueReply(pending.id, 'Thanks for sharing.', 'degraded'), true);
    const reply = w.claimAction()!; w.finishAction(reply.id, 'failed', 'Definite offline failure.');
    assert.equal(w.claimAction(), null); w.close(); w = setup(path).w;
    assert.equal(w.claimAction(), null); assert.equal(w.view().messages.at(-1)!.delivery, 'failed');
  } finally { w.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('phone input requires accepted exact wearer conversation and explicit targets never fall back', () => {
  const { w } = setup();
  try {
    assert.equal(w.recordText(incoming()), false); accepted(w);
    for (const extra of [{ sender: '+12025550999' }, { sender: 'person@example.com' }, { chatId: 'wrong-chat' }, { lineId: 'wrong-line' },
      { targetMessageId: 'stale-message' }, { targetMessageId: '' }, { kind: 'reaction' as const }, { removed: true }, { text: 'bad\u0000text' }, { text: 'x'.repeat(501) }])
      assert.equal(w.recordText(incoming(extra)), false);
    assert.equal(w.recordText(incoming({ targetMessageId: 'private-provider-message' })), true);
    assert.equal(w.recordText(incoming({ text: 'Changed duplicate.' })), false);
    const pending = w.replyNeeded()!;
    assert.equal(pending.source, 'photon-imessage'); assert.equal(pending.replyToMessageId, 'private-inbound-message');
    assert.equal(pending.replyChatId, chatId); assert.equal(pending.replyLineId, lineId);
    assert.notEqual(pending.id, 'private-inbound-message');
    const view = JSON.stringify(w.view());
    for (const secret of ['private-provider-message', 'private-inbound-message', chatId, 'providerMessageId', 'replyToMessageId']) assert.ok(!view.includes(secret));
  } finally { w.close(); }
});

test('unknown, missing native identity and changed approved phone cannot authorize phone replies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-wellbeing-binding-')), path = join(directory, 'state.sqlite');
  let w = setup(path).w;
  try {
    accepted(w); w.close(); w = setup(path, { phone: '+12025550200' }).w;
    assert.equal(w.recordText(incoming()), false);
    assert.equal(w.recordText(incoming({ sender: '+12025550200' })), false);
  } finally { w.close(); rmSync(directory, { recursive: true, force: true }); }
  for (const status of ['unknown', 'provider_accepted'] as const) {
    const current = setup().w;
    try { current.queueDailyCheckin(); const action = current.claimAction()!;
      current.finishAction(action.id, status, 'No verified native channel.', status === 'provider_accepted' ? 'accepted-id' : undefined);
      assert.equal(current.recordText(incoming()), false);
    } finally { current.close(); }
  }
});

test('voice starts before any daily text and retains microphone provenance without Photon identity or safety authority', () => {
  const c = new Controller(':memory:', []), { w } = setup();
  try {
    assert.equal(w.recordVoice({ eventId: 'voice', conversationId: 'other-conversation', transcript: 'Hello', sessionId: 'board' }), false);
    assert.equal(voice(w, 'voice', 'I feel lonely.'), true); assert.equal(voice(w, 'voice'), false);
    const pending = w.replyNeeded()!; assert.equal(pending.source, 'freewili-local-speech'); assert.equal(pending.replyToMessageId, undefined);
    assert.equal(w.queueReply(pending.id, 'Would you like to talk about your day?', 'degraded'), true);
    assert.equal(w.view().messages.at(-1)!.source, 'agent'); assert.equal(w.view().messages.at(-1)!.generation, 'degraded');
    assert.equal(c.active(), null); assert.equal(w.view().lastCheckinDate, null);
  } finally { w.close(); c.close(); }
});

test('new wearer input supersedes stale async replies, queued replies and duplicates without hiding earlier words', () => {
  const { w } = setup();
  try {
    voice(w, 'first', 'First thought.'); const first = w.replyNeeded()!;
    voice(w, 'second', 'Second thought.'); const second = w.replyNeeded()!;
    assert.equal(w.queueReply(first.id, 'Stale result.', 'ai'), false);
    assert.equal(w.queueReply(second.id, 'I hear you. What is on your mind?', 'ai'), true);
    assert.equal(w.queueReply(second.id, 'Duplicate.', 'degraded'), false);
    voice(w, 'third', 'Third thought.');
    assert.equal(w.view().messages.find(message => message.text.startsWith('I hear you.'))!.delivery, 'cancelled');
    assert.equal(w.claimAction(), null);
    const third = w.replyNeeded()!; assert.notEqual(third.id, second.id);
    assert.equal(w.queueReply(third.id, 'What happened? How did it feel?', 'ai'), false, 'one follow-up question at most');
    assert.equal(w.queueReply(third.id, 'Thanks for sharing.', 'degraded'), true);
    const reply = w.claimAction()!; assert.equal(reply.type, 'reply');
    assert.equal(reply.replyToMessageId, undefined, 'a voice source is never forged as an inbound phone message');
    assert.ok(w.view().messages.some(message => message.text === 'First thought.'));
  } finally { w.close(); }
});

test('new input during preparation blocks the old reply; actual post-submission outcomes remain truthful', () => {
  const { w } = setup();
  try {
    voice(w, 'old'); w.queueReply(w.replyNeeded()!.id, 'Earlier answer.', 'ai'); const action = w.claimAction()!;
    voice(w, 'new'); assert.equal(w.actionPermitted(action, false), false);
    w.finishAction(action.id, 'provider_accepted', 'Remote result returned after newer input.', 'actual-late-id', { chatId, lineId });
    assert.equal(w.view().messages.find(message => message.text === 'Earlier answer.')!.delivery, 'provider_accepted');
    assert.equal(w.replyNeeded()!.text, 'I would like to talk.');
  } finally { w.close(); }
});

test('wellbeing shares the incident database without altering incident phase or creating safety events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-wellbeing-shared-')), path = join(directory, 'state.sqlite');
  const c = new Controller(path, []), w = setup(path).w;
  try {
    const i = c.trigger({ kind: 'synthetic', summary: 'Offline independent incident.' }); const before = JSON.stringify(c.active());
    w.tick(true); assert.equal(w.queueDailyCheckin(), true, 'root authorizes explicit demo requests separately');
    const action = w.claimAction()!; assert.equal(w.actionPermitted(action, true), false);
    voice(w, 'separate', 'I am lonely.'); assert.equal(w.queueReply(w.replyNeeded()!.id, 'Would you like to talk?', 'degraded'), true);
    assert.equal(JSON.stringify(c.active()), before); assert.equal(c.events(i.id).length, 2);
  } finally { w.close(); c.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('disabled or unconfigured wellbeing refuses scheduling and input rather than exposing a nonfunctional recording flow', () => {
  for (const options of [{ enabled: false }, { phone: null }]) {
    const { w } = setup(':memory:', options);
    try { w.tick(false); assert.equal(w.queueDailyCheckin(), false); assert.equal(voice(w, 'disabled'), false);
      assert.equal(w.recordText(incoming()), false); assert.equal(w.replyNeeded(), null); assert.equal(w.view().pendingCount, 0);
      assert.equal(w.view().enabled, false);
    } finally { w.close(); }
  }
});

test('explicit incident routing marks an authenticated wearer message handled without wellbeing changing policy', () => {
  const { w } = setup();
  try {
    assert.equal(voice(w, 'help-message', 'I need help.'), true);
    const pending = w.replyNeeded()!; w.markIncidentRouted('unknown-id'); assert.equal(w.replyNeeded()!.id, pending.id);
    w.markIncidentRouted(pending.id); assert.equal(w.replyNeeded(), null);
    assert.equal(w.queueReply(pending.id, 'Routine reply after resolution.', 'ai'), false);
    assert.equal(w.view().messages[0].text, 'I need help.');
    assert.equal(voice(w, 'new-conversation-message', 'I would like to chat now.'), true); assert.ok(w.replyNeeded());
  } finally { w.close(); }
});
