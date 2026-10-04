import test from 'node:test';
import assert from 'node:assert/strict';
import { FreeWili, type BodyWiliSample } from './freewili.ts';
import { Motion } from './motion.ts';
import type { MotionSample, Vec3 } from './contracts.ts';
import { WiliAssessment } from './wili-assessment.ts';
import { EarlyCheckinAssessment, detectionProfile } from './early-checkin-assessment.ts';
import { Controller } from './controller.ts';
function fixture(options: { fullScaleG?: BodyWiliSample['fullScaleG']; bodySkewMs?: number; waistSkewMs?: number;
  bodySync?: boolean; waistSync?: boolean; clockRoundTripMs?: number; captureClock?: BodyWiliSample['captureClock'] } = {}) {
  let time = 1000, bodySequence = -1, waistSequence = -1;
  const wili = new FreeWili(() => time), motion = new Motion(() => time), detector = new WiliAssessment(() => time);
  wili.connected(); motion.connected('waist-airpod');
  const frame = (values: { bodyG?: Vec3; linear?: number; angular?: number; saturated?: boolean; skipWaist?: boolean;
    skipBody?: boolean; bodySkewMs?: number; waistSkewMs?: number; waistSession?: string } = {}, advance = 40) => {
    time += advance;
    if (!values.skipBody) {
      const body: BodyWiliSample = { type: 'accel.sample', source: 'body-wili', sessionId: 'fixture-wili-session',
        sequence: ++bodySequence, sensorTime: (time + 100000 + (values.bodySkewMs ?? options.bodySkewMs ?? 0)) / 1000,
        captureClock: options.captureClock ?? 'device-monotonic', accelerationG: values.bodyG ?? [0, 0, 1], fullScaleG: options.fullScaleG ?? 8,
        ...(options.captureClock === 'host-receipt' ? { frameTimestamp: String(bodySequence) } : {}),
        fresh: true, saturated: values.saturated ?? false, quality: 'measured' };
      assert.equal(wili.sample(body), true);
    }
    if (!values.skipWaist) {
      const waist: MotionSample = { type: 'motion.sample', source: 'waist-airpod', sensorLocation: 'Left',
        sessionId: values.waistSession ?? 'fixture-waist-session', sequence: ++waistSequence,
        sensorTime: (time + 300000 + (values.waistSkewMs ?? options.waistSkewMs ?? 0)) / 1000,
        quaternion: [0, 0, 0, 1], gravity: [0, 0, -1], userAcceleration: [values.linear ?? 0, 0, 0],
        rotationRate: [0, values.angular ?? 0, 0] };
      assert.equal(motion.sample('waist-airpod', waist), true);
    }
  };
  frame({}, 0);
  const sync = (bodySync = true, waistSync = true) => {
    const bodyPing = bodySync ? wili.ping() : null, waistPing = waistSync ? motion.ping('waist-airpod') : null;
    const roundTrip = options.clockRoundTripMs ?? 0;
    time += roundTrip;
    if (bodyPing) assert.equal(wili.pong({ type: 'clock.pong', id: bodyPing.id, sessionId: 'fixture-wili-session',
      deviceReceivedMs: time - roundTrip / 2 + 100000, deviceSentMs: time - roundTrip / 2 + 100000 }), true);
    if (waistPing) assert.equal(motion.pong('waist-airpod', { type: 'clock.pong', id: waistPing.id, sessionId: 'fixture-waist-session',
      deviceReceivedMs: time - roundTrip / 2 + 300000, deviceSentMs: time - roundTrip / 2 + 300000 }), true);
  };
  sync(options.bodySync !== false, options.waistSync !== false);
  for (let index = 0; index < 10; index++) frame();
  return { wili, motion, detector, frame, now: () => time, advance(ms: number) { time += ms; },
    settle(count = 82, change: (index: number) => Parameters<typeof frame>[0] = () => ({})) {
      for (let index = 0; index < count; index++) frame(change(index));
    },
    candidate() { return detector.candidate(wili, motion); } };
}
function ready() {
  const f = fixture({ fullScaleG: 2, captureClock: 'host-receipt' });
  f.settle(32); f.motion.calibrate(['waist-airpod']);
  assert.equal(f.motion.views().find(v => v.source === 'waist-airpod')?.calibrated, true);
  return { ...f, early: new EarlyCheckinAssessment(f.now) };
}
test('paired motion opens an early check-in without floor impact or stillness', () => {
  const f = ready(); f.frame({ bodyG: [0, 0, 1.8], angular: 1.5 });
  assert.equal(f.candidate(), null, 'original fall confirmation still requires post-event quiet');
  const e = f.early.candidate(f.wili, f.motion); assert.ok(e);
  assert.equal(e.eventType, 'possible-balance-loss'); assert.equal(e.assessment, undefined);
  assert.equal(e.onset?.acceleration.totalG, 1.8);
  assert.match(e.summary, /floor impact and stillness not established/);
  const c = new Controller(':memory:', [{ id: 'maya', name: 'Maya', phone: null }]);
  try {
    const i = c.trigger(e); assert.equal(i.phase, 'CONFIRMING');
    assert.match(c.actions(i.id).find(a => a.type === 'wearer_checkin')!.text, /possible loss of balance/);
    assert.equal(c.actions(i.id).some(a => a.type === 'alert'), false, 'assessment first checks on wearer');
  } finally { c.close(); }
  assert.equal(f.early.candidate(f.wili, f.motion), null);
  f.early.reset({ cooldown: false }); assert.equal(f.early.candidate(f.wili, f.motion), null, 'reset cannot replay consumed readings');
});
test('an uncalibrated waist still starts a check-in (calibration is optional)', () => {
  const f = ready(); f.motion.reset();
  f.frame({ bodyG: [0, 0, 1.8], angular: 1.5 });
  assert.equal(f.early.candidate(f.wili, f.motion)?.eventType, 'possible-balance-loss');
});
test('neither sensor alone nor a disconnected waist starts a check-in', () => {
  for (const mode of ['body-only', 'waist-only', 'disconnected'] as const) {
    const f = ready();
    f.frame({ bodyG: mode === 'waist-only' ? [0, 0, 1] : [0, 0, 1.8], angular: mode === 'body-only' ? 0 : 1.5 });
    if (mode === 'disconnected') f.motion.disconnected('waist-airpod');
    assert.equal(f.early.candidate(f.wili, f.motion), null, mode);
  }
});
test('stale, unaligned and uncorrelated readings cannot trigger early check-in', () => {
  for (const mode of ['stale', 'misaligned', 'separated', 'body-disconnected'] as const) {
    const f = ready();
    if (mode === 'separated') {
      f.frame({ angular: 1.5 }); f.settle(21);
      f.frame({ bodyG: [0, 0, 1.8] });
    } else f.frame({ bodyG: [0, 0, 1.8], angular: 1.5, ...(mode === 'misaligned' ? { waistSkewMs: 2000 } : {}) });
    if (mode === 'stale') f.advance(1600);
    if (mode === 'body-disconnected') f.wili.disconnected();
    assert.equal(f.early.candidate(f.wili, f.motion), null, mode);
  }
});
test('clipped chest readings are labelled as lower bounds, not exact impacts', () => {
  const f = ready(); f.frame({ bodyG: [0, 0, 1.99], angular: 1.5, saturated: true });
  const e = f.early.candidate(f.wili, f.motion); assert.ok(e);
  assert.match(e.summary, /at least 2.00 g \(sensor limit\)/);
});
test('early profile is opt-in and rejects misspelled configuration', () => {
  assert.equal(detectionProfile(undefined), 'fall-confirmation');
  assert.equal(detectionProfile('early-checkin'), 'early-checkin');
  assert.throws(() => detectionProfile('early'), /LIFELINE_DETECTION_PROFILE/);
});
