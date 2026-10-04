import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller.ts';
import type { Action, Responder } from './contracts.ts';
import { SimulatedDispatch } from './simulated-dispatch.ts';
import type { SimulatedDispatchOptions } from './simulated-dispatch.ts';

const start = Date.parse('2026-10-04T12:00:00Z');
const maya: Responder = { id: 'demo-maya', name: 'Maya', phone: null, simulated: true };
const policy = { checkinMs: 20_000, acceptMs: 60_000, progressMs: 120_000 };
function fixture(options: SimulatedDispatchOptions = {}, path = ':memory:', responders = [maya]) {
  let at = start;
  const now = () => at;
  const make = () => new Controller(path, responders, now, policy, { wearerName: 'Demo wearer', dispatchMode: 'simulated' });
  let controller = make(), simulator = new SimulatedDispatch(controller, { ...options, now });
  return { get c() { return controller; }, get s() { return simulator; },
    advance(ms: number) { at += ms; }, now,
    restart() { controller.close(); controller = make(); simulator = new SimulatedDispatch(controller, { ...options, now }); },
    close() { controller.close(); } };
}
function speechCompleted(c: Controller, id: string): void {
  for (let count = 0; count < 10; count++) {
    const message = c.claimResponderSpeech('offline-playback-test');
    if (!message) return;
    assert.equal(c.recordResponderPlayback(message.id, id, 'offline-playback-test', 'playing'), true);
    assert.equal(c.recordResponderPlayback(message.id, id, 'offline-playback-test', 'spoken'), true);
  }
  throw new Error('Unexpected unbounded test speech queue.');
}

test('fake clock drives the whole incident loop autonomously, with simulated actions and explicit source labels', () => {
  const f = fixture();
  try {
    const i = f.c.trigger({ kind: 'synthetic', summary: 'Offline staged-event algorithm fixture.' });
    f.s.tick(); assert.equal(f.c.active()!.phase, 'CONFIRMING');
    f.advance(20_000); f.c.tick(); f.s.tick();
    assert.equal(f.c.active()!.phase, 'HELP_REQUESTED');
    const alert = f.c.actions(i.id).find(a => a.type === 'alert')!;
    assert.equal(alert.status, 'simulated'); assert.equal(alert.attempts, 1);
    f.advance(3999); f.s.tick(); assert.equal(f.c.active()!.ownerId, null);
    f.advance(1); f.s.tick(); assert.equal(f.c.active()!.phase, 'ACKNOWLEDGED');
    assert.equal(f.c.active()!.ownerId, maya.id); speechCompleted(f.c, i.id);
    f.advance(7999); f.s.tick(); assert.equal(f.c.active()!.phase, 'ACKNOWLEDGED');
    f.advance(1); f.s.tick(); assert.equal(f.c.active()!.phase, 'RESPONDER_EN_ROUTE'); speechCompleted(f.c, i.id);
    f.advance(16_000); f.s.tick(); assert.equal(f.c.active()!.phase, 'ON_SCENE'); speechCompleted(f.c, i.id);
    f.advance(11_999); f.s.tick(); assert.equal(f.c.active()!.phase, 'ON_SCENE');
    f.advance(1); f.s.tick(); assert.equal(f.c.active(), null); assert.equal(f.c.latest()!.phase, 'RESOLVED');
    assert.equal(f.c.latest()!.resolutionActor, `simulated-dispatch:${maya.id}`);
    assert.match(f.c.latest()!.outcome!, /reached the patient/);
    assert.match(f.c.latest()!.outcome!, /arranging further assistance\./);
    f.s.tick();
    const responderActions = f.c.actions(i.id).filter(a => a.recipientId);
    assert.ok(responderActions.every(a => ['simulated', 'cancelled'].includes(a.status)));
    assert.ok(responderActions.filter(a => a.status === 'simulated').every(a => a.providerResult?.includes('No responder message was sent')));
    assert.ok(f.c.actions(i.id).every(a => a.providerMessageId === null && a.providerChatId === undefined && a.providerLineId === undefined));
    assert.ok(f.c.conversation(i.id).every(message => message.source === 'simulated-dispatch'));
    assert.deepEqual(f.c.events(i.id).filter(e => ['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED'].includes(e.type))
      .map(e => e.actor), Array(4).fill(`simulated-dispatch:${maya.id}`));
  } finally { f.close(); }
});

test('simulation leaves live dispatch and the confirming/cancelled check-in untouched', () => {
  const live = new Controller(':memory:', [{ id: 'human', name: 'Human', phone: null }], () => start);
  const f = fixture({ acceptMs: 0 });
  try {
    const liveIncident = live.trigger({ kind: 'manual', summary: 'Offline live-mode guard fixture.' });
    const before = JSON.stringify([live.active(), live.actions(liveIncident.id), live.events(liveIncident.id)]);
    new SimulatedDispatch(live, { now: () => start + 100_000, acceptMs: 0 }).tick();
    assert.equal(JSON.stringify([live.active(), live.actions(liveIncident.id), live.events(liveIncident.id)]), before);
    const i = f.c.trigger({ kind: 'synthetic', summary: 'Offline cancellation fixture.' });
    const actions = JSON.stringify(f.c.actions(i.id)); f.s.tick();
    assert.equal(JSON.stringify(f.c.actions(i.id)), actions); assert.equal(f.c.active()!.ownerId, null);
    f.c.cancel(i.id, i.checkinId); const events = f.c.events(i.id).length;
    f.advance(100_000); f.s.tick(); assert.equal(f.c.latest()!.phase, 'CANCELLED_FALSE_ALARM');
    assert.equal(f.c.events(i.id).length, events); assert.equal(f.c.conversation(i.id).length, 0);
  } finally { live.close(); f.close(); }
});

test('acceptance requires a locally delivered alert; an unknown action is never converted into fake delivery', () => {
  const f = fixture({ acceptMs: 0 });
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline unknown-action guard.' });
    const alert = f.c.claimAction('responders', true, i.id)!;
    assert.equal(alert.type, 'alert');
    assert.throws(() => f.c.simulateResponder(i.id, maya.id, 'accept'), /first receive the incident alert/);
    assert.throws(() => f.c.finishAction(alert.id, 'unknown', 'Offline fixture.'), /provider receipts/);
    // Prior-version uncertainty is an isolated persisted fixture, never a fabricated SDK response.
    alert.status = 'unknown'; alert.providerResult = 'Offline persisted uncertainty; no external send occurred.';
    f.c.db.prepare('UPDATE actions SET status=?,body=? WHERE id=?').run(alert.status, JSON.stringify(alert), alert.id);
    f.s.tick(); assert.equal(f.c.active()!.phase, 'HELP_REQUESTED'); assert.equal(f.c.active()!.ownerId, null);
    assert.equal(f.c.actions(i.id).find(a => a.id === alert.id)!.status, 'unknown');
    assert.equal(f.c.conversation(i.id).length, 0);
  } finally { f.close(); }
});

test('only one phase progresses per tick even when every configured delay is zero', () => {
  const f = fixture({ acceptMs: 0, departMs: 0, arriveMs: 0, resolveMs: 0 });
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline zero-delay fixture.' });
    for (const expected of ['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED']) {
      f.s.tick(); assert.equal(f.c.latest()!.phase, expected); if (f.c.active()) speechCompleted(f.c, i.id);
    }
    const events = f.c.events(i.id).length, conversation = JSON.stringify(f.c.conversation(i.id));
    for (let n = 0; n < 5; n++) f.s.tick();
    assert.equal(f.c.events(i.id).length, events); assert.equal(JSON.stringify(f.c.conversation(i.id)), conversation);
  } finally { f.close(); }
});

test('resolution waits for queued and playing speech, then proceeds when completion is recorded', () => {
  const f = fixture({ acceptMs: 0, departMs: 0, arriveMs: 0, resolveMs: 1000 });
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline speech completion fixture.' });
    f.s.tick(); f.s.tick(); f.s.tick();
    f.advance(1000); f.s.tick(); assert.equal(f.c.active()!.phase, 'ON_SCENE', 'queued patient-addressed speech holds resolution');
    const arrival = f.c.claimResponderSpeech('offline-arrival-playback')!;
    assert.equal(f.c.recordResponderPlayback(arrival.id, i.id, 'offline-arrival-playback', 'playing'), true);
    f.s.tick(); assert.equal(f.c.active()!.phase, 'ON_SCENE', 'playing speech also holds resolution');
    assert.equal(f.c.recordResponderPlayback(arrival.id, i.id, 'offline-arrival-playback', 'spoken'), true);
    f.s.tick(); assert.equal(f.c.latest()!.phase, 'RESOLVED');
    assert.equal(f.c.conversation(i.id).find(m => m.id === arrival.id)!.delivery, 'spoken');
  } finally { f.close(); }
});

test('missing wearable playback cannot stall the simulated outcome forever or falsely claim audibility', () => {
  const f = fixture({ acceptMs: 0, departMs: 0, arriveMs: 0, resolveMs: 1000 });
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline absent-speaker fixture.' });
    f.s.tick(); f.s.tick(); f.s.tick(); assert.equal(f.c.active()!.phase, 'ON_SCENE');
    f.advance(30_999); f.s.tick(); assert.equal(f.c.active()!.phase, 'ON_SCENE');
    f.advance(1); f.s.tick(); assert.equal(f.c.latest()!.phase, 'RESOLVED');
    const reports = f.c.conversation(i.id).filter(m => m.delivery !== 'recorded');
    assert.equal(reports.length, 1); assert.ok(reports.every(m => m.delivery === 'failed'));
    assert.ok(reports.every(m => m.detail?.includes('playback completion')));
    assert.ok(!f.c.conversation(i.id).some(m => m.delivery === 'spoken'));
  } finally { f.close(); }
});

test('phase delays and delivered alerts survive restart without duplicate ownership or reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-simulated-dispatch-')), f = fixture({}, join(dir, 'state.sqlite'));
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline persisted scheduler fixture.' }); f.s.tick();
    f.advance(2500); f.restart(); f.s.tick(); assert.equal(f.c.active()!.phase, 'HELP_REQUESTED');
    f.advance(1500); f.s.tick(); assert.equal(f.c.active()!.phase, 'ACKNOWLEDGED');
    f.advance(7999); f.restart(); f.s.tick(); assert.equal(f.c.active()!.phase, 'ACKNOWLEDGED');
    f.advance(1); f.s.tick(); assert.equal(f.c.active()!.phase, 'RESPONDER_EN_ROUTE');
    assert.equal(f.c.events(i.id).filter(e => e.type === 'ACKNOWLEDGED').length, 1);
    assert.equal(f.c.conversation(i.id).filter(m => m.text.includes('On it')).length, 1);
    assert.equal(f.c.actions(i.id).find(a => a.type === 'alert')!.attempts, 1);
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('interrupted local attempts recover without native evidence, while active mode changes are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-local-attempt-')), path = join(dir, 'state.sqlite'), f = fixture({ acceptMs: 0 }, path);
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline interrupted local action.' });
    const attempting = f.c.claimAction('responders', true, i.id)!; f.restart();
    assert.equal(f.c.actions(i.id).find(a => a.id === attempting.id)!.status, 'queued');
    f.s.tick(); assert.equal(f.c.active()!.phase, 'ACKNOWLEDGED');
    const action = f.c.actions(i.id).find(a => a.id === attempting.id)!;
    assert.equal(action.status, 'simulated'); assert.equal(action.providerMessageId, null);
    assert.throws(() => new Controller(path, [{ id: 'live', name: 'Live', phone: null }]), /changing dispatch mode/);
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a declined timed-out owner is not driven forward or automatically reaccepted', () => {
  const f = fixture({ acceptMs: 0 });
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline owner timeout fixture.' }); f.s.tick();
    assert.equal(f.c.active()!.ownerId, maya.id); f.advance(policy.progressMs); f.c.tick(); f.s.tick();
    assert.equal(f.c.active()!.phase, 'HELP_REQUESTED'); assert.equal(f.c.active()!.ownerId, null);
    assert.ok(f.c.active()!.declined.includes(maya.id)); f.advance(60_000); f.s.tick();
    assert.equal(f.c.active()!.ownerId, null);
    assert.equal(f.c.events(i.id).filter(e => e.type === 'ACKNOWLEDGED').length, 1);
  } finally { f.close(); }
});

test('phase progression follows the actual approved owner rather than assigning a different simulated responder', () => {
  const jordan: Responder = { id: 'demo-jordan', name: 'Jordan', phone: null, simulated: true };
  const f = fixture({ acceptMs: 0, departMs: 0 }, ':memory:', [maya, jordan]);
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline owner binding fixture.' });
    const alert = f.c.claimAction('responders', true, i.id)!; f.c.finishSimulatedAction(alert.id);
    const otherAlert = f.c.claimAction('responders', true, i.id)!; f.c.finishSimulatedAction(otherAlert.id);
    f.c.simulateResponder(i.id, jordan.id, 'accept'); f.s.tick();
    assert.equal(f.c.active()!.ownerId, jordan.id); assert.equal(f.c.active()!.phase, 'RESPONDER_EN_ROUTE');
    assert.equal(f.c.events(i.id).findLast(e => e.type === 'RESPONDER_EN_ROUTE')!.actor, `simulated-dispatch:${jordan.id}`);
    assert.ok(!f.c.events(i.id).some(e => e.type === 'ACKNOWLEDGED' && e.actor === `simulated-dispatch:${maya.id}`));
  } finally { f.close(); }
});

test('bounded drain handles only current incident actions and leaves old terminal notices intact', () => {
  const f = fixture();
  try {
    const prior = f.c.trigger({ kind: 'manual', summary: 'Offline prior incident fixture.' }); f.s.tick();
    f.c.simulateResponder(prior.id, maya.id, 'accept'); f.c.simulateResponder(prior.id, maya.id, 'arrive');
    f.c.simulateResponder(prior.id, maya.id, 'resolve');
    const priorNotices = JSON.stringify(f.c.actions(prior.id));
    const current = f.c.trigger({ kind: 'manual', summary: 'Offline bounded outbox fixture.' });
    const base = f.c.actions(current.id).find(a => a.type === 'alert')!;
    for (let n = 0; n < 40; n++) {
      const action: Action = { ...base, id: randomUUID(), type: 'handoff', text: `Offline synthetic outbox item ${n}.` };
      f.c.db.prepare('INSERT INTO actions VALUES(?,?,?,?,?,?,?)').run(action.id, action.incidentId, `${current.id}:offline:${n}`,
        action.status, action.nextAttemptAt, null, JSON.stringify(action));
    }
    f.s.tick(); assert.equal(f.c.actions(current.id).filter(a => a.status === 'simulated').length, 32);
    assert.equal(JSON.stringify(f.c.actions(prior.id)), priorNotices, 'the current drain does not claim a past incident’s status');
    f.s.tick(); assert.equal(f.c.actions(current.id).filter(a => a.status === 'simulated').length, 41);
    assert.equal(f.c.active()!.phase, 'HELP_REQUESTED');
  } finally { f.close(); }
});

test('invalid timing settings are rejected without starting timers or changing incidents', () => {
  const f = fixture();
  try {
    for (const ms of [-1, 0.5, NaN, Infinity, 300_001]) assert.throws(() => new SimulatedDispatch(f.c, { acceptMs: ms }), /delays/);
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline clock validation fixture.' });
    const s = new SimulatedDispatch(f.c, { now: () => NaN });
    const before = JSON.stringify(f.c.actions(i.id));
    assert.throws(() => s.tick(), /clock/); assert.equal(f.c.active()!.phase, 'HELP_REQUESTED');
    assert.equal(JSON.stringify(f.c.actions(i.id)), before);
    assert.equal(f.c.events(i.id).filter(e => e.type === 'ACKNOWLEDGED').length, 0);
  } finally { f.close(); }
});

test('generated wearer voice stays literal while simulated Maya replies enter attributed notices and the real speech queue', () => {
  const f = fixture({ acceptMs: 0 });
  const quote = 'I fell pretty hard. My ankle hurts and I can’t stand up.';
  try {
    const i = f.c.trigger({ kind: 'synthetic', summary: 'Offline generated physical-event rehearsal input.' });
    assert.equal(f.c.recordCheckinReply({ incidentId: i.id, checkinId: i.checkinId,
      transcript: quote, source: 'freewili-local-speech' }), 'help_requested');
    const wearer = f.c.conversation(i.id).find(message => message.speaker === 'wearer')!;
    assert.equal(wearer.text, quote); assert.equal(wearer.source, 'freewili-local-speech');
    const alert = f.c.actions(i.id).find(action => action.type === 'alert')!;
    assert.ok(alert.text.includes(quote), 'The exact quote reaches the local responder before an AI handoff is prepared');
    f.s.tick(); assert.equal(f.c.active()!.ownerId, maya.id);
    const acceptance = f.c.conversation(i.id).find(message => message.speaker === 'responder')!;
    assert.equal(acceptance.source, 'simulated-dispatch');
    assert.equal(acceptance.delivery, 'recorded', 'care-team chatter is not spoken to the patient');
    const acceptedNotice = f.c.actions(i.id).findLast(action => action.type === 'wearer_status')!;
    assert.equal(acceptedNotice.text, 'Maya has answered your alert.');
    assert.equal(f.c.claimResponderSpeech('offline-attributed-voice-test'), null);
    f.advance(8000); f.s.tick();
    const departing = f.c.conversation(i.id).findLast(message => message.speaker === 'responder')!;
    assert.match(departing.text, /^[^,]+, I’m coming downstairs now\. Try not to move\.$/);
    assert.equal(departing.source, 'simulated-dispatch'); assert.equal(departing.delivery, 'queued');
    const departNotice = f.c.actions(i.id).findLast(action => action.type === 'wearer_status')!;
    assert.ok(departNotice.text.startsWith('Maya is on the way.'));
    assert.ok(departNotice.text.includes(`Maya: “${departing.text}”`));
    const spoken = f.c.claimResponderSpeech('offline-attributed-voice-test')!;
    assert.equal(spoken.id, departing.id); assert.equal(spoken.source, 'simulated-dispatch');
    assert.equal(spoken.speakerName, 'Maya'); assert.equal(spoken.text, departing.text);
    assert.equal(f.c.recordResponderPlayback(spoken.id, i.id, 'offline-attributed-voice-test', 'playing'), true);
    assert.equal(f.c.recordResponderPlayback(spoken.id, i.id, 'offline-attributed-voice-test', 'spoken'), true);
    f.advance(16_000); f.s.tick();
    const arrival = f.c.conversation(i.id).findLast(message => message.speaker === 'responder')!;
    assert.equal(arrival.delivery, 'recorded');
    assert.equal(f.c.actions(i.id).findLast(action => action.type === 'wearer_status')!.text, 'Maya has arrived.');
    f.advance(12_000); f.s.tick();
    assert.equal(f.c.latest()!.phase, 'RESOLVED');
    assert.ok(!f.c.actions(i.id).some(action => action.type === 'wearer_status' && action.text.includes('arranging further assistance')),
      'the outcome record is for the care team, not narrated to the patient');
    assert.deepEqual(f.c.conversation(i.id).find(message => message.id === wearer.id), wearer);
    assert.ok(f.c.actions(i.id).filter(action => action.recipientId).every(action => action.recipientId === maya.id));
    assert.equal(f.c.responders[0].phone, null);
    assert.ok(f.c.actions(i.id).every(action => action.providerMessageId === null
      && action.providerChatId === undefined && action.providerLineId === undefined));
  } finally { f.close(); }
});

test('accelerated phases do not pretend stale wearer notices were sent through a five-second paced lane', () => {
  const f = fixture({ acceptMs: 1000, departMs: 1000, arriveMs: 1000, resolveMs: 1000 });
  try {
    const i = f.c.trigger({ kind: 'manual', summary: 'Offline one-second phase pacing fixture; no messages sent.' });
    f.s.tick();
    for (let step = 0; step < 4; step++) {
      f.advance(1000); f.s.tick(); if (f.c.active()) speechCompleted(f.c, i.id);
    }
    assert.equal(f.c.latest()!.phase, 'RESOLVED');
    f.advance(1000); // A wearer lane next available five seconds after the initial phase.
    assert.equal(f.c.claimAction('wearer', true, i.id), null, 'resolution is not narrated to the patient');
    const oldNotices = f.c.actions(i.id).filter(action => action.type === 'wearer_status');
    assert.ok(oldNotices.length >= 3); assert.ok(oldNotices.every(action => action.status === 'cancelled'));
    assert.ok(f.c.actions(i.id).every(action => action.status !== 'provider_accepted'));
  } finally { f.close(); }
});
