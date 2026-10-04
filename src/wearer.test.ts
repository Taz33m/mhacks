import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, PolicyError } from './controller.ts';
import type { Incident, ProviderInbound } from './contracts.ts';
import { handleWearerInbound } from './wearer.ts';

const phone = '+12675550123';
const responders = [{ id: 'maya', name: 'Maya', phone: '+12675550124' }];
function persistCheckin(controller: Controller, messageId = 'provider-wearer-checkin'): string {
  const action = controller.claimAction();
  assert.equal(action?.type, 'wearer_checkin');
  controller.finishAction(action!.id, 'provider_accepted', 'Offline fixture accepted by provider.', messageId);
  return messageId;
}
function setup(t: TestContext, sent = true) {
  let now = 1_000;
  const controller = new Controller(':memory:', responders, () => now);
  t.after(() => controller.close());
  const incident = controller.trigger({ kind: 'synthetic', summary: 'Offline wearer routing fixture.' });
  const target = sent ? persistCheckin(controller) : undefined;
  return { controller, incident, target, setNow: (value: number) => { now = value; } };
}
function inbound(text: string, targetMessageId?: string, messageId = 'incoming-wearer'): ProviderInbound {
  return { kind: 'text', sender: phone, messageId, text, ...(targetMessageId !== undefined ? { targetMessageId } : {}) };
}
function replies(controller: Controller, incident: Incident) {
  return controller.events(incident.id).filter(event => event.type === 'CHECKIN_REPLY')
    .map(event => JSON.parse(event.detail) as { transcript: string; decision: string });
}
const ackText = "Glad you're okay. To close this check-in, press the green 'I DON'T NEED HELP' button on WILi.";
const acknowledgements = (controller: Controller, incident: Incident) =>
  controller.actions(incident.id).filter(action => action.type === 'wearer_ack');

test('wearer authentication requires the complete configured phone identity', t => {
  const { controller, incident, target } = setup(t);
  for (const sender of ['+12675550124', '2675550123', '12675550123@icloud.com', 'person@example.com']) {
    assert.equal(handleWearerInbound({ ...inbound('I need help', target), sender }, phone, controller), false, sender);
  }
  assert.equal(handleWearerInbound(inbound('I need help', target), null, controller), false);
  assert.equal(handleWearerInbound(inbound('I need help', target), '12675550123@icloud.com', controller), false);
  assert.equal(handleWearerInbound({ ...inbound('maybe', target), sender: '12675550123' }, phone, controller), true);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(replies(controller, incident).length, 1);
});

test('persisted check-in target admits positive and ambiguous replies without clearing the timer', t => {
  const { controller, incident, target } = setup(t);
  const actionIds = controller.actions(incident.id).map(action => action.id);
  assert.equal(controller.wearerIncidentForMessage(target!)?.id, incident.id);
  for (const [index, text] of ["I don't need help", 'maybe I am okay'].entries()) {
    assert.equal(handleWearerInbound(inbound(text, target, `positive-${index}`), phone, controller), true);
  }
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(controller.active()?.checkinDeadline, incident.checkinDeadline);
  assert.deepEqual(replies(controller, incident), [
    { transcript: "I don't need help", decision: 'confirmation_required' },
    { transcript: 'maybe I am okay', decision: 'unresolved' },
  ]);
  assert.deepEqual(controller.actions(incident.id).filter(action => action.type !== 'wearer_ack').map(action => action.id), actionIds);
  assert.equal(acknowledgements(controller, incident).length, 1, 'only the positive Photon reply queues an acknowledgement');
  assert.equal(acknowledgements(controller, incident)[0].text, ackText);
  assert.equal(acknowledgements(controller, incident)[0].recipientId, null);
});

test('exact help on the current persisted target escalates once', t => {
  const { controller, incident, target } = setup(t);
  const event = inbound('I NEED HELP', target);
  assert.equal(handleWearerInbound(event, phone, controller), true);
  assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
  assert.equal(controller.active()?.id, incident.id);
  assert.equal(controller.actions(incident.id).filter(action => action.type === 'alert').length, 1);
  assert.deepEqual(replies(controller, incident), [{ transcript: 'I NEED HELP', decision: 'help_requested' }]);
  assert.equal(handleWearerInbound(event, phone, controller), true);
  assert.equal(replies(controller, incident).length, 1);
});

test('code-only help requires the exact full current suffix and strips it before classification', t => {
  const { controller, incident } = setup(t, false);
  assert.equal(controller.actions(incident.id).some(action => action.type === 'wearer_checkin'), true);
  assert.equal(handleWearerInbound(inbound(`I NEED HELP ${incident.id}`), phone, controller), true);
  assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
  assert.deepEqual(replies(controller, incident), [{ transcript: 'I NEED HELP', decision: 'help_requested' }]);
});

test('untargeted text, partial codes, wrong case and extra suffix content cannot correlate', t => {
  const { controller, incident } = setup(t);
  const invalid = ['I need help', `I need help ${incident.id.slice(0, -1)}`, `I need help ${incident.id.toLowerCase()}`,
    `I need help ${incident.id} extra`, `I need help ${incident.id}!`, `I need help${incident.id}`, incident.id];
  for (const [index, text] of invalid.entries()) {
    assert.equal(handleWearerInbound(inbound(text, undefined, `uncorrelated-${index}`), phone, controller), true);
  }
  assert.deepEqual(replies(controller, incident), []);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(controller.active()?.checkinDeadline, incident.checkinDeadline);
  assert.deepEqual(acknowledgements(controller, incident), []);
});

test('a current code cannot rescue an explicit stale, unknown or empty target', t => {
  const { controller, incident: old, target: oldTarget } = setup(t);
  controller.cancel(old.id, old.checkinId);
  for (let fyi = controller.claimAction('responders'), k = 0; fyi; fyi = controller.claimAction('responders'), k++) { assert.match(fyi.text, /LIFELINE FYI/); controller.finishAction(fyi.id, 'provider_accepted', 'FYI fixture accepted.', `fyi-message-${k}`); }
  const current = controller.trigger({ kind: 'synthetic', summary: 'Next offline incident.' });
  const currentTarget = persistCheckin(controller, 'provider-current-wearer-checkin');
  for (const [index, target] of [oldTarget!, 'unknown-provider-message', ''].entries()) {
    assert.equal(handleWearerInbound(inbound(`I NEED HELP ${current.id}`, target, `wrong-target-${index}`), phone, controller), true);
  }
  assert.deepEqual(replies(controller, current), []);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(handleWearerInbound(inbound(`I NEED HELP ${current.id}`, currentTarget), phone, controller), true);
  assert.deepEqual(replies(controller, current), [{ transcript: 'I NEED HELP', decision: 'help_requested' }]);
});

test('legacy incidents without an outbound wearer check-in do not accept code-only replies', t => {
  const { controller, incident } = setup(t, false);
  // A persisted incident created before wearer support has no such outbound action.
  controller.db.prepare("DELETE FROM actions WHERE incident_id=? AND json_extract(body,'$.type')='wearer_checkin'").run(incident.id);
  assert.equal(handleWearerInbound(inbound(`I NEED HELP ${incident.id}`), phone, controller), true);
  assert.deepEqual(replies(controller, incident), []);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
});

test('duplicate provider inbound ID cannot add evidence or change a positive reply into help', t => {
  const { controller, incident, target } = setup(t);
  assert.equal(handleWearerInbound(inbound("I'm okay", target, 'same-inbound'), phone, controller), true);
  assert.equal(controller.seenInbound('same-inbound'), true);
  assert.equal(handleWearerInbound(inbound('I need help', target, 'same-inbound'), phone, controller), true);
  assert.deepEqual(replies(controller, incident), [{ transcript: "I'm okay", decision: 'confirmation_required' }]);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(controller.active()?.checkinDeadline, incident.checkinDeadline);
  assert.equal(acknowledgements(controller, incident).length, 1, 'duplicate inbound cannot queue another acknowledgement');
});

test('removed messages, reactions and malformed text consume wearer routing without state changes', t => {
  const { controller, incident, target } = setup(t);
  const events: ProviderInbound[] = [
    { ...inbound('I need help', target), removed: true },
    { kind: 'reaction', sender: phone, messageId: 'like', targetMessageId: target, reaction: '👍' },
    { kind: 'text', sender: phone, messageId: 'missing-text', targetMessageId: target },
    ...['', '   ', 'x'.repeat(501)].map((text, index) => inbound(text, target, `invalid-text-${index}`)),
  ];
  for (const event of events) assert.equal(handleWearerInbound(event, phone, controller), true);
  assert.deepEqual(replies(controller, incident), []);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(handleWearerInbound(inbound('x'.repeat(500), target, 'max-length'), phone, controller), true);
  assert.equal(replies(controller, incident)[0]?.decision, 'unresolved');
});

test('controller clock enforces the deadline even before the timer worker ticks', t => {
  const { controller, incident, target, setNow } = setup(t);
  setNow(incident.checkinDeadline - 1);
  assert.equal(handleWearerInbound(inbound('maybe', target, 'just-before'), phone, controller), true);
  setNow(incident.checkinDeadline);
  assert.equal(controller.wearerIncidentForMessage(target!), null);
  assert.equal(handleWearerInbound(inbound('I need help', target, 'at-deadline'), phone, controller), true);
  assert.throws(() => handleWearerInbound(inbound(`I need help ${incident.id}`, undefined, 'coded-at-deadline'), phone, controller), PolicyError);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(controller.seenInbound('at-deadline'), false);
  assert.equal(controller.seenInbound('coded-at-deadline'), false);
  assert.equal(replies(controller, incident).length, 1);
  controller.tick();
  assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
  assert.equal(handleWearerInbound(inbound('I need help', target, 'after-escalation'), phone, controller), true);
  assert.equal(replies(controller, incident).length, 1);
});

test('wearer sender remains recognized when its incident has closed', t => {
  const { controller, incident, target } = setup(t);
  controller.cancel(incident.id, incident.checkinId);
  assert.equal(handleWearerInbound(inbound('I need help', target), phone, controller), true);
  assert.equal(controller.active(), null);
  assert.deepEqual(replies(controller, incident), []);
});

test('provider target correlation and inbound deduplication survive SQLite restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-wearer-'));
  const path = join(directory, 'state.sqlite');
  let controller: Controller | null = new Controller(path, responders, () => 1_000);
  try {
    const incident = controller.trigger({ kind: 'synthetic', summary: 'Offline persistence fixture.' });
    const target = persistCheckin(controller, 'persisted-provider-checkin');
    handleWearerInbound(inbound("I'm okay", target, 'persisted-inbound'), phone, controller);
    controller.close(); controller = null;
    controller = new Controller(path, responders, () => 1_001);
    assert.equal(controller.wearerIncidentForMessage(target)?.id, incident.id);
    handleWearerInbound(inbound('I need help', target, 'persisted-inbound'), phone, controller);
    assert.equal(controller.active()?.phase, 'CONFIRMING');
    assert.equal(replies(controller, incident).length, 1);
    assert.equal(acknowledgements(controller, incident).length, 1);
    handleWearerInbound(inbound('I need help', target, 'fresh-inbound'), phone, controller);
    assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
    assert.equal(replies(controller, incident).length, 2);
  } finally { controller?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('positive Photon acknowledgement uses the wearer lane while preserving the original deadline', t => {
  const { controller, incident, target } = setup(t);
  handleWearerInbound(inbound("I'm okay", target), phone, controller);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(controller.active()?.checkinDeadline, incident.checkinDeadline);
  assert.equal(controller.claimAction('responders'), null, 'acknowledgement is never sent to a responder');
  const ack = controller.claimAction('wearer');
  assert.equal(ack?.type, 'wearer_ack');
  assert.equal(ack?.text, ackText);
  assert.equal(ack?.recipientId, null);
  assert.equal(controller.actionPermitted(ack!), true);
  assert.equal(controller.claimAction('wearer'), null);
});

test('ambiguous, help and native positive replies never queue a Photon positive acknowledgement', t => {
  const { controller, incident, target } = setup(t);
  handleWearerInbound(inbound('maybe', target, 'ambiguous'), phone, controller);
  controller.recordCheckinReply({ incidentId: incident.id, checkinId: incident.checkinId,
    transcript: "I'm okay", source: 'ios-on-device-speech' });
  assert.deepEqual(acknowledgements(controller, incident), []);
  handleWearerInbound(inbound('I need help', target, 'help'), phone, controller);
  assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
  assert.deepEqual(acknowledgements(controller, incident), []);
});

test('cancellation and escalation stop queued wearer acknowledgements', t => {
  for (const ending of ['cancel', 'deadline', 'help']) {
    const { controller, incident, target, setNow } = setup(t);
    handleWearerInbound(inbound("I'm okay", target, `positive-${ending}`), phone, controller);
    if (ending === 'cancel') controller.cancel(incident.id, incident.checkinId);
    else if (ending === 'deadline') { setNow(incident.checkinDeadline); controller.tick(); }
    else handleWearerInbound(inbound('I need help', target, 'later-help'), phone, controller);
    assert.equal(acknowledgements(controller, incident)[0].status, 'cancelled', ending);
    const update = controller.claimAction('wearer')!;
    assert.equal(update.type, 'wearer_status', ending);
    assert.equal(controller.claimAction('wearer'), null, ending);
  }
});

test('claimed wearer acknowledgement loses submission permission at the original deadline', t => {
  const { controller, incident, target, setNow } = setup(t);
  handleWearerInbound(inbound("I'm okay", target), phone, controller);
  const ack = controller.claimAction('wearer')!;
  assert.equal(ack.type, 'wearer_ack');
  setNow(incident.checkinDeadline);
  assert.equal(controller.active()?.phase, 'CONFIRMING', 'deadline checked before the worker ticks');
  assert.equal(controller.actionPermitted(ack), false);
  assert.equal(controller.active()?.checkinDeadline, incident.checkinDeadline);
});

test('current acknowledgement provider message remains a valid target for a later wearer help request', t => {
  const { controller, incident, target } = setup(t);
  handleWearerInbound(inbound("I'm okay", target, 'positive'), phone, controller);
  const ack = controller.claimAction('wearer')!;
  controller.finishAction(ack.id, 'provider_accepted', 'Offline acknowledgement fixture.', 'provider-wearer-ack');
  assert.equal(controller.wearerIncidentForMessage('provider-wearer-ack')?.id, incident.id);
  handleWearerInbound(inbound('I need help', 'provider-wearer-ack', 'help-after-ack'), phone, controller);
  assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
  assert.deepEqual(replies(controller, incident).map(reply => reply.decision), ['confirmation_required', 'help_requested']);
});

test('positive acknowledgement, inbound dedupe and reply audit commit atomically', t => {
  const { controller, incident, target } = setup(t);
  controller.db.exec(`CREATE TRIGGER reject_wearer_ack BEFORE INSERT ON actions
    WHEN json_extract(NEW.body,'$.type')='wearer_ack'
    BEGIN SELECT RAISE(ABORT, 'offline acknowledgement storage failure'); END;`);
  const event = inbound("I'm okay", target, 'atomic-positive');
  assert.throws(() => handleWearerInbound(event, phone, controller), /storage failure/);
  assert.equal(controller.seenInbound(event.messageId), false);
  assert.deepEqual(replies(controller, incident), []);
  assert.deepEqual(acknowledgements(controller, incident), []);
  assert.equal(controller.active()?.phase, 'CONFIRMING');
  assert.equal(controller.active()?.checkinDeadline, incident.checkinDeadline);
  controller.db.exec('DROP TRIGGER reject_wearer_ack');
  handleWearerInbound(event, phone, controller);
  assert.equal(controller.seenInbound(event.messageId), true);
  assert.equal(replies(controller, incident).length, 1);
  assert.equal(acknowledgements(controller, incident).length, 1);
});
