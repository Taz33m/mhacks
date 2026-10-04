import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller.ts';

const demo = [{ id: 'demo-maya', name: 'Maya', phone: null, simulated: true }];
const live = [{ id: 'maya', name: 'Maya', phone: '+15555550101' }];
const simulated = (path = ':memory:') => new Controller(path, demo, () => 1000,
  undefined, { dispatchMode: 'simulated' });

test('demo dispatch cannot attach real responder contacts or enter live configuration', () => {
  assert.throws(() => new Controller(':memory:', live, Date.now, undefined, { dispatchMode: 'simulated' }), /without phone/);
  assert.throws(() => new Controller(':memory:', demo), /cannot be used in live/);
});

test('simulated ownership requires a locally delivered alert and cannot be manually assigned', () => {
  const c = simulated();
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Labelled demo help request.' });
    assert.throws(() => c.accept(i.id, 'demo-maya'), /controlled by simulated dispatch/);
    assert.throws(() => c.simulateResponder(i.id, 'demo-maya', 'accept'), /first receive/);
    assert.throws(() => c.simulateResponder(i.id, 'demo-maya', 'arrive'), /assigned owner/);
    const a = c.claimAction('responders', true, i.id)!;
    assert.equal(a.type, 'alert'); c.finishSimulatedAction(a.id);
    c.simulateResponder(i.id, 'demo-maya', 'accept');
    assert.equal(c.active()?.ownerId, 'demo-maya');
    assert.throws(() => c.progress(i.id, 'demo-maya', 'depart'), /controlled by simulated dispatch/);
    assert.throws(() => c.resolve(i.id, 'demo-maya', 'Made up human outcome'), /controlled by simulated dispatch/);
    assert.throws(() => c.decline(i.id, 'demo-maya'), /controlled by simulated dispatch/);
    assert.equal(c.conversation(i.id)[0]?.source, 'simulated-dispatch');
    assert.equal(c.events(i.id).find(e => e.type === 'ACKNOWLEDGED')?.actor, 'simulated-dispatch:demo-maya');
    assert.ok(c.actions(i.id).filter(a => a.recipientId === null && a.type !== 'checkin')
      .every(a => a.text.startsWith('[DEMO · simulated dispatch]')));
  } finally { c.close(); }
});

test('simulated transport cannot acquire native receipts and wearer actions stay genuine', () => {
  const c = simulated();
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Demo incident.' });
    const alert = c.claimAction('responders', true, i.id)!;
    assert.throws(() => c.finishAction(alert.id, 'provider_accepted', 'Fake provider', 'fake-guid',
      { chatId: 'fake-chat', lineId: 'fake-line' }), /cannot acquire provider receipts/);
    c.finishSimulatedAction(alert.id);
    const saved = c.actions(i.id).find(a => a.id === alert.id)!;
    assert.equal(saved.status, 'simulated'); assert.equal(saved.providerMessageId, null);
    assert.equal(saved.providerChatId, undefined); assert.equal(saved.providerLineId, undefined);
    assert.throws(() => c.finishSimulatedAction(alert.id), /current permitted/);
    const wearer = c.claimAction('wearer', true, i.id)!;
    assert.throws(() => c.finishSimulatedAction(wearer.id), /current permitted/);
    c.finishAction(wearer.id, 'provider_accepted', 'Fixture genuine transport result', 'wearer-native-guid',
      { chatId: 'wearer-chat', lineId: 'wearer-line' });
    assert.equal(c.actions(i.id).find(a => a.id === wearer.id)?.status, 'provider_accepted');
  } finally { c.close(); }
});

test('live and old historical incidents cannot be automatically converted to simulated dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-dispatch-profile-')), path = join(dir, 'state.sqlite');
  const c = new Controller(path, live);
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Live configuration fixture, no send.' });
    assert.throws(() => c.simulateResponder(i.id, 'maya', 'depart'), /current simulated incident/);
    c.close();
    assert.throws(() => simulated(path), /Finish the active incident/);
    const old = new Controller(path, live);
    old.reset(); old.close();
    const next = simulated(path);
    assert.equal(next.latest()?.dispatchMode, 'live');
    const newer = next.trigger({ kind: 'synthetic', summary: 'New labelled demo fixture.' });
    assert.equal(newer.dispatchMode, 'simulated');
    next.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart recovers local demo attempts while genuine uncertain sends remain unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-dispatch-recovery-')), path = join(dir, 'state.sqlite');
  let c = simulated(path);
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Demo crash fixture.' });
    const alert = c.claimAction('responders', true, i.id)!;
    const wearer = c.claimAction('wearer', true, i.id)!;
    c.close(); c = simulated(path);
    assert.equal(c.actions(i.id).find(a => a.id === alert.id)?.status, 'queued');
    assert.equal(c.actions(i.id).find(a => a.id === wearer.id)?.status, 'unknown');
    const recovered = c.claimAction('responders', true, i.id)!;
    assert.equal(recovered.id, alert.id); c.finishSimulatedAction(recovered.id);
    c.simulateResponder(i.id, 'demo-maya', 'accept');
    assert.equal(c.active()?.phase, 'ACKNOWLEDGED');
  } finally { c.close(); rmSync(dir, { recursive: true, force: true }); }
});
