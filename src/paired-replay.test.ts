import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseRecording } from '../scripts/replay-motion.ts';
import { FreeWili } from './freewili.ts';
import type { BodyWiliSample } from './freewili.ts';
import { Motion } from './motion.ts';
import { WiliAssessment } from './wili-assessment.ts';
import type { Evidence, MotionSample, TrialRecord } from './contracts.ts';

// Generated protocol/clock fixtures verify software reconstruction, never measured bodily events.
const directory = mkdtempSync(join(tmpdir(), 'lifeline-paired-replay-'));
test.after(() => rmSync(directory, { recursive: true, force: true })); let number = 0;
function file(records: unknown[]) {
  const path = join(directory, `${++number}.jsonl`); writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n'); return path;
}
type Report = { status: string; sampleCount: number; missing: string[]; candidates: { atMs: number; evidence: Evidence }[];
  discrepancies: { atMs: number; reasons: string[] }[]; discrepancyCount: number; pairedAlignedAssessments: number;
  skippedActiveIncidentAssessments: number; markers: { label: string }[]; preservedCalibration: unknown[];
  sourceMetrics: { source: string; sampleCount: number; captureClocks: string[]; rawSaturatedSamples: number;
    conservativelySaturatedSamples: number; clockInterpretation: string; frameTimestamp: { first: string; unitAssumed: false }; arrivalGaps: { maxMs: number } }[];
  clockExchanges: { source: string; pings: number; acceptedPongs: number; unusablePreSamplePongs: number; rejectedPongs: number }[] };
function report(records: TrialRecord[]): Report {
  const result = analyseRecording(file(records)); assert.equal(result.format, 'trial-events-v2');
  assert.ok('trials' in result); return result.trials[0] as Report;
}
function fixture(options: { peak?: number; bodySync?: boolean; preserved?: boolean; assessmentDelayMs?: number } = {}) {
  let now = 1000, bodySequence = 0, waistSequence = 0;
  const records: TrialRecord[] = [];
  const event = (type: TrialRecord['type'], payload?: unknown, source?: TrialRecord['source'], atMs = now) => {
    records.push({ type, atMs, at: 1790000000000 + now, ...(payload === undefined ? {} : { payload }), ...(source ? { source } : {}) });
  };
  const body = new FreeWili(() => now), waist = new Motion(() => now), detector = new WiliAssessment(() => now);
  body.connected(); waist.connected('waist-airpod');
  event('trial.start', { version: 2, id: 'generated-paired-trial', label: 'Generated protocol fixture', scenario: 'other',
    capture: 'native-stream', captureMode: 'wili-waist', stateBoundary: 'fresh-history-and-clocks',
    initialSources: ['body-wili', 'waist-airpod'], initialSessions: { 'body-wili': 'generated-board', 'waist-airpod': 'generated-waist' },
    preservedCalibration: options.preserved ? [{ source: 'waist-airpod', sessionId: 'generated-waist', sensorLocation: 'Right' }] : [] });
  event('device.hello', { type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId: 'generated-board',
    deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
    capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }, 'body-wili');
  function frame(g = 1, linear = 0, advance = 40) {
    now += advance;
    const b: BodyWiliSample = { type: 'accel.sample', source: 'body-wili', sessionId: 'generated-board', sequence: bodySequence++,
      sensorTime: (now + 100000) / 1000, captureClock: 'host-receipt', frameTimestamp: String(1015894500660534528n + BigInt(bodySequence)),
      accelerationG: [0, 0, g], fullScaleG: 2, fresh: true, saturated: false, quality: 'measured' };
    const w: MotionSample = { type: 'motion.sample', source: 'waist-airpod', sessionId: 'generated-waist', sequence: waistSequence++,
      sensorLocation: 'Right', sensorTime: (now + 300000) / 1000, gravity: [0, 0, -1], quaternion: [0, 0, 0, 1],
      userAcceleration: [linear, 0, 0], rotationRate: [0, 0, 0] };
    assert.equal(body.sample(b), true); assert.equal(waist.sample('waist-airpod', w), true);
    event('accel.sample', b, 'body-wili'); event('motion.sample', w, 'waist-airpod');
  }
  frame(1, 0, 0);
  for (const [s, offset, sessionId] of [['body-wili', 100000, 'generated-board'], ['waist-airpod', 300000, 'generated-waist']] as const) {
    if (s === 'body-wili' && options.bodySync === false) continue;
    const ping = s === 'body-wili' ? body.ping(`generated-${s}-clock`) : waist.ping(s, `generated-${s}-clock`);
    event('clock.ping', ping, s);
    const pong = { type: 'clock.pong' as const, id: ping.id, sessionId, deviceReceivedMs: now + offset, deviceSentMs: now + offset };
    assert.equal(s === 'body-wili' ? body.pong(pong) : waist.pong(s, pong), true); event('clock.pong', pong, s);
  }
  for (let n = 0; n < 10; n++) frame();
  event('trial.marker', { label: 'Generated impact window' }); frame(options.peak ?? 1.8, .6);
  for (let n = 0; n < 82; n++) frame();
  const assessedAt = now;
  now += options.assessmentDelayMs ?? 0;
  event('assessment', { candidate: detector.candidate(body, waist, assessedAt), evaluated: true,
    detector: 'wili-waist-provisional-v1' }, undefined, assessedAt);
  now += 40; event('assessment', { candidate: null, evaluated: false, detector: 'wili-waist-provisional-v1' });
  event('trial.stop', { reason: 'Generated fixture complete.' }); return records;
}

test('paired stock protocol replay reconstructs both clocks and exact source-labelled candidate features', () => {
  const records = fixture({ preserved: true }), result = report(records);
  assert.equal(result.status, 'replayed'); assert.equal(result.sampleCount, 188);
  assert.equal(result.candidates.length, 1); assert.equal(result.discrepancyCount, 0);
  assert.equal(result.candidates[0].evidence.assessment?.impact.totalG, 1.8);
  assert.equal(result.candidates[0].evidence.assessment?.impact.captureClock, 'host-receipt');
  assert.equal(result.candidates[0].evidence.assessment?.impact.fullScaleG, 2);
  assert.deepEqual(result.candidates[0].evidence.sourceSessions, { 'body-wili': 'generated-board', 'waist-airpod': 'generated-waist' });
  assert.equal(result.pairedAlignedAssessments, 1); assert.equal(result.skippedActiveIncidentAssessments, 1);
  assert.equal(result.preservedCalibration.length, 1, 'pre-trial baseline is annotated, not invented in replay');
  assert.equal(result.markers[0].label, 'Generated impact window');
  assert.deepEqual(result.clockExchanges.map(c => c.acceptedPongs), [1, 1]);
  const board = result.sourceMetrics[0]; assert.deepEqual(board.captureClocks, ['host-receipt']);
  assert.match(board.clockInterpretation, /not board acquisition/); assert.equal(board.frameTimestamp.unitAssumed, false);
  assert.match(board.frameTimestamp.first, /^10158945006605345/);
});

test('assessment freshness and frozen features use the recorded time despite later view clock reads', () => {
  const records = fixture({ assessmentDelayMs: 500 }), result = report(records);
  const recorded = (records.find(r => r.type === 'assessment')!.payload as { candidate: Evidence }).candidate;
  assert.ok(recorded, 'the streams were fresh at the actual assessment time');
  assert.equal(result.candidates.length, 1); assert.equal(result.discrepancyCount, 0);
  assert.deepEqual(result.candidates[0].evidence, recorded);
});

test('clipped board peaks replay as at-least-full-scale candidates; missing paired clocks stay visible without a solo fallback', () => {
  const saturated = report(fixture({ peak: 1.99 }));
  assert.equal(saturated.candidates.length, 1); assert.equal(saturated.discrepancyCount, 0);
  assert.equal(saturated.candidates[0].evidence.assessment?.impact.saturated, true);
  assert.equal(saturated.candidates[0].evidence.assessment?.impact.totalG, 1.99);
  assert.match(saturated.candidates[0].evidence.summary, /^Possible fall: ≥2\.00 g impact \(sensor limit\) with waist movement/);
  assert.equal(saturated.sourceMetrics[0].rawSaturatedSamples, 0);
  assert.equal(saturated.sourceMetrics[0].conservativelySaturatedSamples, 1);
  const noClock = report(fixture({ bodySync: false })); assert.equal(noClock.status, 'unscored-no-paired-alignment');
  assert.equal(noClock.candidates.length, 0); assert.equal(noClock.clockExchanges[0].acceptedPongs, 0);
  const onlyBody = fixture().filter(r => r.source !== 'waist-airpod');
  const p = onlyBody[0].payload as Record<string, unknown>; p.initialSources = ['body-wili']; p.initialSessions = { 'body-wili': 'generated-board' };
  for (const r of onlyBody) if (r.type === 'assessment') (r.payload as Record<string, unknown>).candidate = null;
  const absent = report(onlyBody); assert.equal(absent.status, 'unscored-missing-paired-samples'); assert.equal(absent.candidates.length, 0);
});

test('paired replay reports real recorded gaps and discrepancies when required waist quiet evidence is missing', () => {
  const records = fixture().filter(r => !(r.source === 'waist-airpod' && r.type === 'motion.sample' && r.atMs > 3000 && r.atMs < 3500));
  const result = report(records); assert.equal(result.candidates.length, 0);
  assert.ok(result.sourceMetrics[1].arrivalGaps.maxMs > 200);
  assert.deepEqual(result.discrepancies[0].reasons, ['candidate-presence']);
});

test('retained-session pongs before the first captured sample are explicit unusable bootstrap alignment', () => {
  const records = fixture(), ping = { type: 'clock.ping', id: 'pre-sample-ping', serverSentMs: 1000 };
  records.splice(2, 0, { type: 'clock.ping', atMs: 1000, at: 1790000001000, source: 'body-wili', payload: ping },
    { type: 'clock.pong', atMs: 1000, at: 1790000001000, source: 'body-wili', payload: { type: 'clock.pong',
      id: ping.id, sessionId: 'generated-board', deviceReceivedMs: 101000, deviceSentMs: 101000 } });
  const result = report(records); assert.equal(result.clockExchanges[0].unusablePreSamplePongs, 1);
  assert.equal(result.discrepancyCount, 0); assert.equal(result.candidates.length, 1);
});

test('paired validation rejects missing hello, unsafe sessions, duplicate counters, stale pongs and unfinished/order errors', () => {
  const mutations: { change: (r: TrialRecord[]) => void; error: RegExp }[] = [
    { change: r => { r.splice(1, 1); }, error: /hello/ },
    { change: r => { const s = r.find(r => r.type === 'accel.sample')!; (s.payload as Record<string, unknown>).sessionId = '../unsafe'; }, error: /Malformed raw/ },
    { change: r => { const s = r.findIndex(r => r.type === 'accel.sample'); r.splice(s + 1, 0, structuredClone(r[s])); }, error: /repeated|out of order/ },
    { change: r => { const p = r.find(r => r.type === 'clock.pong')!; (p.payload as Record<string, unknown>).id = 'unknown'; }, error: /matching recorded ping/ },
    { change: r => { r[0].source = 'chest-phone'; }, error: /invalid or missing source/ },
    { change: r => { r[4].atMs = 999; }, error: /out of order/ },
    { change: r => { r.pop(); }, error: /unfinished/ },
  ];
  for (const { change, error } of mutations) {
    const records = fixture(); change(records);
    assert.throws(() => analyseRecording(file(records)), error);
  }
});

test('existing raw board sample files keep receipt-domain cadence and saturation metadata but remain unscored', () => {
  const records = fixture().filter(r => r.type === 'accel.sample').slice(0, 3)
    .map(r => ({ ...(r.payload as BodyWiliSample), receivedAt: r.at, hostMonotonicMs: r.atMs }));
  const result = analyseRecording(file(records)); assert.equal(result.format, 'raw-wili-samples');
  assert.equal(result.status, 'unscored'); assert.ok('candidates' in result); assert.equal(result.candidates, null);
  assert.ok('sourceMetrics' in result); assert.equal(result.sourceMetrics[0].sampleCount, 3);
  assert.ok('missing' in result); assert.ok(result.missing.includes('paired waist stream'));
});
