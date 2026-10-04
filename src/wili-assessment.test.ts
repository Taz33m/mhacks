import test from 'node:test';
import assert from 'node:assert/strict';
import { FreeWili, type BodyWiliSample } from './freewili.ts';
import { Motion } from './motion.ts';
import type { MotionSample, Vec3 } from './contracts.ts';
import { WiliAssessment } from './wili-assessment.ts';

// Deterministic sensor/clock fixtures establish software behavior, not fall accuracy.
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
function positive() {
  const f = fixture(); f.frame({ bodyG: [0, 0, 3.2], linear: .6, angular: 1.4 }); f.settle(); return f;
}

test('aligned WILi impact + waist movement + continuous quiet yields frozen source-labelled evidence', () => {
  const f = positive(), evidence = f.candidate();
  assert.ok(evidence); assert.equal(evidence.kind, 'cross-body');
  assert.deepEqual(evidence.sourceSessions, { 'body-wili': 'fixture-wili-session', 'waist-airpod': 'fixture-waist-session' });
  assert.equal(evidence.assessment.impact.totalG, 3.2);
  assert.equal(evidence.assessment.selectedImpactG, 2.5);
  assert.equal(evidence.assessment.alignmentAtAssessment.bodyClock, 'device-monotonic');
  assert.equal(evidence.assessment.impact.sensorTime * 1000 - evidence.assessment.impact.alignedAtMs, 100000);
  assert.equal(evidence.assessment.supportingWaist.sensorTime * 1000 - evidence.assessment.supportingWaist.alignedAtMs, 300000);
  assert.equal(evidence.assessment.supportingWaist.linearG, .6); assert.equal(evidence.assessment.supportingWaist.angularSpeed, 1.4);
  assert.equal(evidence.assessment.supportingWaist.separationMs, 0);
  assert.ok(evidence.assessment.quietWaist.durationMs >= 2200); assert.ok(evidence.assessment.quietWaist.sampleCount >= 50);
  assert.equal(evidence.assessment.quietWaist.maxLinearG, 0); assert.equal(evidence.assessment.quietWaist.maxAngularSpeed, 0);
  assert.match(evidence.summary, /Possible fall: 3\.20 g impact with waist movement/);
  assert.match(evidence.summary, /Possible fall/);
  assert.equal(evidence.assessment.impact.saturated, false); assert.doesNotMatch(evidence.summary, /≥|sensor limit/);
  assert.doesNotMatch(evidence.summary, /chest|head|orientation|accuracy/i);
  assert.equal(f.motion.views()[1].calibrated, false, 'movement features require no invented orientation baseline');
  assert.equal(Object.isFrozen(evidence.assessment.impact.accelerationG), true);
  assert.throws(() => { evidence.assessment.impact.accelerationG[2] = 10; }, TypeError);
  const copy = f.wili.observations(); copy.at(-1)!.sample.accelerationG[2] = 9;
  const waistCopy = f.motion.observations('waist-airpod'); waistCopy[0].linearG = 9;
  assert.equal(f.motion.observations('waist-airpod')[0].linearG, 0);
  assert.equal(evidence.assessment.impact.totalG, 3.2);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)).assessment.impact.accelerationG, [0, 0, 3.2]);
  assert.equal(f.candidate(), null, 'one impact cannot emit repeated incidents');
  f.detector.reset({ cooldown: false }); assert.equal(f.candidate(), null, 'reset cannot replay an already emitted identity');
});

test('stock 2g profile freezes lower selected threshold and labels bridge receipt timing without a board clock claim', () => {
  const f = fixture({ fullScaleG: 2, captureClock: 'host-receipt' });
  f.frame({ bodyG: [0, 0, 1.8], linear: .6, angular: 1.4 }); f.settle();
  const evidence = f.candidate(); assert.ok(evidence);
  assert.equal(evidence.assessment.selectedImpactG, 1.65); assert.equal(evidence.assessment.thresholds.impactG, 2.5);
  assert.equal(evidence.assessment.thresholds.stockImpactG, 1.65);
  assert.equal(evidence.assessment.impact.captureClock, 'host-receipt');
  assert.equal(evidence.assessment.impact.fullScaleG, 2); assert.equal(evidence.assessment.impact.totalG, 1.8);
  assert.equal(evidence.assessment.impact.frameTimestamp, '11');
  assert.equal(evidence.assessment.alignmentAtAssessment.bodyClock, 'host-receipt');
  assert.match(evidence.summary, /Possible fall: 1\.80 g impact/);
  assert.match(evidence.summary, /Possible fall/); assert.doesNotMatch(evidence.summary, /demo|prototype/i);
  const stricter = new WiliAssessment(f.now, { stockImpactG: 1.9 }); assert.equal(stricter.candidate(f.wili, f.motion), null);
  const custom = fixture(); custom.frame({ bodyG: [0, 0, 1.8], linear: .6 }); custom.settle(); assert.equal(custom.candidate(), null);
});

test('stock host-receipt profile still requires correlated waist evidence; clipped acceleration counts as at least full scale', () => {
  const boardOnly = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); boardOnly.frame({ bodyG: [0, 0, 1.8] }); boardOnly.settle();
  assert.equal(boardOnly.candidate(), null);
  for (const event of [{ bodyG: [0, 0, 1.99] as Vec3, linear: .6 }, { bodyG: [0, 0, 1.8] as Vec3, linear: .6, saturated: true }]) {
    const f = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); f.frame(event); f.settle();
    const evidence = f.candidate(); assert.ok(evidence, 'near-clip or device-flagged clipping is impact evidence, not a rejection');
    assert.equal(evidence.assessment.impact.saturated, true); assert.equal(evidence.assessment.impact.totalG, event.bodyG[2]);
    assert.match(evidence.summary, /^Possible fall: ≥2\.00 g impact \(sensor limit\) with waist movement 0 ms apart/);
  }
});

test('waist linear movement or measured rotation independently support a correlated primary impact', () => {
  for (const motion of [{ linear: .6 }, { angular: 1.4 }]) {
    const f = fixture(); f.frame({ bodyG: [0, 0, 3.2], ...motion }); f.settle(); assert.ok(f.candidate());
  }
});

test('board-only impact, waist-only movement, and ordinary quiet do not create cross-body incidents', () => {
  for (const event of [{ bodyG: [0, 0, 3.2] as Vec3 }, { linear: .6, angular: 1.4 }, {}]) {
    const f = fixture(); f.frame(event); f.settle(); assert.equal(f.candidate(), null);
  }
});

test('waist support outside capture correlation window cannot rehabilitate a later board impact', () => {
  const f = fixture(); f.frame({ linear: .6, angular: 1.4 });
  for (let index = 0; index < 24; index++) f.frame();
  f.frame({ bodyG: [0, 0, 3.2] }); f.settle(); assert.equal(f.candidate(), null);
});

test('moving wearer, short quiet window, and missing quiet packets keep the candidate unresolved', () => {
  const moving = fixture(); moving.frame({ bodyG: [0, 0, 3.2], linear: .6 });
  moving.settle(82, index => index === 60 ? { linear: .3 } : {}); assert.equal(moving.candidate(), null);
  const short = fixture(); short.frame({ bodyG: [0, 0, 3.2], angular: 1.4 }); short.settle(60); assert.equal(short.candidate(), null);
  const gap = fixture(); gap.frame({ bodyG: [0, 0, 3.2], linear: .6 });
  gap.settle(82, index => ({ skipWaist: index >= 35 && index <= 41 }));
  assert.equal(gap.motion.views()[1].fresh, true); assert.equal(gap.candidate(), null, 'fresh latest packet cannot fill missing history');
});

test('stale, disconnected, unsynchronized, and uncertain sources never fall back to one device', () => {
  const stale = positive(); stale.advance(500); assert.equal(stale.candidate(), null, 'an alive board cannot stand in for a stale waist');
  const missingWaist = positive(); missingWaist.motion.disconnected('waist-airpod'); assert.equal(missingWaist.candidate(), null);
  const missingBody = positive(); missingBody.wili.disconnected(); assert.equal(missingBody.candidate(), null);
  for (const options of [{ bodySync: false }, { waistSync: false }, { clockRoundTripMs: 300 }]) {
    const f = fixture(options); f.frame({ bodyG: [0, 0, 3.2], linear: .6 }); f.settle(); assert.equal(f.candidate(), null);
  }
});

test('saturated impact is labelled at-least-full-scale evidence; insufficient range is never detector evidence', () => {
  const saturation = fixture(); saturation.frame({ bodyG: [0, 0, 3.2], linear: .6, saturated: true }); saturation.settle();
  assert.equal(saturation.wili.view().usable, true, 'current sample may be fine while old impact was clipped');
  const clipped = saturation.candidate(); assert.ok(clipped);
  assert.equal(clipped.assessment.impact.saturated, true); assert.equal(clipped.assessment.impact.totalG, 3.2);
  assert.match(clipped.summary, /^Possible fall: ≥8\.00 g impact \(sensor limit\) with waist movement/);
  const nearClip = fixture({ fullScaleG: 4 }); nearClip.frame({ bodyG: [0, 0, 3.95], angular: 1.4 }); nearClip.settle();
  const near = nearClip.candidate(); assert.ok(near); assert.equal(near.assessment.impact.saturated, true);
  assert.match(near.summary, /^Possible fall: ≥4\.00 g impact \(sensor limit\)/);
  const narrow = fixture({ fullScaleG: 2 }); narrow.frame({ bodyG: [1.9, 1.9, 0], linear: .6 }); narrow.settle();
  assert.equal(narrow.wili.view().quality, 'insufficient-range'); assert.equal(narrow.candidate(), null);
});

test('clipped stock WILi impact + correlated waist movement + quiet yields a candidate labelled at the sensor limit', () => {
  const f = fixture({ fullScaleG: 2, captureClock: 'host-receipt' });
  f.frame({ bodyG: [0, 0, 2.044], linear: .6, angular: 1.4, saturated: true }); f.settle();
  const evidence = f.candidate(); assert.ok(evidence);
  assert.equal(evidence.assessment.impact.saturated, true); assert.equal(evidence.assessment.impact.totalG, 2.044);
  assert.equal(evidence.assessment.impact.fullScaleG, 2); assert.equal(evidence.assessment.selectedImpactG, 1.65);
  assert.equal(evidence.assessment.impact.captureClock, 'host-receipt');
  assert.match(evidence.summary, /^Possible fall: ≥2\.00 g impact \(sensor limit\) with waist movement 0 ms apart, then \d+\.\d s of stillness\.$/);
  assert.doesNotMatch(evidence.summary, /chest|head|orientation|accuracy/i);
  assert.equal(Object.isFrozen(evidence.assessment.impact), true);
  assert.equal(f.candidate(), null, 'one clipped impact cannot emit repeated incidents');
  const atLimit = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); atLimit.frame({ bodyG: [0, 0, 2], linear: .6 }); atLimit.settle();
  const limit = atLimit.candidate(); assert.ok(limit);
  assert.equal(limit.assessment.impact.saturated, true, 'adapter conservatively flags near full scale even without a device flag');
  assert.match(limit.summary, /^Possible fall: ≥2\.00 g impact \(sensor limit\) with waist movement 0 ms apart, then \d+\.\d s of stillness\.$/);
});

test('alive WILi whose latest sample is 1-2 s old still detects; sparse at-rest reporting is not a stale source', () => {
  const silent = fixture(); silent.frame({ bodyG: [0, 0, 3.2], linear: .6 });
  silent.settle(82, index => ({ skipBody: index >= 40 }));
  assert.equal(silent.wili.view().receivedAgeMs, 1680); assert.equal(silent.wili.view().fresh, false);
  assert.ok(silent.candidate());
  // Stock board: clipped impact, then about 1 Hz at rest; latest report 1.28 s old at assessment.
  const stock = fixture({ fullScaleG: 2, captureClock: 'host-receipt' });
  stock.frame({ bodyG: [0.4, 0.3, 2.044], linear: .7, angular: 1.4, saturated: true });
  stock.settle(82, index => ({ skipBody: index !== 24 && index !== 49 }));
  assert.equal(stock.wili.view().receivedAgeMs, 1280); assert.equal(stock.wili.view().quality, 'stale');
  const evidence = stock.candidate(); assert.ok(evidence);
  assert.equal(evidence.assessment.impact.saturated, true);
  assert.match(evidence.summary, /^Possible fall: ≥2\.00 g impact \(sensor limit\) with waist movement 0 ms apart/);
});

test('WILi silent for 3 s or more, disconnected, or rebooted at assessment never yields a waist-only candidate', () => {
  const clipped = { bodyG: [0, 0, 2.044] as Vec3, linear: .6, angular: 1.4, saturated: true };
  for (const [lastBodyIndex, ageMs] of [[6, 3000], [4, 3080], [-1, 3280]]) {
    const f = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); f.frame(clipped);
    f.settle(82, index => ({ skipBody: index > lastBodyIndex }));
    assert.equal(f.wili.view().receivedAgeMs, ageMs); assert.equal(f.motion.views()[1].fresh, true);
    assert.equal(f.candidate(), null);
  }
  const inside = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); inside.frame(clipped);
  inside.settle(82, index => ({ skipBody: index > 7 }));
  assert.equal(inside.wili.view().receivedAgeMs, 2960); assert.ok(inside.candidate(), 'still inside the alive window');
  const disconnected = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); disconnected.frame(clipped); disconnected.settle();
  disconnected.wili.disconnected(); assert.equal(disconnected.candidate(), null);
  const rebooted = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); rebooted.frame(clipped); rebooted.settle(70);
  rebooted.wili.disconnected(); rebooted.wili.connected();
  const at = rebooted.now();
  assert.equal(rebooted.wili.sample({ type: 'accel.sample', source: 'body-wili', sessionId: 'fixture-wili-reboot', sequence: 0,
    sensorTime: (at + 100000) / 1000, captureClock: 'host-receipt', frameTimestamp: '1', accelerationG: [0, 0, 1], fullScaleG: 2,
    fresh: true, saturated: false, quality: 'measured' }), true);
  const ping = rebooted.wili.ping();
  assert.equal(rebooted.wili.pong({ type: 'clock.pong', id: ping.id, sessionId: 'fixture-wili-reboot',
    deviceReceivedMs: at + 100000, deviceSentMs: at + 100000 }), true);
  rebooted.settle(12, () => ({ skipBody: true }));
  assert.equal(rebooted.wili.view().sessionId, 'fixture-wili-reboot'); assert.equal(rebooted.wili.view().alignmentUncertaintyMs, 0);
  assert.equal(rebooted.candidate(), null, 'a new board session cannot inherit the retired session impact');
});

test('phone-drop style clipped WILi impact without correlated waist movement never yields a candidate', () => {
  const drop = { bodyG: [1.2, -.8, 2.044] as Vec3, saturated: true };
  const dropped = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); dropped.frame(drop); dropped.settle();
  assert.equal(dropped.candidate(), null);
  const sparse = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); sparse.frame(drop);
  sparse.settle(82, index => ({ skipBody: index !== 24 && index !== 49 })); assert.equal(sparse.candidate(), null);
  const pickedUpLater = fixture({ fullScaleG: 2, captureClock: 'host-receipt' }); pickedUpLater.frame(drop);
  for (let index = 0; index < 24; index++) pickedUpLater.frame();
  pickedUpLater.frame({ linear: .6, angular: 1.4 }); pickedUpLater.settle();
  assert.equal(pickedUpLater.candidate(), null, 'waist movement 1 s after the board impact is outside the correlation window');
});

test('delayed/future capture timestamps cannot be justified by current host receipt or one later fresh packet', () => {
  for (const options of [{ bodySkewMs: -10000 }, { waistSkewMs: -10000 }, { bodySkewMs: 1000 }, { waistSkewMs: 1000 }]) {
    const f = fixture(options); f.frame({ bodyG: [0, 0, 3.2], linear: .6 }); f.settle(); assert.equal(f.candidate(), null);
    if ((options.bodySkewMs ?? options.waistSkewMs)! < 0) {
      f.frame({ bodySkewMs: 0, waistSkewMs: 0 });
      assert.equal(f.candidate(), null, 'old impact/support/quiet are not rehabilitated by fresh final samples');
    }
  }
});

test('changed waist session cannot reuse another session movement support', () => {
  const f = fixture(); f.frame({ bodyG: [0, 0, 3.2], linear: .6 });
  f.settle(82, () => ({ waistSession: 'fixture-new-waist-session' }));
  assert.equal(f.motion.views()[1].sessionId, 'fixture-new-waist-session'); assert.equal(f.candidate(), null);
});

test('provisional thresholds can be configured without changing live measurements; cooldown suppresses new peaks', () => {
  const f = positive();
  const stricter = new WiliAssessment(f.now, { impactG: 3.5 }); assert.equal(stricter.candidate(f.wili, f.motion), null);
  assert.ok(f.candidate());
  f.frame({ bodyG: [0, 0, 3.4], angular: 1.4 }); f.settle(); assert.equal(f.candidate(), null);
  const noCooldown = new WiliAssessment(f.now, { cooldownMs: 0 }); assert.ok(noCooldown.candidate(f.wili, f.motion));
  for (const threshold of [{ impactG: 1 }, { quietMs: NaN }, { maxAlignmentUncertaintyMs: 101 }, { maxEventAgeMs: 1000 }])
    assert.throws(() => new WiliAssessment(f.now, threshold), /Invalid provisional/);
});
