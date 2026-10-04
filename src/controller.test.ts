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
test('exhausted contacts stay unresolved without repeated timeout messages and can still accept', () => {
  const { c, advance } = setup();
  try {
    const i = c.trigger({ kind: 'manual', summary: 'No reply from approved contacts.' });
    const alert = c.claimAction('responders')!;
    c.finishAction(alert.id, 'unknown', 'Submission outcome unknown.');
    advance(60);
    assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    assert.equal(c.active()?.ownerId, null);
    assert.equal(c.active()?.progressDeadline, null);
    assert.match(c.actions(i.id).filter(a => a.type === 'wearer_status').at(-1)!.text, /still trying to reach someone/);
    const count = c.actions(i.id).length, version = c.active()?.version;
    for (let n = 0; n < 10; n++) advance(60);
    assert.equal(c.actions(i.id).length, count);
    assert.equal(c.active()?.version, version);
    assert.equal(c.actions(i.id).find(a => a.id === alert.id)?.status, 'unknown');
    c.accept(i.id, 'jordan');
    assert.equal(c.active()?.phase, 'ACKNOWLEDGED');
    assert.equal(c.active()?.ownerId, 'jordan');
    assert.ok(c.active()!.progressDeadline! > 0);
  } finally { c.close(); }
});
test('confirmed failures retry but unknown outcomes do not', () => {
  const { c, advance } = setup(); const i = c.trigger({ kind: 'manual', summary: 'help' });
  const a = c.claimAction('responders')!; assert.equal(a.type, 'alert'); c.finishAction(a.id, 'failed', 'Confirmed rejection');
  const b = c.claimAction('responders')!; c.finishAction(b.id, 'unknown', 'Timed out after sending'); advance(10_001);
  const retry = c.claimAction('responders')!; assert.equal(retry.id, a.id); assert.equal(retry.attempts, 2);
  c.finishAction(retry.id, 'provider_accepted', 'Accepted', 'provider-1');
  assert.equal(c.claimAction('responders'), null); assert.equal(c.incidentForMessage('provider-1', a.recipientId!)?.id, i.id);
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
test('an in-flight alert that fails after resolution never retries, while final closure statuses still send', () => {
  const { c, advance } = setup();
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Late alert failure fixture.' });
    const alert = c.claimAction('responders')!; assert.equal(alert.type, 'alert');
    c.accept(i.id, 'maya'); c.progress(i.id, 'maya', 'depart'); c.progress(i.id, 'maya', 'arrive');
    const outcome = 'On scene; subject confirmed no further assistance required.';
    c.resolve(i.id, 'maya', outcome); assert.equal(c.latest()?.phase, 'RESOLVED');
    c.finishAction(alert.id, 'failed', 'Known pre-submit failure completed after incident resolution.');
    advance(10_001);
    const closureRecipients: string[] = [];
    for (let count = 0; count < 10; count++) {
      const next = c.claimAction('responders'); if (!next) break;
      assert.notEqual(next.id, alert.id); assert.notEqual(next.type, 'alert');
      assert.equal(next.type, 'status'); assert.ok(next.text.includes(outcome));
      closureRecipients.push(next.recipientId!);
      c.finishAction(next.id, 'provider_accepted', 'Closure status protocol fixture accepted.');
    }
    assert.equal(c.claimAction('responders'), null);
    assert.deepEqual(closureRecipients.sort(), ['jordan', 'maya']);
    assert.equal(c.actions(i.id).find(a => a.id === alert.id)?.status, 'cancelled');
  } finally { c.close(); }
});

test('phone-only responder phase messages name exact commands without claiming unreported progress or safety', () => {
  const { c } = setup();
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Phone-only responder guidance fixture.' });
    const latestStatuses = () => c.actions(i.id).filter(action => action.type === 'status').slice(-2);
    const statusCount = () => c.actions(i.id).filter(action => action.type === 'status').length;

    c.accept(i.id, 'maya');
    assert.equal(c.active()?.phase, 'ACKNOWLEDGED');
    assert.equal(statusCount(), 2, 'existing one-update-per-contact behavior is retained');
    for (const action of latestStatuses()) {
      assert.match(action.text, /Departure has not been confirmed/);
      assert.ok(action.text.includes(`Assigned responder Maya: reply DEPART ${i.id}`));
      assert.ok(action.text.includes(`ARRIVED ${i.id}`));
      assert.ok(action.text.includes(`DECLINE ${i.id}`));
      assert.doesNotMatch(action.text, /on the way|reported departure|confirmed departure|wearer is safe|subject is safe/i);
      assert.equal(action.text.includes(`RESOLVED ${i.id}`), false);
    }

    c.progress(i.id, 'maya', 'depart');
    assert.equal(c.active()?.phase, 'RESPONDER_EN_ROUTE');
    assert.equal(statusCount(), 4);
    for (const action of latestStatuses()) {
      assert.match(action.text, /Maya reported departure/);
      assert.ok(action.text.includes(`Assigned responder Maya: reply ARRIVED ${i.id}`));
      assert.ok(action.text.includes(`DECLINE ${i.id}`));
      assert.equal(action.text.includes(`DEPART ${i.id}`), false, 'departure is no longer a permitted next update');
      assert.equal(action.text.includes(`RESOLVED ${i.id}`), false);
    }

    c.progress(i.id, 'maya', 'arrive');
    assert.equal(c.active()?.phase, 'ON_SCENE');
    assert.equal(statusCount(), 6);
    for (const action of latestStatuses()) {
      assert.match(action.text, /An outcome has not been recorded/);
      assert.ok(action.text.includes(`Assigned responder Maya: reply RESOLVED ${i.id} <concrete outcome>`));
      assert.match(action.text, /what you observed and what help was provided/);
      assert.ok(action.text.includes(`DECLINE ${i.id}`));
      assert.equal(action.text.includes(`DEPART ${i.id}`), false);
      assert.equal(action.text.includes(`ARRIVED ${i.id}`), false);
      assert.doesNotMatch(action.text, /wearer is safe|subject is safe/i);
    }
    c.resolve(i.id, 'maya', 'On scene; wearer requested no further assistance.');
    assert.equal(c.latest()?.phase, 'RESOLVED');
    assert.equal(statusCount(), 8);
  } finally { c.close(); }
});

test('initial and health-updated alerts retain exact acceptance and decline guidance', () => {
  const { c } = setup();
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Alert guidance fixture.' });
    const guidance = (text: string) => {
      assert.match(text, /React 👍 to this alert to accept responsibility/);
      assert.ok(text.includes(`ON IT ${i.id}`));
      assert.ok(text.includes(`DECLINE ${i.id}`));
    };
    for (const action of c.actions(i.id).filter(action => action.type === 'alert')) guidance(action.text);
    const submitted = c.claimAction('responders')!;
    c.finishAction(submitted.id, 'provider_accepted', 'Offline provider fixture accepted.', 'guidance-alert-id');
    c.setHandoff(i.id, 'Source-grounded synthetic record fields.');
    const queued = c.actions(i.id).filter(action => action.type === 'alert' && action.status === 'queued');
    assert.equal(queued.length, 1);
    assert.match(queued[0].text, /Source-grounded synthetic record fields/);
    guidance(queued[0].text);
    assert.equal(c.actions(i.id).filter(action => action.type === 'handoff').length, 1, 'existing handoff follow-up count is unchanged');
  } finally { c.close(); }
});
test('completed sourced handoff carries the observation once while pending alerts retain it', () => {
  const { c } = setup();
  try {
    const summary = 'Labelled synthetic observation for message rehearsal.';
    const i = c.trigger({ kind: 'manual', summary });
    assert.ok(c.actions(i.id).find(a => a.type === 'alert')!.text.includes(summary));
    c.setHandoff(i.id, `Observation (manual): ${summary}\nSynthetic clinical context.`, { generation: 'ai' });
    const alert = c.actions(i.id).find(a => a.type === 'alert')!;
    assert.equal(alert.text.split(summary).length - 1, 1);
    assert.ok(alert.text.includes(`ON IT ${i.id}`));
  } finally { c.close(); }
});

test('declined or timed-out ownership re-alerts include incident-coded phone acceptance and decline', () => {
  for (const cause of ['decline', 'timeout']) {
    const { c, advance } = setup();
    try {
      const i = c.trigger({ kind: 'manual', summary: 'Reassignment guidance fixture.' });
      c.accept(i.id, 'maya');
      if (cause === 'decline') c.decline(i.id, 'maya'); else advance(120);
      assert.equal(c.active()?.phase, 'HELP_REQUESTED');
      assert.equal(c.active()?.ownerId, null);
      const queued = c.actions(i.id).filter(action => action.type === 'alert' && action.status === 'queued');
      assert.equal(queued.length, 1, 'no additional guidance messages are queued');
      assert.equal(queued[0].recipientId, 'jordan');
      assert.match(queued[0].text, /React 👍 to this alert to accept responsibility/);
      assert.ok(queued[0].text.includes(`ON IT ${i.id}`));
      assert.ok(queued[0].text.includes(`DECLINE ${i.id}`));
    } finally { c.close(); }
  }
});

test('twenty successive incident resets cancel old work and reject stale controls', () => {
 const {c,advance}=setup();
 try {
  let previous: ReturnType<Controller['trigger']> | null=null;
  for(let round=0;round<20;round++){
   const incident=c.trigger({kind:'synthetic',summary:'Isolated reliability cycle'});
   if(previous)assert.throws(()=>c.cancel(previous!.id,previous!.checkinId),/stale/);
   c.reset();c.reset();advance(500);
   assert.equal(c.active(),null);
   assert.equal(c.actions(incident.id).filter(a=>a.status==='queued').length,0);
   previous=incident;
  }
 } finally {c.close();}
});
