import test from 'node:test';
import assert from 'node:assert/strict';
import { Motion, validSample } from './motion.ts';
import type { MotionSample } from './contracts.ts';
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
  for (let seq = 1; seq <= 20; seq++) { t += 40; assert.equal(m.sample('waist-airpod', sample(seq)), true); }
  assert.deepEqual(m.calibrate(), ['waist-airpod']); assert.equal(m.sample('waist-airpod', sample(20)), false);
  t += 600; m.sample('waist-airpod', sample(21)); assert.equal(m.views()[1].calibrated, false);
  for (let seq = 22; seq <= 30; seq++) { t += 40; m.sample('waist-airpod', sample(seq)); }
  m.calibrate(); assert.equal(m.views()[1].calibrated, true);
  m.sample('waist-airpod', { ...sample(31), sensorLocation: 'Right' }); assert.equal(m.views()[1].calibrated, false);
});
test('ping/pong records bounded clock uncertainty without inventing synchronized samples', () => {
  let t = 100; const m = new Motion(() => t); m.sample('waist-airpod', sample());
  const ping = m.ping('waist-airpod'); t += 10;
  assert.equal(m.pong('waist-airpod', { type: 'clock.pong', id: ping.id, sessionId: 'test-session', deviceReceivedMs: 5000, deviceSentMs: 5001 }), true);
  assert.equal(m.views()[1].alignmentUncertaintyMs, 4.5);
  assert.equal(m.pong('waist-airpod', { type: 'clock.pong', id: ping.id, sessionId: 'old-session', deviceReceivedMs: 1, deviceSentMs: 2 }), false);
  t += 16_000; assert.equal(m.views()[1].alignmentUncertaintyMs, null); assert.equal(m.views()[1].fresh, false);
});
