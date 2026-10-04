import test from 'node:test';
import assert from 'node:assert/strict';
import { Motion, validSample } from './motion.ts';
import type { MotionSample, Source, Vec3 } from './contracts.ts';
const sample = (sequence = 1): MotionSample => ({ type: 'motion.sample', source: 'waist-airpod', sensorLocation: 'Left',
  sessionId: 'test-session', sequence, sensorTime: sequence / 25, quaternion: [0,0,0,1], rotationRate: [0,0,0], gravity: [0,-1,0], userAcceleration: [0,0,0] });
test('validates source, identity, finite values and physical vector bounds', () => {
  assert.equal(validSample(sample(), 'waist-airpod'), true);
  assert.equal(validSample(sample(), 'chest-phone'), false);
  assert.equal(validSample({ ...sample(), gravity: [0,0,0] }, 'waist-airpod'), false);
  assert.equal(validSample({ ...sample(), userAcceleration: [NaN,0,0] }, 'waist-airpod'), false);
});
test('duplicate samples rejected; reconnect gaps and bud switches invalidate calibration', () => {
  let t = 100; const m = new Motion(() => t); m.connected('waist-airpod');
  for (let seq = 1; seq <= 30; seq++) { t += 40; assert.equal(m.sample('waist-airpod', sample(seq)), true); }
  assert.deepEqual(m.calibrate(), ['waist-airpod']); assert.equal(m.sample('waist-airpod', sample(30)), false);
  t += 600; m.sample('waist-airpod', sample(31)); assert.equal(m.views()[1].calibrated, false);
  assert.deepEqual(m.calibrate(), []);
  for (let seq = 32; seq <= 60; seq++) { t += 40; m.sample('waist-airpod', sample(seq)); }
  m.calibrate(); assert.equal(m.views()[1].calibrated, true);
  m.sample('waist-airpod', { ...sample(61), sensorLocation: 'Right' }); assert.equal(m.views()[1].calibrated, false);
});
test('paired trial reset preserves only a fresh session baseline and never previous history or clocks', () => {
  let t = 100; const m = new Motion(() => t);
  for (let seq = 1; seq <= 31; seq++) { t += 40; m.sample('waist-airpod', sample(seq)); }
  assert.deepEqual(m.calibrate(['waist-airpod']), ['waist-airpod']);
  const ping = m.ping('waist-airpod');
  m.pong('waist-airpod', { type: 'clock.pong', id: ping.id, sessionId: 'test-session',
    deviceReceivedMs: t, deviceSentMs: t });
  m.reset({ clocks: true, cooldown: false, preserveCalibration: true });
  assert.equal(m.views()[1].calibrated, true); assert.equal(m.views()[1].alignmentUncertaintyMs, null);
  assert.deepEqual(m.observations('waist-airpod'), []);
  assert.equal(m.sample('waist-airpod', sample(31)), false, 'recording boundary preserves replay rejection');
  t += 40; m.sample('waist-airpod', sample(32)); assert.equal(m.views()[1].calibrated, true);
  t += 600; m.sample('waist-airpod', sample(33)); assert.equal(m.views()[1].calibrated, false, 'normal gaps invalidate the preserved baseline');
  for (let seq = 34; seq <= 65; seq++) { t += 40; m.sample('waist-airpod', sample(seq)); }
  assert.deepEqual(m.calibrate(['waist-airpod']), ['waist-airpod']);
  t += 600; m.reset({ clocks: true, preserveCalibration: true });
  t += 40; m.sample('waist-airpod', sample(66)); assert.equal(m.views()[1].calibrated, false, 'stale baselines cannot be preserved');
});
test('ping/pong records bounded clock uncertainty without inventing synchronized samples', () => {
  let t = 100; const m = new Motion(() => t); m.sample('waist-airpod', sample());
  const ping = m.ping('waist-airpod'); t += 10;
  assert.equal(m.pong('waist-airpod', { type: 'clock.pong', id: ping.id, sessionId: 'test-session', deviceReceivedMs: 5000, deviceSentMs: 5001 }), true);
  assert.equal(m.views()[1].alignmentUncertaintyMs, 4.5);
  assert.equal(m.pong('waist-airpod', { type: 'clock.pong', id: ping.id, sessionId: 'old-session', deviceReceivedMs: 1, deviceSentMs: 2 }), false);
  t += 16_000; assert.equal(m.views()[1].alignmentUncertaintyMs, null); assert.equal(m.views()[1].fresh, false);
});

test('reconnect requires new continuous samples before recalibration', () => {
  let t = 100; const m = new Motion(() => t);
  for (let seq = 1; seq <= 31; seq++) { t += 40; assert.equal(m.sample('waist-airpod', sample(seq)), true); }
  assert.deepEqual(m.calibrate(), ['waist-airpod']);
  m.disconnected('waist-airpod'); t += 40; m.connected('waist-airpod');
  assert.equal(m.views()[1].fresh, false, 'reconnection alone is not a new observation');
  assert.deepEqual(m.calibrate(), [], 'pre-disconnect observations cannot establish a new baseline');
  t += 40; assert.equal(m.sample('waist-airpod', sample(32)), true);
  assert.deepEqual(m.calibrate(), [], 'one new sample cannot bridge the disconnection');
  for (let seq = 33; seq <= 62; seq++) { t += 40; assert.equal(m.sample('waist-airpod', sample(seq)), true); }
  assert.deepEqual(m.calibrate(), ['waist-airpod'], 'a new continuous still window restores calibration');
});

// Synthetic vectors exercise clock and freshness rules, not physical fall accuracy.
function captureAgeFixture(captureSkewMs: number) {
  let t = 1_000;
  const m = new Motion(() => t);
  const sources: Source[] = ['chest-phone', 'waist-airpod'];
  const sequences: Record<Source, number> = { 'chest-phone': 0, 'waist-airpod': 0 };
  const offsets: Record<Source, number> = { 'chest-phone': 100_000, 'waist-airpod': 300_000 };
  const frame = (options: { impact?: boolean; tilted?: boolean; captureSkewMs?: number } = {}) => {
    t += 40;
    for (const source of sources) {
      const gravity: Vec3 = options.tilted ? [0, 0, -1] : [0, -1, 0];
      const p: MotionSample = {
        type: 'motion.sample', source, sensorLocation: source === 'chest-phone' ? 'phone' : 'Left',
        sessionId: `capture-freshness-${source}`, sequence: ++sequences[source],
        sensorTime: (t + offsets[source] + (options.captureSkewMs ?? captureSkewMs)) / 1000,
        quaternion: [0, 0, 0, 1], gravity, rotationRate: [0, 0, 0],
        userAcceleration: options.impact ? gravity.map(value => value * 2.2) as Vec3 : [0, 0, 0],
      };
      assert.equal(validSample(p, source), true);
      m.sample(source, p);
    }
  };
  for (let index = 0; index < 31; index++) frame();
  assert.deepEqual(m.calibrate(), sources);
  // Ping/pong uses the current device clock even when motion packets are delayed.
  for (const source of sources) {
    const ping = m.ping(source);
    assert.equal(m.pong(source, { type: 'clock.pong', id: ping.id, sessionId: `capture-freshness-${source}`,
      deviceReceivedMs: t + offsets[source], deviceSentMs: t + offsets[source] }), true);
  }
  frame({ impact: true });
  for (let index = 0; index < 81; index++) frame({ tilted: true });
  return { motion: m, frame };
}

test('fresh clock estimates do not make ten-second-old increasing capture timestamps usable', () => {
  const control = captureAgeFixture(0);
  assert.equal(control.motion.candidate()?.kind, 'cross-body', 'current captures support the synthetic positive control');
  const delayed = captureAgeFixture(-10_000);
  for (const view of delayed.motion.views()) {
    assert.equal(view.alignmentUncertaintyMs, 0, 'clock estimate is still current and precise');
    assert.equal(view.fresh, false, 'fresh packet receipt cannot conceal old capture time');
  }
  assert.equal(delayed.motion.candidate(), null);
});

test('one fresh packet cannot rehabilitate a fall and quiet window captured ten seconds ago', () => {
  const delayed = captureAgeFixture(-10_000);
  delayed.frame({ tilted: true, captureSkewMs: 0 });
  assert.equal(delayed.motion.candidate(), null, 'all incident evidence must be usable, not only the last packet');
});

test('capture timestamps more than 100 ms in the future cannot support live evidence', () => {
  const future = captureAgeFixture(1_000);
  for (const view of future.motion.views()) {
    assert.equal(view.alignmentUncertaintyMs, 0);
    assert.equal(view.fresh, false);
  }
  assert.equal(future.motion.candidate(), null);
});
