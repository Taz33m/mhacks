import test from 'node:test';
import assert from 'node:assert/strict';
import { Motion } from './motion.ts';
import type { MotionSample, Source, Vec3 } from './contracts.ts';

// Deterministic synthetic algorithm fixtures. These vectors are not recordings
// of human falls and provide no evidence of physical detection accuracy.
type Mode = 'combined' | 'chest-only' | 'waist-only';
type Pose = 'upright' | 'tilted';
const sourceList: Source[] = ['chest-phone', 'waist-airpod'];
const upright: Vec3 = [0, -1, 0];
const tilted: Vec3 = [0, 0, -1];

class Fixture {
  now = 1_000;
  readonly motion: Motion;
  private sequences: Record<Source, number> = { 'chest-phone': 0, 'waist-airpod': 0 };
  private clockOffsets: Record<Source, number> = { 'chest-phone': 100_000, 'waist-airpod': 300_000 };
  private clockSequence = 0;

  constructor(mode: Mode = 'combined') { this.motion = new Motion(() => this.now, { mode }); }

  sample(source: Source, options: { pose?: Pose; impact?: number; moving?: boolean; gravity?: Vec3 } = {}): void {
    const gravity = options.gravity ?? (options.pose === 'tilted' ? tilted : upright);
    const sample: MotionSample = {
      type: 'motion.sample', source, sensorLocation: source === 'chest-phone' ? 'phone' : 'Left',
      sessionId: `synthetic-algorithm-${source}`, sequence: ++this.sequences[source],
      sensorTime: (this.now + this.clockOffsets[source]) / 1000,
      quaternion: [0, 0, 0, 1], gravity: [...gravity],
      rotationRate: options.moving ? [0, 0, 0.8] : [0, 0, 0],
      userAcceleration: options.impact ? gravity.map(value => value * (options.impact! - 1)) as Vec3
        : options.moving ? [0.3, 0, 0] : [0, 0, 0],
    };
    assert.equal(this.motion.sample(source, sample), true, `synthetic sample accepted: ${source} at ${this.now}`);
  }

  frame(options: {
    chestPose?: Pose; waistPose?: Pose; chestImpact?: number; waistImpact?: number;
    movingSource?: Source; omitSource?: Source;
  } = {}): void {
    this.now += 40;
    for (const source of sourceList) {
      if (source === options.omitSource) continue;
      this.sample(source, {
        pose: source === 'chest-phone' ? options.chestPose : options.waistPose,
        impact: source === 'chest-phone' ? options.chestImpact : options.waistImpact,
        moving: options.movingSource === source,
      });
    }
  }

  sync(sources: Source[] = sourceList): void {
    for (const source of sources) {
      const ping = this.motion.ping(source, `synthetic-clock-${++this.clockSequence}`);
      const deviceTime = this.now + this.clockOffsets[source];
      assert.equal(this.motion.pong(source, {
        type: 'clock.pong', id: ping.id, sessionId: `synthetic-algorithm-${source}`,
        deviceReceivedMs: deviceTime, deviceSentMs: deviceTime,
      }), true);
    }
  }

  calibrate(options: { omitSource?: Source; syncSources?: Source[] } = {}): void {
    for (let frame = 0; frame < 31; frame++) this.frame({ omitSource: options.omitSource });
    const expected = sourceList.filter(source => source !== options.omitSource);
    assert.deepEqual(this.motion.calibrate(), expected, 'requires over one continuous second of synthetic stillness');
    this.sync(options.syncSources ?? expected);
  }

  fall(options: { droppedPhone?: boolean; omitSource?: Source; quietFrames?: number; movingSource?: Source } = {}): void {
    this.frame({ chestImpact: 3.2, waistImpact: options.droppedPhone ? undefined : 2.8, omitSource: options.omitSource });
    for (let frame = 0; frame < (options.quietFrames ?? 81); frame++) {
      this.frame({ chestPose: 'tilted', waistPose: options.droppedPhone ? 'upright' : 'tilted',
        omitSource: options.omitSource, movingSource: options.movingSource });
    }
  }
}

test('synthetic staged impact, coordinated tilt and continuous quiet window produces cross-body evidence', () => {
  const f = new Fixture();
  f.calibrate();
  f.fall();
  const candidate = f.motion.candidate();
  assert.equal(candidate?.kind, 'cross-body');
  assert.deepEqual(candidate?.sourceSessions, {
    'chest-phone': 'synthetic-algorithm-chest-phone', 'waist-airpod': 'synthetic-algorithm-waist-airpod',
  });
});

test('synthetic staged impact can be assessed separately by each single-source diagnostic', () => {
  for (const mode of ['chest-only', 'waist-only'] as const) {
    const f = new Fixture(mode);
    f.calibrate();
    f.fall();
    const candidate = f.motion.candidate();
    const source: Source = mode === 'chest-only' ? 'chest-phone' : 'waist-airpod';
    assert.equal(candidate?.kind, 'single-source');
    assert.deepEqual(candidate?.sourceSessions, { [source]: `synthetic-algorithm-${source}` });
  }
});

test('synthetic dropped chest phone is rejected by combined evidence while chest-only diagnostic flags it', () => {
  for (const mode of ['combined', 'chest-only', 'waist-only'] as const) {
    const f = new Fixture(mode);
    f.calibrate();
    f.fall({ droppedPhone: true });
    const candidate = f.motion.candidate();
    if (mode === 'chest-only') {
      assert.equal(candidate?.kind, 'single-source');
      assert.deepEqual(candidate?.sourceSessions, { 'chest-phone': 'synthetic-algorithm-chest-phone' });
    } else assert.equal(candidate, null, `${mode} must reject unchanged upright waist`);
  }
});

test('synthetic abrupt sit or bend below impact threshold is rejected in every diagnostic mode', () => {
  for (const mode of ['combined', 'chest-only', 'waist-only'] as const) {
    const f = new Fixture(mode);
    f.calibrate();
    f.frame({ chestImpact: 1.8, waistImpact: 1.6 });
    for (let frame = 0; frame < 81; frame++) f.frame({ chestPose: 'tilted', waistPose: 'tilted' });
    assert.equal(f.motion.candidate(), null, `${mode}: posture change alone is insufficient`);
  }
});

test('synthetic ongoing chest or waist movement prevents a cross-body quiet-window candidate', () => {
  for (const movingSource of sourceList) {
    const f = new Fixture();
    f.calibrate();
    f.fall({ movingSource });
    assert.equal(f.motion.candidate(), null, `continuing ${movingSource} movement is not quiet`);
  }
});

test('synthetic packet gap inside quiet window cannot be bridged by enough samples before and after it', () => {
  for (const omitSource of sourceList) {
    const f = new Fixture();
    f.calibrate();
    f.frame({ chestImpact: 3.2, waistImpact: 2.8 });
    for (let frame = 0; frame < 81; frame++) {
      f.frame({ chestPose: 'tilted', waistPose: 'tilted',
        omitSource: frame >= 30 && frame < 38 ? omitSource : undefined });
    }
    assert.equal(f.motion.candidate(), null, `${omitSource}: a 360 ms sample interval is not continuous stillness`);
  }
});

test('synthetic trailing packet gap over 200 ms prevents a continuous quiet-window claim', () => {
  for (const omitSource of sourceList) {
    const f = new Fixture();
    f.calibrate();
    f.frame({ chestImpact: 3.2, waistImpact: 2.8 });
    for (let frame = 0; frame < 81; frame++) {
      f.frame({ chestPose: 'tilted', waistPose: 'tilted', omitSource: frame >= 75 ? omitSource : undefined });
    }
    assert.equal(f.motion.views().find(view => view.source === omitSource)?.fresh, true,
      '240 ms trailing silence is inside source freshness tolerance');
    assert.equal(f.motion.candidate(), null, `${omitSource}: the quiet window must extend to the assessment time`);
  }
});

test('synthetic missing or stale source clocks cannot support cross-body claims', () => {
  for (const unalignedSource of sourceList) {
    const freshClockSource = sourceList.filter(source => source !== unalignedSource);
    const missing = new Fixture();
    missing.calibrate({ syncSources: freshClockSource });
    missing.fall();
    assert.equal(missing.motion.candidate(), null, `${unalignedSource}: no clock estimate`);

    const stale = new Fixture();
    stale.calibrate();
    // Clock estimates exist during the impact/tilt, but one estimate expires
    // before the quiet-window decision. Continuous packets alone do not renew it.
    for (let frame = 0; frame < 340; frame++) stale.frame();
    stale.sync(freshClockSource);
    stale.fall();
    assert.equal(stale.motion.views().find(view => view.source === unalignedSource)?.alignmentUncertaintyMs, null);
    assert.equal(stale.motion.candidate(), null, `${unalignedSource}: earlier aligned points cannot substitute for fresh clock health`);
  }
});

test('synthetic combined-mode fallback when waist is absent is explicitly single-source', () => {
  const f = new Fixture();
  f.calibrate({ omitSource: 'waist-airpod' });
  f.fall({ omitSource: 'waist-airpod' });
  const candidate = f.motion.candidate();
  assert.equal(candidate?.kind, 'single-source');
  assert.deepEqual(candidate?.sourceSessions, { 'chest-phone': 'synthetic-algorithm-chest-phone' });
  assert.match(candidate?.summary ?? '', /chest-only/i);
});

test('synthetic detector cooldown suppresses repeated candidates but later independent evidence can fire', () => {
  const f = new Fixture();
  f.calibrate();
  f.fall();
  assert.equal(f.motion.candidate()?.kind, 'cross-body');
  assert.equal(f.motion.candidate(), null);
  // Continue receiving upright samples and refresh clocks while cooldown passes.
  for (let frame = 0; frame < 50; frame++) f.frame();
  f.fall();
  assert.equal(f.motion.candidate(), null, 'second fall-like window inside 20-second cooldown');
  for (let frame = 0; frame < 380; frame++) {
    f.frame();
    if (frame % 50 === 0) f.sync();
  }
  f.fall();
  assert.equal(f.motion.candidate()?.kind, 'cross-body', 'new evidence after cooldown');
});

test('synthetic short calibration window is rejected', () => {
  const short = new Fixture();
  for (let frame = 0; frame < 5; frame++) short.frame();
  assert.deepEqual(short.motion.calibrate(), [], 'five samples do not establish one second of stillness');
});

test('synthetic moving calibration window is rejected despite consistent gravity direction', () => {
  const rotating = new Fixture();
  for (let frame = 0; frame < 31; frame++) rotating.frame({ movingSource: frame % 2 ? 'chest-phone' : 'waist-airpod' });
  assert.deepEqual(rotating.motion.calibrate(), [], 'motion during calibration must be rejected');
});

test('synthetic unstable gravity direction is rejected despite a plausible average norm', () => {
  const inconsistent = new Fixture();
  for (let frame = 0; frame < 31; frame++) {
    inconsistent.now += 40;
    for (const source of sourceList) inconsistent.sample(source, {
      gravity: frame % 2 ? [0, -Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)] : [0, -Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)],
    });
  }
  assert.deepEqual(inconsistent.motion.calibrate(), [], 'an average gravity norm is not sufficient for unstable posture');
});
