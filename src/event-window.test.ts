import test from 'node:test';
import assert from 'node:assert/strict';
import { FreeWili, type BodyWiliSample } from './freewili.ts';
import { Motion } from './motion.ts';
import type { MotionSample, Vec3 } from './contracts.ts';
import { WiliAssessment } from './wili-assessment.ts';
import { EventWindowCapture } from './event-window.ts';
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
function captureReady() {
 const f=fixture({fullScaleG:2,captureClock:'host-receipt'});f.settle(70);f.motion.calibrate(['waist-airpod']);f.settle(50);
 const onset=f.now();
 const capture=new EventWindowCapture({kind:'cross-body',summary:'Measured paired onset', sourceSessions:{'body-wili':'fixture-wili-session','waist-airpod':'fixture-waist-session'}},onset);
 return {...f,capture,onset};
}
test('window retains pre-trigger measurements, waits four seconds, and cannot complete twice',()=>{
 const f=captureReady();assert.equal(f.capture.collect(f.wili,f.motion,f.now()),null);
 f.settle(100);const window=f.capture.collect(f.wili,f.motion,f.now());assert.ok(window);
 assert.ok(window.body.some(p=>p.atMs<f.onset));assert.ok(window.waist.some(p=>p.atMs>f.onset));
 assert.equal(window.classification,'recovered-motion',JSON.stringify(window.quality)); assert.equal(f.capture.collect(f.wili,f.motion,f.now()),null);
 const c=new Controller(':memory:',[{id:'maya',name:'Maya',phone:null}]);
 try {const i=c.trigger({kind:'cross-body',summary:'Measured onset'});c.recordEventWindow(i.id,window);
 assert.equal(c.active()?.phase,'CONFIRMING');assert.equal(c.latest()?.evidence.window?.classification,'recovered-motion');
 c.recordEventWindow(i.id,window);assert.equal(c.events(i.id).filter(e=>e.type==='MOTION_WINDOW_CAPTURED').length,1);
 }finally{c.close();}
});
test('sparse chest telemetry is recorded as gaps, never filled or used to establish a fall sequence',()=>{
 const f=captureReady();f.capture.collect(f.wili,f.motion,f.now());
 f.settle(100,i=>({skipBody:i%25!==0}));const window=f.capture.collect(f.wili,f.motion,f.now());assert.ok(window);
 assert.equal(window.quality.continuousBody,false);assert.equal(window.quality.continuousWaist,true,JSON.stringify(window.quality));
 assert.match(window.summary,/Chest reporting is sparse/);assert.notEqual(window.classification,'fall-like-motion');
 assert.ok(window.body.length<window.waist.length);
});
test('missing waist or changed source session is insufficient evidence, never safe',()=>{
 for(const mode of ['missing','changed'] as const){
 const f=captureReady();f.capture.collect(f.wili,f.motion,f.now());
 f.settle(100,()=>mode==='missing'?{skipWaist:true}:{waistSession:'replacement-waist'});
 const window=f.capture.collect(f.wili,f.motion,f.now());assert.ok(window);assert.equal(window.classification,'insufficient-evidence');
 }
});
test('sustained alternating measured motion is shaking, not a seizure diagnosis',()=>{
 const f=captureReady();f.capture.collect(f.wili,f.motion,f.now());
 f.settle(100,i=>({bodyG:[0,0,i%2?1.8:1],angular:i%2?2:-2,linear:.4}));
 const window=f.capture.collect(f.wili,f.motion,f.now());assert.ok(window);
 assert.equal(window.classification,'sustained-shaking');assert.match(window.summary,/does not.*diagnose/);
});

test('patient-reported recovery and fall stay attributed; neither silently closes the incident',()=>{
 for(const [text,interpretation] of [['I slipped but caught myself','reported-recovery'],['I fell and cannot stand','reported-fall']] as const){
 const c=new Controller(':memory:',[{id:'maya',name:'Maya',phone:null}]);
 try{const i=c.trigger({kind:'cross-body',summary:'Measured onset'});
 c.recordCheckinReply({incidentId:i.id,checkinId:i.checkinId,transcript:text,source:'freewili-local-speech'});
 assert.equal(c.latest()?.evidence.patientReport?.interpretation,interpretation);
 assert.equal(c.latest()?.evidence.patientReport?.text,text);assert.ok(c.active());
 }finally{c.close();}
 }
});
