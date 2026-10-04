import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller.ts';
import { handleResponderRelay } from './responder-relay.ts';
import type { ProviderInbound } from './contracts.ts';

const responders = [{ id: 'maya', name: 'Maya', phone: '+12025550101' }];
const wearerText = "I fell pretty hard. My ankle hurts and I can't stand up.";
const responderText = 'Tazeem, I’m coming downstairs now. Don’t try to stand.';
function setup(path = ':memory:') {
  let now = 1000;
  const c = new Controller(path, responders, () => now, { checkinMs: 20000, acceptMs: 60000, progressMs: 120000 }, { wearerName: 'Tazeem' });
  const i = c.active() ?? c.trigger({ kind: 'synthetic', summary: 'Offline conversation rehearsal.' });
  if (i.phase === 'CONFIRMING') c.recordCheckinReply({ incidentId: i.id, checkinId: i.checkinId, transcript: wearerText, source: 'freewili-local-speech' });
  const chatId = 'any;-;+12025550101';
  const alert = c.actions(i.id).find(a => a.type === 'alert')!;
  c.finishAction(alert.id, 'provider_accepted', 'Offline accepted fixture.', 'alert-maya', { chatId, lineId: 'shared' });
  const event: ProviderInbound = { messageId: 'incoming-maya', sender: responders[0].phone, kind: 'text', text: responderText, chatId, lineId: 'shared' };
  return { c, i, event, advance: (ms: number) => { now += ms; } };
}

test('spoken injury report is forwarded literally, without waiting for a clinical summary', () => {
  const { c, i } = setup();
  try {
    assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    const wearer = c.conversation(i.id)[0];
    assert.equal(wearer.text, wearerText);
    assert.equal(wearer.speakerName, 'Tazeem');
    assert.equal(wearer.source, 'freewili-local-speech');
    const relay = c.actions(i.id).find(a => a.type === 'wearer_relay')!;
    assert.equal(relay.text, `Tazeem: “${wearerText}”`);
    assert.equal(relay.recipientId, 'maya');
    assert.equal(c.actionPermitted(relay), true);
    c.accept(i.id, 'maya');
    assert.equal(c.actions(i.id).find(a => a.id === relay.id)?.status, 'queued', 'acceptance cannot discard the wearer’s report');
  } finally { c.close(); }
});

test('paced outbox prioritizes conversation and answers over routine updates without resending uncertain messages', () => {
  const { c, i } = setup();
  try {
    const quote = c.claimAction('any', true)!;
    assert.equal(quote.type, 'wearer_relay', 'an accepted alert is followed by the wearer’s actual report');
    c.finishAction(quote.id, 'unknown', 'Offline fixture: uncertain submission must not be repeated.');
    c.setHandoff(i.id, 'Updated synthetic context, queued before the real answer.');
    assert.equal(c.queueAnswer(i.id, c.active()!.version, 'maya', 'new-medical-question', 'Recorded allergy context.'), true);
    const answer = c.claimAction('any', true)!;
    assert.equal(answer.type, 'answer', 'a current question takes precedence over earlier routine context/status sends');
    c.finishAction(answer.id, 'provider_accepted', 'Offline fixture accepted.', 'answer-message');
    const context = c.claimAction('any', true)!;
    assert.equal(context.type, 'handoff');
    assert.notEqual(context.id, quote.id);
    c.reset();
    assert.equal(c.claimAction('any', true), null, 'pacing cannot submit stale work after an incident ends');
    assert.equal(c.actions(i.id).find(action => action.id === quote.id)?.status, 'unknown');
  } finally { c.close(); }
});

test('natural responder reply is bound, attributed and spoken once without changing responsibility', () => {
  const { c, i, event } = setup();
  try {
    const before = c.active()!;
    assert.equal(handleResponderRelay(event, c), true);
    assert.equal(handleResponderRelay(event, c), false);
    const reply = c.conversation(i.id).at(-1)!;
    assert.equal(reply.text, responderText); assert.equal(reply.speakerName, 'Maya');
    assert.equal(reply.delivery, 'queued'); assert.equal(c.active()?.ownerId, null);
    assert.equal(c.active()?.version, before.version); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    assert.equal(c.recordResponderPlayback(reply.id, i.id, 'unclaimed', 'spoken'), false);
    const speech = c.claimResponderSpeech('device-session')!;
    assert.equal(speech.id, reply.id); assert.equal(c.claimResponderSpeech('device-session'), null);
    assert.equal(c.recordResponderPlayback(reply.id, i.id, 'other-session', 'playing'), false);
    assert.equal(c.recordResponderPlayback(reply.id, i.id, 'device-session', 'spoken'), false);
    assert.equal(c.recordResponderPlayback(reply.id, i.id, 'device-session', 'queued'), true);
    assert.equal(c.recordResponderPlayback(reply.id, i.id, 'device-session', 'playing'), true);
    assert.equal(c.recordResponderPlayback(reply.id, i.id, 'device-session', 'spoken'), true);
    assert.equal(c.recordResponderPlayback(reply.id, i.id, 'device-session', 'playing'), false);
    assert.equal(c.claimResponderSpeech('reconnected-device'), null);
    assert.equal(c.conversation(i.id).at(-1)?.delivery, 'spoken');
  } finally { c.close(); }
});

test('controller independently refuses wrong sender, missing authorization, stale target and replay', () => {
  const { c, i, event } = setup();
  try {
    for (const extra of [{ sender: '+12025550999' }, { chatId: 'other' }, { lineId: 'other' },
      { targetMessageId: 'old-alert' }, { targetMessageId: '' }, { removed: true }, { text: 'bad\u0000reply' }])
      assert.equal(c.recordResponderRelay({ ...event, ...extra }, 'maya'), false);
    assert.equal(c.conversation(i.id).length, 1);
    assert.equal(c.recordResponderRelay(event, 'maya'), true);
    assert.equal(c.recordResponderRelay(event, 'maya'), false);
  } finally { c.close(); }
});

test('wearable disconnect and terminal reset preserve the words without replaying uncertain audio', () => {
  const { c, i, event } = setup();
  try {
    assert.equal(c.recordResponderRelay(event, 'maya'), true);
    const first = c.claimResponderSpeech('device-one')!;
    c.failResponderSpeechSession('device-one');
    assert.equal(c.conversation(i.id).at(-1)?.delivery, 'failed');
    assert.equal(c.claimResponderSpeech('device-two'), null);
    assert.equal(c.recordResponderRelay({ ...event, messageId: 'another-message' }, 'maya'), true);
    const second = c.claimResponderSpeech('device-two')!;
    c.reset();
    assert.equal(c.recordResponderPlayback(second.id, i.id, 'device-two', 'spoken'), false);
    assert.equal(c.conversation(i.id).at(-1)?.delivery, 'failed');
    assert.equal(c.conversation(i.id)[1].text, responderText);
    assert.equal(c.recordResponderPlayback(first.id, i.id, 'device-one', 'playing'), false);
  } finally { c.close(); }
});

test('restart recovers an unsent reply but never replays a dispatched one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-conversation-'));
  let c: Controller | null = null;
  try {
    const path = join(dir, 'state.sqlite'); const fixture = setup(path); c = fixture.c;
    assert.equal(c.recordResponderRelay(fixture.event, 'maya'), true);
    c.close(); c = null;
    c = new Controller(path, responders, () => 1000);
    assert.ok(c.claimResponderSpeech('device-before-restart'));
    c.close(); c = null;
    c = new Controller(path, responders, () => 1000);
    assert.equal(c.conversation(fixture.i.id).at(-1)?.text, responderText);
    assert.equal(c.conversation(fixture.i.id).at(-1)?.delivery, 'failed');
    assert.equal(c.claimResponderSpeech('device-after-restart'), null);
  } finally { c?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an old queued reply expires instead of speaking after a delayed reconnect', () => {
  const { c, i, event, advance } = setup();
  try {
    assert.equal(c.recordResponderRelay(event, 'maya'), true); advance(120001);
    assert.equal(c.claimResponderSpeech('late-device'), null);
    assert.equal(c.conversation(i.id).at(-1)?.delivery, 'failed');
  } finally { c.close(); }
});
