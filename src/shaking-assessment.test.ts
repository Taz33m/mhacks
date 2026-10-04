import test from 'node:test';
import assert from 'node:assert/strict';
import { FreeWili } from './freewili.ts';
import { Motion } from './motion.ts';
import { ShakingAssessment } from './shaking-assessment.ts';
import { Controller } from './controller.ts';

// Protocol fixtures test software gates, never clinical accuracy or twin-derived tuning.
function fixture(options: { hz?: number; body?: boolean; waist?: boolean; gap?: boolean; saturated?: boolean; sync?: boolean } = {}) {
  let time = 1000;
  const wili = new FreeWili(() => time), motion = new Motion(() => time), detector = new ShakingAssessment(() => time);
  wili.connected(); motion.connected('waist-airpod');
  for (let seq = 0; seq <= 105; seq++) {
    time = 1000 + seq * 40;
    if (options.gap && seq > 45 && seq < 53) continue;
    const wave = Math.sin(seq * .04 * Math.PI * 2 * (options.hz ?? 3));
    assert.equal(wili.sample({ type: 'accel.sample', source: 'body-wili', sessionId: 'actual-protocol-fixture-body',
      sequence: seq, sensorTime: time / 1000, captureClock: 'host-receipt', frameTimestamp: String(seq),
      accelerationG: [0, 0, options.body === false ? 1 : 1 + .45 * wave], fullScaleG: 2,
      saturated: options.saturated ?? false, quality: 'measured', fresh: true }), true);
    assert.equal(motion.sample('waist-airpod', { type: 'motion.sample', source: 'waist-airpod', sessionId: 'actual-protocol-fixture-waist',
      sequence: seq, sensorTime: (time + 100000) / 1000, sensorLocation: 'Left',
      quaternion: [0, 0, 0, 1], gravity: [0, 0, -1], userAcceleration: [options.waist === false ? 0 : .6, 0, 0],
      rotationRate: [0, options.waist === false ? 0 : 4 * wave, 0] }), true);
    if (seq === 0 && options.sync !== false) {
      const bp = wili.ping()!;
      wili.pong({ type: 'clock.pong', id: bp.id, sessionId: 'actual-protocol-fixture-body', deviceReceivedMs: time, deviceSentMs: time });
      const ping = motion.ping('waist-airpod')!;
      motion.pong('waist-airpod', { type: 'clock.pong', id: ping.id, sessionId: 'actual-protocol-fixture-waist',
        deviceReceivedMs: time + 100000, deviceSentMs: time + 100000 });
    }
  }
  return { wili, motion, detector, now: () => time, advance(ms: number) { time += ms; } };
}
test('sustained alternating movement starts an unresolved, source-labelled check-in', () => {
  const f = fixture(), evidence = f.detector.candidate(f.wili, f.motion);
  assert.ok(evidence); assert.equal(evidence.eventType, 'sustained-shaking');
  assert.ok(evidence.shaking!.durationMs >= 3800); assert.ok(evidence.shaking!.waistReversals >= 16);
  assert.equal(evidence.assessment, undefined, 'never masquerades as a fall impact');
  assert.ok(Object.isFrozen(evidence.shaking));
  const c = new Controller(':memory:', [{ id: 'maya', name: 'Maya', phone: null }]);
  try {
    const i = c.trigger(evidence); assert.equal(i.phase, 'CONFIRMING');
    assert.match(c.actions(i.id).find(a => a.type === 'wearer_checkin')!.text, /sustained unusual movement/);
    assert.equal(c.actions(i.id).some(a => a.type === 'alert'), false);
    c.recordCheckinReply({ incidentId: i.id, checkinId: i.checkinId, transcript: "I'm having a seizure", source: 'freewili-local-speech' });
    assert.equal(c.active()!.phase, 'HELP_REQUESTED');
    assert.match(c.actions(i.id).find(a => a.type === 'alert')!.text, /having a seizure/);
  } finally { c.close(); }
  assert.equal(f.detector.candidate(f.wili, f.motion), null);
  f.detector.reset(); assert.equal(f.detector.candidate(f.wili, f.motion), null);
});
test('single-site shaking, slower gait-like reversals, gaps, unsynced clocks and clipped samples do not trigger', () => {
  for (const option of [{ body: false }, { waist: false }, { hz: 1 }, { gap: true }, { saturated: true }, { sync: false }]) {
    const f = fixture(option); assert.equal(f.detector.candidate(f.wili, f.motion), null, JSON.stringify(option));
  }
  const f = fixture(); f.advance(1000); assert.equal(f.detector.candidate(f.wili, f.motion), null, 'stale history');
  const g = fixture(); g.motion.disconnected('waist-airpod'); assert.equal(g.detector.candidate(g.wili, g.motion), null);
});
test('signed rotation observations are copied, not mutable stream state', () => {
  const f = fixture(), before = f.motion.observations('waist-airpod')[0].rotationRate[1];
  f.motion.observations('waist-airpod')[0].rotationRate[1] = 900;
  assert.equal(f.motion.observations('waist-airpod')[0].rotationRate[1], before);
});
