import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from './controller.ts';
import type { ProviderInbound } from './contracts.ts';
import { handleWearerInbound } from './wearer.ts';

const phone = '+12025550100';
const responder = { id: 'maya', name: 'Maya', phone: '+12025550101' };
const binding = { chatId: 'wearer-private-chat', lineId: 'lifeline-line' };
function setup(t: TestContext) {
  const controller = new Controller(':memory:', [responder], () => 1000, undefined, { wearerName: 'Tazeem' });
  t.after(() => controller.close());
  const incident = controller.trigger({ kind: 'synthetic', summary: 'Offline conversation fixture.' });
  const action = controller.claimAction('wearer')!;
  controller.finishAction(action.id, 'provider_accepted', 'Offline fixture.', 'checkin-message', binding);
  return { controller, incident };
}
function inbound(text: string, messageId = 'wearer-update', extra: Partial<ProviderInbound> = {}): ProviderInbound {
  return { kind: 'text', sender: phone, messageId, text, ...binding, ...extra };
}
function policyState(controller: Controller) {
  const i = controller.active()!;
  return [i.id, i.phase, i.version, i.ownerId, i.checkinDeadline, i.progressDeadline];
}
function escalate(controller: Controller) {
  handleWearerInbound(inbound('I need help', 'initial-help'), phone, controller);
  assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
}

test('normal text in the current accepted wearer conversation opens help without a copied code', t => {
  const { controller, incident } = setup(t);
  const text = "I fell pretty hard. My ankle hurts and I can't stand up.";
  handleWearerInbound(inbound(text), phone, controller);
  assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
  assert.equal(controller.conversation(incident.id)[0].text, text);
  assert.ok(controller.actions(incident.id).some(a => a.type === 'wearer_relay' && a.text === `Tazeem: “${text}”`));
});

test('a later wearer report is quoted to the responder once without changing incident policy', t => {
  const { controller, incident } = setup(t);
  escalate(controller);
  const before = policyState(controller);
  const event = inbound('My ankle is swelling. I am sitting by the stairs.', 'later-report', { providerTimestamp: 900 });
  handleWearerInbound(event, phone, controller);
  handleWearerInbound(event, phone, controller);
  assert.deepEqual(policyState(controller), before);
  const reports = controller.conversation(incident.id).filter(m => m.text === event.text);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, 'photon-imessage');
  assert.equal(reports[0].speaker, 'wearer');
  const relays = controller.actions(incident.id).filter(a => a.type === 'wearer_relay' && a.text === `Tazeem: “${event.text}”`);
  assert.equal(relays.length, 1);
  assert.equal(relays[0].recipientId, responder.id);
  assert.equal(controller.seenInbound('later-report'), true);
  assert.equal(controller.events(incident.id).filter(e => e.type === 'WEARER_REPORT').length, 1);
});

test('wearer conversation continues while the responder owns the incident; positive prose cannot resolve it', t => {
  const { controller, incident } = setup(t);
  escalate(controller);
  controller.accept(incident.id, responder.id);
  controller.progress(incident.id, responder.id, 'depart');
  const before = policyState(controller);
  handleWearerInbound(inbound("I'm okay now. Maya is coming.", 'positive-after-help', { targetMessageId: 'checkin-message' }), phone, controller);
  assert.deepEqual(policyState(controller), before);
  assert.equal(controller.active()?.phase, 'RESPONDER_EN_ROUTE');
  assert.equal(controller.conversation(incident.id).at(-1)?.text, "I'm okay now. Maya is coming.");
  assert.ok(controller.actions(incident.id).some(a => a.type === 'wearer_relay' && a.text.includes("I'm okay now.")));
});

test('new reports supersede an unsent handoff while uncertain sends remain preserved', t => {
  const { controller, incident } = setup(t);
  escalate(controller);
  const alert = controller.claimAction('responders')!;
  assert.equal(alert.type, 'alert');
  controller.finishAction(alert.id, 'provider_accepted', 'Offline responder fixture.', 'alert-message',
    { chatId: 'responder-private-chat', lineId: binding.lineId });
  controller.setHandoff(incident.id, 'Initial quoted report and read-only record context.');
  const original = controller.actions(incident.id).find(a => a.type === 'handoff')!;
  handleWearerInbound(inbound('My ankle is swelling.', 'new-context'), phone, controller);
  controller.setHandoff(incident.id, 'Updated wearer report: My ankle is swelling.');
  controller.setHandoff(incident.id, 'Updated wearer report: My ankle is swelling. Source retained.');
  const handoffs = controller.actions(incident.id).filter(a => a.type === 'handoff');
  assert.equal(handoffs.find(a => a.id === original.id)?.status, 'cancelled');
  assert.equal(handoffs.filter(a => a.status === 'queued').length, 1);
  const latest = handoffs.find(a => a.status === 'queued')!;
  assert.match(latest.text, /ankle is swelling\. Source retained/);
  controller.finishAction(latest.id, 'unknown', 'Offline uncertain transport outcome.');
  controller.setHandoff(incident.id, 'Recomposed same reports.');
  assert.equal(controller.actions(incident.id).filter(a => a.type === 'handoff').length, 2);
  assert.equal(controller.actions(incident.id).find(a => a.id === latest.id)?.text, latest.text);
  handleWearerInbound(inbound('I am still by the stairs.', 'newer-context'), phone, controller);
  controller.setHandoff(incident.id, 'Newest wearer report: I am still by the stairs.');
  assert.equal(controller.actions(incident.id).filter(a => a.type === 'handoff' && a.status === 'queued').length, 1);
  assert.equal(controller.actions(incident.id).find(a => a.id === latest.id)?.status, 'unknown');
});

test('unbound or foreign conversations cannot contribute a wearer update in either phase', t => {
  const { controller, incident } = setup(t);
  for (const phase of ['CONFIRMING', 'HELP_REQUESTED']) {
    if (phase === 'HELP_REQUESTED') escalate(controller);
    const before = controller.conversation(incident.id).length;
    for (const [index, extra] of [
      { chatId: undefined, lineId: undefined }, { chatId: 'other-chat' }, { lineId: 'other-line' },
      { sender: responder.phone }, { removed: true }, { kind: 'reaction' as const, reaction: '👍' },
    ].entries()) handleWearerInbound(inbound('I need help', `wrong-${phase}-${index}`, extra), phone, controller);
    assert.equal(controller.conversation(incident.id).length, before);
    assert.equal(controller.active()?.phase, phase);
  }
});

test('an explicit prior-incident target cannot be rescued by the current chat or incident code', t => {
  const { controller, incident: old } = setup(t);
  controller.cancel(old.id, old.checkinId);
  const current = controller.trigger({ kind: 'synthetic', summary: 'Next isolated incident.' });
  const action = controller.claimAction('wearer')!;
  controller.finishAction(action.id, 'provider_accepted', 'Offline current fixture.', 'new-checkin-message', binding);
  escalate(controller);
  const before = controller.conversation(current.id).length;
  for (const [index, target] of ['checkin-message', '', 'unknown-message'].entries())
    handleWearerInbound(inbound(`My ankle hurts ${current.id}`, `stale-${index}`, { targetMessageId: target }), phone, controller);
  handleWearerInbound(inbound(`My ankle hurts ${old.id}`, 'old-code'), phone, controller);
  assert.equal(controller.conversation(current.id).length, before);
  assert.equal(controller.seenInbound('stale-0'), false);
  handleWearerInbound(inbound(`My ankle hurts ${current.id}`, 'current-report', { targetMessageId: 'new-checkin-message' }), phone, controller);
  assert.equal(controller.conversation(current.id).at(-1)?.text, 'My ankle hurts');
});

test('malformed updates remain unprocessed and closed incidents reject further wearer evidence', t => {
  const { controller, incident } = setup(t);
  escalate(controller);
  const before = controller.conversation(incident.id).length;
  for (const [index, event] of [inbound(''), inbound('x'.repeat(501)), inbound('Bad\u0000text'),
    inbound('Valid text', ''), { ...inbound('Valid text'), sender: undefined } as unknown as ProviderInbound].entries()) {
    assert.equal(controller.recordWearerUpdate({ ...event, messageId: event.messageId ? `malformed-${index}` : '' }, phone), false);
  }
  assert.equal(controller.conversation(incident.id).length, before);
  controller.accept(incident.id, responder.id);
  controller.progress(incident.id, responder.id, 'depart');
  controller.progress(incident.id, responder.id, 'arrive');
  controller.resolve(incident.id, responder.id, 'Rehearsal ended with a documented outcome.');
  assert.equal(controller.recordWearerUpdate(inbound('Another update'), phone), false);
  assert.equal(controller.conversation(incident.id).length, before);
});
