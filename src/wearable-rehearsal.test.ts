import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from './controller.ts';
import { SimulatedDispatch } from './simulated-dispatch.ts';

const demo = [{ id: 'demo-maya', name: 'Maya', phone: null, simulated: true }];
const quote = "I fell, I can't stand up.";

test('wearable rehearsal opens the complete spoken check-in and uses local Maya with genuine wearer outbox', () => {
  let now = 1000;
  const c = new Controller(':memory:', demo, () => now, undefined, { dispatchMode: 'simulated', wearerName: 'Offline wearer' });
  try {
    const i = c.boardButton('rehearse', null, null, 'yellow-1')!;
    assert.equal(i.phase, 'CONFIRMING');
    assert.equal(i.evidence.kind, 'synthetic');
    assert.match(i.evidence.summary, /Check-in started from the wearable/);
    assert.equal(c.actions(i.id).find(a => a.type === 'wearer_checkin')?.status, 'queued');
    assert.equal(c.boardButton('rehearse', null, null, 'yellow-1'), null, 'same physical event is deduplicated');
    assert.throws(() => c.boardButton('rehearse', null, null, 'yellow-2'), /idle simulated dispatch/);
    now += 2000;
    assert.equal(c.recordCheckinReply({ incidentId: i.id, checkinId: i.checkinId, transcript: quote,
      source: 'freewili-local-speech' }), 'help_requested');
    const simulator = new SimulatedDispatch(c, { now: () => now, acceptMs: 10, departMs: 10, arriveMs: 10, resolveMs: 10 });
    simulator.tick(); now += 10; simulator.tick();
    assert.equal(c.active()?.phase, 'ACKNOWLEDGED');
    const alert = c.actions(i.id).find(a => a.type === 'alert')!;
    assert.match(alert.text, /I fell, I can't stand up\./);
    assert.equal(alert.status, 'simulated');
    assert.equal(alert.providerMessageId, null);
    assert.ok(c.actions(i.id).some(a => a.type === 'wearer_status' && a.text === 'Maya has answered your alert.'));
    assert.ok(!c.actions(i.id).some(a => a.type === 'wearer_status' && a.text.includes('Maya: “')), 'care-team chatter is not relayed');
    now += 10; simulator.tick();
    assert.equal(c.active()?.phase, 'RESPONDER_EN_ROUTE');
    assert.ok(c.conversation(i.id).some(m => m.source === 'simulated-dispatch'
      && m.speakerName === 'Maya' && /coming downstairs/.test(m.text)));
    now += 10; simulator.tick();
    assert.equal(c.active()?.phase, 'ON_SCENE');
    now += 30_010; simulator.tick();
    assert.equal(c.latest()?.phase, 'RESOLVED');
    assert.equal(c.latest()?.resolutionActor, 'simulated-dispatch:demo-maya');
  } finally { c.close(); }
});

test('live dispatch rejects rehearsal while Red retains immediate help behavior', () => {
  for (const simulated of [false, true]) {
    const c = new Controller(':memory:', simulated ? demo : [{ id: 'maya', name: 'Maya', phone: '+15555550101' }],
      () => 1000, undefined, { dispatchMode: simulated ? 'simulated' : 'live' });
    try {
      if (!simulated) {
        assert.throws(() => c.boardButton('rehearse', null, null, 'yellow-live'), /idle simulated dispatch/);
        assert.equal(c.latest(), null);
      }
      const i = c.boardButton('help', null, null, 'red-1')!;
      assert.equal(i.phase, 'HELP_REQUESTED');
      assert.equal(i.evidence.kind, 'manual');
      assert.throws(() => c.boardButton('rehearse', null, null, 'yellow-active'), /idle simulated dispatch/);
    } finally { c.close(); }
  }
});
