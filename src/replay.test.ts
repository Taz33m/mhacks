import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyseRecording } from '../scripts/replay-motion.ts';
import { Motion } from './motion.ts';
import type { ClockPong, Evidence, MotionSample, Source, TrialRecord } from './contracts.ts';

const SOURCES: Source[] = ['chest-phone', 'waist-airpod'];
const WALL = 1_790_000_000_000;
const directory = mkdtempSync(join(tmpdir(), 'lifeline-offline-replay-'));
test.after(() => rmSync(directory, { recursive: true, force: true }));
let fileNumber = 0;
function file(content: string | Buffer): string {
  const path = join(directory, `recording-${++fileNumber}.jsonl`); writeFileSync(path, content); return path;
}
function jsonl(records: unknown[]): string { return records.map(r => JSON.stringify(r)).join('\n') + '\n'; }
function sample(source: Source, sequence: number, host: number): MotionSample {
  return { type: 'motion.sample', source, sensorLocation: source === 'chest-phone' ? 'phone' : 'Right',
    sessionId: source === 'chest-phone' ? 'chest-session' : 'waist-session', sequence,
    sensorTime: (host + 10_000) / 1000, quaternion: [0, 0, 0, 1], rotationRate: [0, 0, 0],
    gravity: [0, -1, 0], userAcceleration: [0, 0, 0] };
}
function event(type: TrialRecord['type'], atMs: number, payload?: unknown, source?: Source): TrialRecord {
  return { type, atMs, at: WALL + atMs, ...(source ? { source } : {}), ...(payload !== undefined ? { payload } : {}) };
}
function start(atMs = 0, initialSources: Source[] = SOURCES): TrialRecord {
  return event('trial.start', atMs, { version: 1, id: 'test-trial', label: 'Protocol fixture', scenario: 'other',
    initialSources, capture: 'native-stream' });
}
interface ModeSummary {
  mode: string; status: string; replayedSamples: number;
  candidates: { atMs: number; kind: Evidence['kind'] }[];
  discrepancyCount: number;
  clockExchanges: { pings: number; acceptedPongs: number; rejectedPongs: number };
  calibrations: { replayedSuccessful: Source[]; discrepancy: boolean }[];
  coverageAtAssessments: { source: Source; fresh: number; calibratedFresh: number; alignedFresh: number }[];
}
interface TrialSummary {
  status: string; sampleCount: number; missing: string[]; modes: ModeSummary[];
  sourceMetrics: { source: Source; sampleCount: number; receivedCadenceHz: number | null; missingSequenceValues: number }[];
}
function trial(path: string): TrialSummary {
  const result = analyseRecording(path); assert.equal(result.format, 'trial-events-v1');
  assert.ok('trials' in result); return result.trials[0] as TrialSummary;
}

// Deterministic protocol data exercises clock reconstruction and reset; it is not bodily-event evidence.
function calibratedFixture(): TrialRecord[] {
  let now = 0; const motion = new Motion(() => now); const records: TrialRecord[] = [start()];
  const counters = new Map(SOURCES.map(s => [s, 0]));
  motion.reset({ clocks: true, cooldown: false });
  for (const source of SOURCES) {
    motion.connected(source);
    const p = sample(source, counters.get(source)!, now); counters.set(source, p.sequence + 1);
    assert.equal(motion.sample(source, p), true); records.push(event('motion.sample', now, p, source));
    records.push(event('clock.ping', now, motion.ping(source, `ping-${source}`), source));
  }
  now = 20;
  for (const source of SOURCES) {
    const p: ClockPong = { type: 'clock.pong', id: `ping-${source}`, sessionId: sample(source, 0, 0).sessionId,
      deviceReceivedMs: 10_010, deviceSentMs: 10_010 };
    assert.equal(motion.pong(source, p), true); records.push(event('clock.pong', now, p, source));
  }
  const samples = (host: number, tilted = false, impact = false) => {
    now = host;
    for (const source of SOURCES) {
      const p = sample(source, counters.get(source)!, now); counters.set(source, p.sequence + 1);
      if (tilted) p.gravity = [0, 0, -1];
      if (impact) p.userAcceleration = [0, 0, -1.8];
      assert.equal(motion.sample(source, p), true); records.push(event('motion.sample', now, p, source));
    }
  };
  for (let t = 40; t <= 1240; t += 40) samples(t);
  assert.deepEqual(motion.calibrate(), SOURCES); records.push(event('calibration', now, { sources: SOURCES }));
  samples(1280, true, true);
  for (let t = 1320; t <= 4200; t += 40) samples(t, true);
  const candidate = motion.candidate(); assert.equal(candidate?.kind, 'cross-body');
  records.push(event('assessment', now, { candidate }));
  now = 4240; motion.reset(); records.push(event('motion.reset', now, { clocks: false, cooldown: true }));
  now = 4280; records.push(event('assessment', now, { candidate: motion.candidate() }));
  records.push(event('trial.stop', 4320, { reason: 'Fixture complete.' }));
  return records;
}

test('reconstructs recorded clocks/calibration independently in all modes and preserves operator reset', () => {
  const report = trial(file(jsonl(calibratedFixture())));
  assert.equal(report.status, 'replayed'); assert.equal(report.sampleCount, 212); assert.deepEqual(report.missing, []);
  const [combined, chest, waist] = report.modes;
  assert.deepEqual(combined.candidates.map(c => [c.atMs, c.kind]), [[4200, 'cross-body']]);
  assert.equal(combined.discrepancyCount, 0); assert.equal(combined.replayedSamples, 212);
  assert.deepEqual(combined.clockExchanges, { pings: 2, acceptedPongs: 2, rejectedPongs: 0 });
  assert.deepEqual(combined.calibrations, [{ atMs: 1240, recordedSuccessful: SOURCES, eligibleSources: SOURCES,
    replayedSuccessful: SOURCES, discrepancy: false }]);
  for (const mode of [chest, waist]) {
    assert.deepEqual(mode.candidates.map(c => [c.atMs, c.kind]), [[4200, 'single-source']]);
    assert.equal(mode.replayedSamples, 106); assert.equal(mode.discrepancyCount, 1);
    assert.deepEqual(mode.clockExchanges, { pings: 1, acceptedPongs: 1, rejectedPongs: 0 });
    assert.equal(mode.calibrations[0].replayedSuccessful.length, 1);
  }
  for (const coverage of combined.coverageAtAssessments) {
    assert.equal(coverage.fresh, 2); assert.equal(coverage.calibratedFresh, 1); assert.equal(coverage.alignedFresh, 2);
  }
});

test('zero-sample connection capture and samples lacking calibration remain explicitly unscored', () => {
  const report = trial(file(jsonl([start(0, []), event('source.connected', 10, undefined, 'waist-airpod'),
    event('assessment', 20, { candidate: null }), event('trial.stop', 30, { reason: 'No samples.' })])));
  assert.equal(report.status, 'unscored-no-samples'); assert.equal(report.sampleCount, 0);
  assert.deepEqual(report.missing, ['motion samples', 'successful calibration']);
  assert.ok(report.modes.every(m => m.status === 'unscored-no-samples' && !m.candidates.length));
  assert.ok(report.sourceMetrics.every(s => s.sampleCount === 0 && s.receivedCadenceHz === null));
  const noCalibration = trial(file(jsonl([start(), event('motion.sample', 0, sample('chest-phone', 0, 0), 'chest-phone'),
    event('assessment', 20, { candidate: null }), event('trial.stop', 30, { reason: 'No calibration.' })])));
  assert.equal(noCalibration.status, 'unscored-no-calibration'); assert.deepEqual(noCalibration.missing, ['successful calibration']);
});

test('pre-sample clock pong is unusable without bootstrapping a session, then fresh exchange succeeds', () => {
  const ping = (id: string, at: number) => ({ type: 'clock.ping', id, serverSentMs: at });
  const pong = (id: string, device: number) => ({ type: 'clock.pong', id, sessionId: 'waist-session',
    deviceReceivedMs: device, deviceSentMs: device });
  const records = [start(0, ['waist-airpod']), event('clock.ping', 0, ping('before-sample', 0), 'waist-airpod'),
    event('clock.pong', 20, pong('before-sample', 10_010), 'waist-airpod'),
    event('motion.sample', 40, sample('waist-airpod', 0, 40), 'waist-airpod'),
    event('clock.ping', 40, ping('after-sample', 40), 'waist-airpod'),
    event('clock.pong', 60, pong('after-sample', 10_050), 'waist-airpod'),
    event('assessment', 80, { candidate: null }), event('trial.stop', 100, { reason: 'Clock fixture complete.' })];
  const report = trial(file(jsonl(records)));
  assert.deepEqual(report.modes[0].clockExchanges, { pings: 2, acceptedPongs: 1, rejectedPongs: 1 });
  assert.equal(report.modes[0].coverageAtAssessments.find(s => s.source === 'waist-airpod')?.alignedFresh, 1);
  assert.equal(report.modes[1].clockExchanges.pings, 0);
});

test('legacy sample metadata reports real timing gaps and never invents scores, clocks or calibration', () => {
  const records = [0, 40, 800].map((atMs, index) => ({ ...sample('waist-airpod', [0, 1, 3][index], atMs),
    hostMonotonicMs: atMs, receivedAt: WALL + atMs }));
  const report = analyseRecording(file(jsonl(records))); assert.equal(report.format, 'legacy-samples');
  assert.equal(report.status, 'unscored'); assert.ok('sourceMetrics' in report);
  const waist = report.sourceMetrics[1]; assert.equal(waist.sampleCount, 3); assert.equal(waist.receivedCadenceHz, 2.5);
  assert.equal(waist.arrivalGaps.gapsOver500Ms, 1); assert.equal(waist.missingSequenceValues, 1);
  assert.ok(report.modes.every(m => m.status === 'unscored' && m.candidates === null));
});

test('malformed, stale or out-of-order packets fail with exact file and line context', () => {
  const failures: { records: TrialRecord[]; message: RegExp }[] = [
    { records: [start(), event('motion.sample', 0, { ...sample('waist-airpod', 0, 0), sessionId: '../unsafe' }, 'waist-airpod')], message: /Malformed motion packet/ },
    { records: [start(), event('motion.sample', 0, { ...sample('waist-airpod', 0, 0), gravity: [0, 0, 0] }, 'waist-airpod')], message: /Malformed motion packet/ },
    { records: [start(), event('motion.sample', 0, sample('waist-airpod', 0, 0), 'waist-airpod'), event('motion.sample', 40, sample('waist-airpod', 0, 40), 'waist-airpod')], message: /strictly increase/ },
    { records: [start(), event('motion.sample', 20, sample('waist-airpod', 0, 20), 'waist-airpod'), event('assessment', 10, { candidate: null })], message: /out of order/ },
    { records: [start(), event('motion.sample', 0, sample('waist-airpod', 0, 0), 'waist-airpod'), event('motion.sample', 40, { ...sample('waist-airpod', 1, 40), sensorLocation: 'Left' }, 'waist-airpod')], message: /bud changed/ },
    { records: [start(), event('clock.pong', 20, { type: 'clock.pong', id: 'missing', sessionId: 'waist-session', deviceReceivedMs: 10, deviceSentMs: 10 }, 'waist-airpod')], message: /no matching recorded pending ping/ },
    { records: [start(), event('assessment', 20, { candidate: null }, 'waist-airpod')], message: /global/ },
    { records: [start(), event('motion.sample', 0, sample('waist-airpod', 0, 0), 'waist-airpod')], message: /unfinished/ }
  ];
  for (const failure of failures) {
    const path = file(jsonl(failure.records));
    assert.throws(() => analyseRecording(path), error => {
      assert.ok(error instanceof Error); assert.ok(error.message.startsWith(`${path}:`));
      assert.match(error.message, /\.jsonl:\d+:/); assert.match(error.message, failure.message); return true;
    });
  }
});

test('bounds JSON lines, rejects non-finite numeric overflow and invalid UTF-8', () => {
  assert.throws(() => analyseRecording(file(' '.repeat(64 * 1024 + 1))), /line exceeds 64 KiB/);
  assert.throws(() => analyseRecording(file('{"type":"trial.start","atMs":1e309}\n')), /must be finite/);
  assert.throws(() => analyseRecording(file(Buffer.from([0xc3, 0x28]))), /not valid UTF-8/);
  assert.throws(() => analyseRecording(file('{"type":\n')), /Invalid JSON/);
});

test('CLI is offline, combines local files, writes reviewable JSON and cannot overwrite an input', () => {
  const first = file(jsonl([start(), event('trial.stop', 40, { reason: 'Empty fixture.' })]));
  const second = file(jsonl([{ ...sample('waist-airpod', 0, 0), hostMonotonicMs: 0, receivedAt: WALL }]));
  const output = join(directory, 'report.json');
  const cli = new URL('../scripts/replay-motion.ts', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, '--output', output, first, second], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout); assert.equal(report.live, false); assert.equal(report.kind, 'offline-motion-replay');
  assert.equal(report.files.length, 2); assert.match(report.detectorSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report);
  const before = readFileSync(first, 'utf8');
  const overwrite = spawnSync(process.execPath, [cli, '--output', first, first], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /cannot overwrite an input/);
  assert.equal(readFileSync(first, 'utf8'), before);
  const malformed = file(jsonl([start(), event('assessment', 20, { candidate: null }, 'chest-phone')]));
  const failed = spawnSync(process.execPath, [cli, malformed], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(failed.status, 1); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /\.jsonl:2: assessment is global/);
});
