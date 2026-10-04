import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FreeWili, type BodyWiliSample } from './freewili.ts';
import { Motion } from './motion.ts';
import type { MotionSample, Vec3 } from './contracts.ts';
import { WiliAssessment } from './wili-assessment.ts';
import { Teaching } from './teaching.ts';
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
test('teaching captures original measurements, labels persist, and review stays paused until resume',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lifeline-teach-'));
 try{
 const f=fixture({fullScaleG:2,captureClock:'host-receipt'});f.settle(32);f.motion.calibrate(['waist-airpod']);
 const t=new Teaching(dir);t.start(f.wili,f.motion,f.now());
 assert.equal(t.practiceMode,true);assert.equal(t.recording,true);
 assert.throws(()=>t.start(f.wili,f.motion,f.now()),/already recording/);
 for(let i=0;i<150;i++){f.frame({angular:i%2?2:-2});t.tick(f.wili,f.motion,f.now());}
 assert.equal(t.recording,false);assert.equal(t.practiceMode,true);
 const e=t.view(f.now()).examples[0];assert.ok(e);assert.ok(e.bodySamples>0&&e.waistSamples>0);assert.equal(e.label,null);
 assert.throws(()=>t.label(e.id,'ankle-break'),/valid label/);
 assert.throws(()=>t.label('../outside','shaking'),/saved movement/);
 t.label(e.id,'shaking');assert.equal(new Teaching(dir).view().examples[0].label,'shaking');
 t.cancel();assert.equal(t.practiceMode,false);assert.equal(t.view().examples.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('teaching refuses disconnected or uncalibrated sensors without entering practice',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lifeline-teach-'));
 try{const f=fixture();const t=new Teaching(dir);assert.throws(()=>t.start(f.wili,f.motion,f.now()),/calibrate/);
 assert.equal(t.practiceMode,false);assert.equal(t.recording,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('damaged examples and interrupted temp writes do not prevent recorder startup', () => {
 const dir=mkdtempSync(join(tmpdir(),'lifeline-teach-corrupt-'));
 try {
  writeFileSync(join(dir,'broken.json'),'{truncated');
  writeFileSync(join(dir,'wrong.json'),JSON.stringify({id:'../outside',window:{version:1}}));
  writeFileSync(join(dir,'unfinished.json.tmp'),'{');
  const t=new Teaching(dir); assert.equal(t.view().examples.length,0);
  assert.equal(t.practiceMode,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('storage failure finishes recording without crashing or pretending it was saved', () => {
 const dir=mkdtempSync(join(tmpdir(),'lifeline-teach-storage-'));
 try {
  const f=fixture();f.settle(32);f.motion.calibrate(['waist-airpod']);
  const t=new Teaching(dir);t.start(f.wili,f.motion,f.now());
  rmSync(dir,{recursive:true,force:true});
  for(let i=0;i<150;i++){f.frame();assert.doesNotThrow(()=>t.tick(f.wili,f.motion,f.now()));}
  assert.equal(t.recording,false);assert.equal(t.practiceMode,true);
  assert.equal(t.view().examples.length,0);assert.match(t.view().error!,/could not be saved/);
  t.cancel();assert.equal(t.practiceMode,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('failed relabel leaves the original persisted label and no partial files', () => {
 const dir=mkdtempSync(join(tmpdir(),'lifeline-teach-label-'));
 try {
  const f=fixture();f.settle(32);f.motion.calibrate(['waist-airpod']);
  const t=new Teaching(dir);t.start(f.wili,f.motion,f.now());
  for(let i=0;i<150;i++){f.frame();t.tick(f.wili,f.motion,f.now());}
  const id=t.view().examples[0].id;t.label(id,'standing');
  assert.deepEqual(readdirSync(dir),[`${id}.json`]);
  rmSync(dir,{recursive:true,force:true});
  assert.throws(()=>t.label(id,'shaking'),/could not be saved/);
  assert.equal(t.view().examples[0].label,'standing');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
