import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller.ts';
const responders = [{ id: 'maya', name: 'Maya', phone: null }, { id: 'jordan', name: 'Jordan', phone: null }];
function setup(path = ':memory:') {
  let t = 1000; const c = new Controller(path, responders, () => t, { checkinMs: 20, acceptMs: 60, progressMs: 120 });
  return { c, advance: (ms: number) => { t += ms; c.tick(); } };
}
test('check-in survives silence and synthetic safety interpretations until its deadline', () => {
  const { c, advance } = setup(); const i = c.trigger({ kind: 'synthetic', summary: 'Development trigger' });
  c.setHandoff(i.id, 'The model said safe. The subject said I am not safe.');
  advance(19); assert.equal(c.active()?.phase, 'CONFIRMING'); advance(1);
  assert.equal(c.active()?.phase, 'HELP_REQUESTED'); assert.equal(c.actions(i.id).filter(a => a.type === 'alert').length, 2); c.close();
});
test('explicit cancellation requires current check-in IDs', () => {
  const { c, advance } = setup(); const i = c.trigger({ kind: 'synthetic', summary: 'test' });
  assert.throws(() => c.cancel(i.id, 'old'), /current/); c.cancel(i.id, i.checkinId); advance(100);
  assert.equal(c.active(), null); assert.equal(c.latest()?.phase, 'CANCELLED_FALSE_ALARM');
  const next = c.trigger({ kind: 'synthetic', summary: 'next' });
  assert.throws(() => c.cancel(i.id, i.checkinId), /stale/); assert.equal(c.active()?.id, next.id); c.close();
});
test('manual help skips waiting and repeated trigger does not create another active incident', () => {
  const { c } = setup(); const i = c.trigger({ kind: 'manual', summary: 'Help requested' });
  assert.equal(i.phase, 'HELP_REQUESTED'); assert.equal(c.trigger({ kind: 'synthetic', summary: 'again' }).id, i.id); c.close();
});
test('manual help during confirmation escalates the same incident immediately', () => {
  const { c } = setup(); const i = c.trigger({ kind: 'synthetic', summary: 'Possible incident.' });
  assert.equal(c.active()?.phase, 'CONFIRMING');
  assert.equal(c.trigger({ kind: 'manual', summary: 'Subject requested help.' }).id, i.id);
  assert.equal(c.active()?.phase, 'HELP_REQUESTED'); c.close();
});
test('first eligible acceptance wins; duplicates and stale incidents cannot replace owner', () => {
  const { c } = setup(); const i = c.trigger({ kind: 'manual', summary: 'help' });
  assert.throws(() => c.accept(i.id, 'stranger'), /approved/); c.accept(i.id, 'maya', 'inbound1'); c.accept(i.id, 'maya', 'inbound1');
  assert.throws(() => c.accept(i.id, 'jordan'), /owner/); assert.throws(() => c.accept('old', 'jordan'), /stale/);
  assert.equal(c.active()?.ownerId, 'maya'); assert.equal(c.active()?.phase, 'ACKNOWLEDGED'); c.close();
});
test('resolution requires on-scene owner and concrete outcome', () => {
  const { c } = setup(); const i = c.trigger({ kind: 'manual', summary: 'help' }); c.accept(i.id, 'maya');
  assert.throws(() => c.resolve(i.id, 'maya', 'everything fine'), /on-scene/);
  c.progress(i.id, 'maya', 'depart'); c.progress(i.id, 'maya', 'arrive');
  assert.throws(() => c.resolve(i.id, 'jordan', 'everything fine'), /owner/); assert.throws(() => c.resolve(i.id, 'maya', ''), /outcome/);
  c.resolve(i.id, 'maya', 'On scene; subject confirmed no further help needed.');
  assert.equal(c.latest()?.resolutionActor, 'maya'); assert.equal(c.latest()?.phase, 'RESOLVED'); c.close();
});
test('lost owner triggers reassignment; missing progress does not resolve', () => {
  const { c, advance } = setup(); const i = c.trigger({ kind: 'manual', summary: 'help' }); c.accept(i.id, 'maya');
  advance(120); assert.equal(c.active()?.phase, 'HELP_REQUESTED'); assert.equal(c.active()?.ownerId, null);
  assert.throws(() => c.accept(i.id, 'maya'), /accepting/); c.accept(i.id, 'jordan'); assert.equal(c.active()?.ownerId, 'jordan'); c.close();
});
test('confirmed failures retry but unknown outcomes do not', () => {
  const { c, advance } = setup(); const i = c.trigger({ kind: 'manual', summary: 'help' });
  const a = c.claimAction()!; assert.equal(a.type, 'alert'); c.finishAction(a.id, 'failed', 'Confirmed rejection');
  const b = c.claimAction()!; c.finishAction(b.id, 'unknown', 'Timed out after sending'); advance(10_001);
  const retry = c.claimAction()!; assert.equal(retry.id, a.id); assert.equal(retry.attempts, 2);
  c.finishAction(retry.id, 'provider_accepted', 'Accepted', 'provider-1');
  assert.equal(c.claimAction(), null); assert.equal(c.incidentForMessage('provider-1', a.recipientId!)?.id, i.id);
  assert.equal(c.incidentForMessage('provider-1', 'stranger'), null); c.close();
});
test('persisted deadline recovers and interrupted send remains unknown after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-controller-')); const path = join(dir, 'state.sqlite');
  try {
    let t = 1000; let c = new Controller(path, responders, () => t, { checkinMs: 20, acceptMs: 60, progressMs: 120 });
    c.trigger({ kind: 'synthetic', summary: 'test' }); c.close(); t += 21;
    c = new Controller(path, responders, () => t); c.tick(); assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    const a = c.claimAction()!; c.close(); c = new Controller(path, responders, () => t);
    assert.equal(c.actions(c.active()!.id).find(x => x.id === a.id)?.status, 'unknown'); c.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('late health context updates queued alerts and follows an already accepted send exactly once', () => {
  const { c } = setup(); const i = c.trigger({ kind: 'manual', summary: 'help' });
  const sent = c.claimAction()!; c.finishAction(sent.id, 'provider_accepted', 'accepted', 'message-1');
  c.setHandoff(i.id, 'Record-grounded synthetic medications and allergies.');
  c.setHandoff(i.id, 'Record-grounded synthetic medications and allergies.');
  const actions = c.actions(i.id);
  assert.equal(actions.filter(a => a.type === 'handoff').length, 1);
  assert.equal(actions.find(a => a.type === 'alert' && a.status === 'queued')?.text.includes('Record-grounded'), true);
  c.close();
});
