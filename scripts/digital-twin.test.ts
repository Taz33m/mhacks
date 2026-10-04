import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validBodyWiliSample } from '../src/freewili.ts';
import { validSample } from '../src/motion.ts';
const twin = await import(new URL('../public/twin/kinematics.js', import.meta.url).href);

test('static attachment at rest has gravity, no angular motion and separate chest/waist placement', () => {
  const sample = twin.sampleAt('fall', .5);
  assert.equal(sample.schema, 'lifeline.offline-kinematics.v1');
  assert.equal(sample.provenance, 'synthetic-kinematic');
  assert.ok(Math.abs(sample.sensors.chest.totalG - 1) < 1e-9);
  assert.ok(Math.abs(sample.sensors.chest.angularSpeed) < 1e-9);
  assert.ok(sample.sensors.chest.positionM[1] > sample.sensors.waist.positionM[1]);
  assert.equal(validBodyWiliSample(sample), false);
  assert.equal(validSample(sample, 'waist-airpod'), false, 'offline schema cannot be replayed as a measured packet');
});
test('both virtual attachments derive nonzero motion then a stationary fallen pose', () => {
  const moving = twin.sampleAt('fall', 2.2), quiet = twin.sampleAt('fall', 6);
  assert.ok(moving.sensors.chest.angularSpeed > 1); assert.ok(moving.sensors.waist.angularSpeed > 1);
  assert.ok(Math.abs(quiet.sensors.chest.totalG - 1) < 1e-8);
  assert.ok(quiet.sensors.chest.angularSpeed < 1e-8);
  assert.ok(twin.traceFor('fall').some((s: any) => s.sensors.chest.clipped));
  assert.match(twin.timingGate('fall', 4), /accumulating/);
  assert.match(twin.timingGate('fall', 6), /Illustrative/);
});
test('synthetic shaking is bounded and alternating; daily gait trend retains intervals with no clinical interpretation', () => {
  const samples = twin.traceFor('shaking');
  assert.equal(samples.length, 481);
  const middle = samples.filter((s: any) => s.timeSeconds > 2 && s.timeSeconds < 5);
  assert.ok(middle.some((s: any) => s.sensors.waist.rotationRate[2] > 1));
  assert.ok(middle.some((s: any) => s.sensors.waist.rotationRate[2] < -1));
  for (const scenario of ['fall', 'shaking', 'gait']) for (const sample of twin.traceFor(scenario)) {
    assert.ok(sample.sensors.chest.accelerationG.every(Number.isFinite));
    assert.ok(sample.sensors.waist.accelerationG.every(Number.isFinite));
    assert.ok(sample.sensors.chest.deviceAccelerationG.every((n: number) => Math.abs(n) <= 2));
  }
  const days = twin.gaitDays(); assert.equal(days.length, 28);
  assert.ok(days[27].variabilityPercent > days[0].variabilityPercent);
  assert.equal(days[0].stepIntervalsSeconds.length, 40); assert.equal(days[0].clinicalInterpretation, null);
  assert.throws(() => twin.traceFor('constructor')); assert.throws(() => twin.traceFor('fall', 1, 0));
});
test('twin browser has no live ingestion, state fetch, websocket, classifier or training dependency', () => {
  for (const file of ['public/twin/kinematics.js', 'public/twin/lab.js', 'scripts/digital-twin/export-traces.mjs']) {
    const code = readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /new WebSocket|fetch\(['"`].*api\/|from ['"].*src\/|candidate\(/);
  }
  const rig = readFileSync('scripts/digital-twin/rig-person.py', 'utf8');
  assert.match(rig, /from rigify.generate import generate_rig/);
  assert.match(rig, /lifeline_fit_reviewed/);
  assert.match(rig, /source == output or output.exists/);
});

test('walking rig keeps leg lengths fixed and alternates ground contact with lifted feet', () => {
  const lifted = { left: false, right: false }, planted = { left: false, right: false };
  for (let i = 0; i <= 480; i++) {
    const pose = twin.poseAt('gait', i / 60);
    for (const side of ['left', 'right'] as const) {
      const hip = pose.joints[`${side}Hip`], knee = pose.joints[`${side}Knee`], foot = pose.joints[`${side}Foot`];
      const length = (a: number[], b: number[]) => Math.hypot(...a.map((v, axis) => v - b[axis]));
      assert.ok(Math.abs(length(hip, knee) - .43) < 1e-6);
      assert.ok(Math.abs(length(knee, foot) - .44) < 1e-6);
      assert.ok(foot[1] >= .065 - 1e-9, 'feet do not pass through the floor');
      lifted[side] ||= foot[1] > .17;
      planted[side] ||= Math.abs(foot[1] - .065) < 1e-6;
    }
  }
  assert.ok(lifted.left && lifted.right && planted.left && planted.right);
});
