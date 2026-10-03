import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Motion, validSample } from '../src/motion.ts';
import type { DetectionMode } from '../src/motion.ts';
import type { ClockPong, Evidence, MotionSample, Source } from '../src/contracts.ts';

// Offline only. Import no server/provider module and make no network requests.
const SOURCES: Source[] = ['chest-phone', 'waist-airpod'];
const MODES: DetectionMode[] = ['combined', 'chest-only', 'waist-only'];
const SCENARIOS = new Set(['standing', 'phone-drop', 'sit', 'bend', 'staged-fall', 'other']);
const LIMITS = { files: 32, fileBytes: 128 * 1024 * 1024, totalBytes: 256 * 1024 * 1024,
  lineBytes: 64 * 1024, linesPerFile: 250_000, records: 500_000 };
const EVENT_TYPES = new Set(['trial.start', 'trial.stop', 'source.connected', 'source.disconnected',
  'clock.ping', 'clock.pong', 'motion.sample', 'calibration', 'motion.reset', 'assessment']);
type ObjectValue = Record<string, unknown>;
interface Location { file: string; line: number }
interface InputRecord extends Location { value: ObjectValue }
interface TrialEvent extends Location { type: string; atMs: number; at: number; source?: Source; payload?: ObjectValue }
interface SequenceState { session: string; location: string; sequence: number; sensorTime: number; seen: Set<string> }
interface SourceStats {
  source: Source; count: number; sessions: Set<string>; locations: Set<string>;
  first: number | null; last: number | null; arrivalIntervals: number[]; sensorIntervals: number[];
  sequenceGapEvents: number; missingSequenceValues: number;
}

class InputError extends Error {
  constructor(location: Location, message: string) { super(`${location.file}:${location.line}: ${message}`); }
}
function requireValue(condition: unknown, location: Location, message: string): asserts condition {
  if (!condition) throw new InputError(location, message);
}
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[\w-]{1,80}$/.test(value); }
function source(value: unknown): value is Source { return SOURCES.includes(value as Source); }
function sources(value: unknown, location: Location): Source[] {
  requireValue(Array.isArray(value) && value.every(source) && new Set(value).size === value.length, location,
    'sources must be a unique array containing only chest-phone and/or waist-airpod.');
  return value;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}
function finiteTree(value: unknown, location: Location, depth = 0): void {
  requireValue(depth <= 12, location, 'JSON nesting exceeds 12 levels.');
  if (typeof value === 'number') requireValue(Number.isFinite(value), location, 'All numeric fields must be finite.');
  if (Array.isArray(value)) for (const child of value) finiteTree(child, location, depth + 1);
  else if (object(value)) for (const child of Object.values(value)) finiteTree(child, location, depth + 1);
}
function packet(value: unknown, selected: Source, location: Location): MotionSample {
  requireValue(validSample(value, selected), location,
    'Malformed motion packet: check source/bud, safe session ID, increasing counters, quaternion, gravity, acceleration, and units.');
  requireValue(value.sensorTime <= Number.MAX_SAFE_INTEGER / 1000, location, 'sensorTime is too large for safe millisecond arithmetic.');
  return value;
}
function sequence(sample: MotionSample, states: Map<Source, SequenceState>, location: Location): SequenceState | undefined {
  const previous = states.get(sample.source);
  if (previous?.session === sample.sessionId) {
    requireValue(previous.location === sample.sensorLocation, location, 'Reporting bud changed within a session; a new session ID is required.');
    requireValue(sample.sequence > previous.sequence && sample.sensorTime > previous.sensorTime, location,
      'Sample sequence and sensorTime must strictly increase within a session.');
  } else if (previous) {
    requireValue(!previous.seen.has(sample.sessionId), location, 'An older source session reappeared; reject stale callbacks rather than mixing sessions.');
  }
  const seen = previous?.seen ?? new Set<string>(); seen.add(sample.sessionId);
  states.set(sample.source, { session: sample.sessionId, location: sample.sensorLocation,
    sequence: sample.sequence, sensorTime: sample.sensorTime, seen });
  return previous?.session === sample.sessionId ? previous : undefined;
}
function statistics(): Map<Source, SourceStats> {
  return new Map(SOURCES.map(s => [s, { source: s, count: 0, sessions: new Set<string>(), locations: new Set<string>(),
    first: null, last: null, arrivalIntervals: [], sensorIntervals: [], sequenceGapEvents: 0, missingSequenceValues: 0 }]));
}
function countSample(stats: Map<Source, SourceStats>, sample: MotionSample, atMs: number, previous: SequenceState | undefined, location: Location): void {
  const s = stats.get(sample.source)!;
  if (s.last !== null) s.arrivalIntervals.push(atMs - s.last);
  if (previous) {
    s.sensorIntervals.push((sample.sensorTime - previous.sensorTime) * 1000);
    const missing = sample.sequence - previous.sequence - 1;
    if (missing > 0) { s.sequenceGapEvents++; s.missingSequenceValues += missing; }
    requireValue(Number.isSafeInteger(s.missingSequenceValues), location, 'Sequence-gap aggregate exceeds safe integer bounds.');
  }
  s.count++; s.sessions.add(sample.sessionId); s.locations.add(sample.sensorLocation);
  s.first ??= atMs; s.last = atMs;
}
const rounded = (n: number | null): number | null => n === null ? null : Math.round(n * 1000) / 1000;
function intervals(values: number[]) {
  if (!values.length) return { intervals: 0, meanMs: null, maxMs: null, gapsOver500Ms: 0 };
  let sum = 0, max = 0, gaps = 0;
  for (const n of values) { sum += n; max = Math.max(max, n); if (n > 500) gaps++; }
  return { intervals: values.length, meanMs: rounded(sum / values.length), maxMs: rounded(max), gapsOver500Ms: gaps };
}
function summarise(stats: Map<Source, SourceStats>) {
  return SOURCES.map(source => {
    const s = stats.get(source)!;
    const duration = s.first === null || s.last === null ? null : s.last - s.first;
    const sensorDuration = s.sensorIntervals.reduce((sum, n) => sum + n, 0);
    return { source, sampleCount: s.count, sessionIds: [...s.sessions], reportingLocations: [...s.locations],
      firstHostMs: s.first, lastHostMs: s.last, spanMs: rounded(duration),
      receivedCadenceHz: duration && s.count > 1 ? rounded((s.count - 1) * 1000 / duration) : null,
      withinSessionSensorCadenceHz: sensorDuration > 0 ? rounded(s.sensorIntervals.length * 1000 / sensorDuration) : null,
      arrivalGaps: intervals(s.arrivalIntervals), sensorClockGaps: intervals(s.sensorIntervals),
      sequenceGapEvents: s.sequenceGapEvents, missingSequenceValues: s.missingSequenceValues };
  });
}
function evidence(value: unknown, location: Location): Evidence | null {
  if (value === null) return null;
  requireValue(object(value) && ['manual', 'synthetic', 'single-source', 'cross-body'].includes(value.kind as string)
    && text(value.summary, 2000), location, 'assessment.candidate must be null or bounded valid Evidence.');
  if (value.sourceSessions !== undefined) {
    requireValue(object(value.sourceSessions) && Object.entries(value.sourceSessions).every(([s, id]) => source(s) && identifier(id)),
      location, 'Evidence sourceSessions contains an invalid source or unsafe session ID.');
  }
  return value as unknown as Evidence;
}
function event(record: InputRecord): TrialEvent {
  const { value, file, line } = record;
  requireValue(typeof value.type === 'string' && EVENT_TYPES.has(value.type), record, 'Unknown trial event type.');
  requireValue(timestamp(value.atMs) && timestamp(value.at), record, 'Trial events require finite non-negative atMs and at timestamps.');
  requireValue(value.source === undefined || source(value.source), record, 'Invalid event source.');
  requireValue(value.payload === undefined || object(value.payload), record, 'Event payload must be an object.');
  if (['motion.sample', 'clock.ping', 'clock.pong', 'source.connected', 'source.disconnected'].includes(value.type)) {
    requireValue(source(value.source), record, `${value.type} requires an explicit source.`);
  } else {
    requireValue(value.source === undefined, record, `${value.type} is global and cannot be limited to one source.`);
  }
  if (['trial.start', 'trial.stop', 'motion.sample', 'clock.ping', 'clock.pong', 'calibration', 'motion.reset', 'assessment'].includes(value.type)) {
    requireValue(object(value.payload), record, `${value.type} requires a payload.`);
  }
  return { type: value.type, atMs: value.atMs, at: value.at, source: value.source as Source | undefined,
    payload: value.payload as ObjectValue | undefined, file, line };
}
function difference(recorded: Evidence | null, replayed: Evidence | null): string[] {
  if ((recorded === null) !== (replayed === null)) return ['candidate-presence'];
  if (!recorded || !replayed) return [];
  const reasons: string[] = [];
  if (recorded.kind !== replayed.kind) reasons.push('candidate-kind');
  if (SOURCES.some(s => recorded.sourceSessions?.[s] !== replayed.sourceSessions?.[s])) reasons.push('source-sessions');
  return reasons;
}
function modeSources(mode: DetectionMode): Source[] { return mode === 'combined' ? SOURCES : [mode === 'chest-only' ? 'chest-phone' : 'waist-airpod']; }
function replayer(mode: DetectionMode, now: () => number) {
  return { mode, motion: new Motion(now, { mode }), selected: modeSources(mode), samples: 0,
    pings: 0, pongsAccepted: 0, pongsRejected: 0,
    coverage: new Map(modeSources(mode).map(s => [s, { source: s, assessments: 0, fresh: 0, calibratedFresh: 0, alignedFresh: 0 }])),
    calibrations: [] as { atMs: number; recordedSuccessful: Source[]; eligibleSources: Source[]; replayedSuccessful: Source[]; discrepancy: boolean }[],
    candidates: [] as { atMs: number; at: number; kind: Evidence['kind']; evidence: Evidence }[],
    discrepancies: [] as { atMs: number; at: number; recordedKind: string | null; replayedKind: string | null; reasons: string[] }[] };
}
function legacy(records: InputRecord[]) {
  const stats = statistics(); const states = new Map<Source, SequenceState>(); let lastAt = -Infinity;
  for (const record of records) {
    const value = record.value;
    requireValue(source(value.source), record, 'Legacy packet requires a supported source.');
    const sample = packet(value, value.source, record);
    requireValue(timestamp(value.receivedAt) && timestamp(value.hostMonotonicMs), record,
      'Legacy samples require finite receivedAt and hostMonotonicMs; timing is not inferred.');
    requireValue(value.hostMonotonicMs >= lastAt, record, 'Host monotonic times are out of order.');
    lastAt = value.hostMonotonicMs;
    countSample(stats, sample, value.hostMonotonicMs, sequence(sample, states, record), record);
  }
  return { format: 'legacy-samples', status: 'unscored', recordCount: records.length, sourceMetrics: summarise(stats),
    missing: ['trial boundaries', 'recorded clock exchanges', 'calibration', 'assessment times'],
    modes: MODES.map(mode => ({ mode, status: 'unscored', candidates: null,
      reason: 'Legacy samples contain no clock/calibration/assessment history. No alignment or calibration is invented.' })) };
}
function trials(records: InputRecord[]) {
  const results: unknown[] = [];
  let current: { start: TrialEvent; payload: ObjectValue; now: number; connected: Set<Source>;
    stats: Map<Source, SourceStats>; states: Map<Source, SequenceState>; modes: ReturnType<typeof replayer>[];
    pendingPings: Map<Source, Map<string, number>>; seenPingIds: Map<Source, Set<string>>;
    recordedCalibrationSources: Set<Source>;
    assessments: number; eventCount: number; pingTimestampDifferences: number } | null = null;
  let lastAt = -Infinity;
  const ids = new Set<string>();
  for (const record of records) {
    const e = event(record);
    requireValue(e.atMs >= lastAt, e, 'Trial host atMs values are out of order. Do not concatenate recordings from different host clock epochs.');
    lastAt = e.atMs;
    if (e.type === 'trial.start') {
      requireValue(current === null, e, 'A trial is already open; stop it before starting another.');
      const p = e.payload!;
      requireValue(p.version === 1 && identifier(p.id) && text(p.label, 80) && SCENARIOS.has(p.scenario as string)
        && p.capture === 'native-stream', e, 'trial.start requires version 1, safe id, bounded label/scenario, and capture native-stream.');
      requireValue(!ids.has(p.id), e, 'Trial ID repeats within this file.'); ids.add(p.id);
      const initial = sources(p.initialSources, e);
      current = { start: e, payload: p, now: e.atMs, connected: new Set(initial), stats: statistics(),
        states: new Map(), modes: [], assessments: 0, eventCount: 1, pingTimestampDifferences: 0,
        recordedCalibrationSources: new Set(),
        pendingPings: new Map(SOURCES.map(s => [s, new Map<string, number>()])),
        seenPingIds: new Map(SOURCES.map(s => [s, new Set<string>()])) };
      const active = current;
      active.modes = MODES.map(mode => replayer(mode, () => active.now));
      for (const m of active.modes) {
        m.motion.reset({ clocks: true, cooldown: false });
        for (const s of initial) if (m.selected.includes(s)) m.motion.connected(s);
      }
      continue;
    }
    requireValue(current !== null, e, 'Event is outside a trial.start/trial.stop boundary.');
    current.now = e.atMs; current.eventCount++;
    if (e.type === 'trial.stop') {
      requireValue(text(e.payload!.reason, 200), e, 'trial.stop requires a bounded non-empty reason.');
      const sampleCount = [...current.stats.values()].reduce((sum, s) => sum + s.count, 0);
      const missing = [!sampleCount ? 'motion samples' : null,
        !current.recordedCalibrationSources.size ? 'successful calibration' : null,
        !current.assessments ? 'assessment events' : null].filter(x => x !== null);
      results.push({ id: current.payload.id, label: current.payload.label, scenario: current.payload.scenario,
        capture: 'native-stream', initialSources: current.payload.initialSources,
        status: !sampleCount ? 'unscored-no-samples' : !current.recordedCalibrationSources.size
          ? 'unscored-no-calibration' : !current.assessments ? 'unscored-no-assessments' : 'replayed',
        missing, sampleCount, recordedCalibrationSources: [...current.recordedCalibrationSources],
        startAtMs: current.start.atMs, stopAtMs: e.atMs, startAt: current.start.at, stopAt: e.at,
        durationMs: rounded(e.atMs - current.start.atMs), stopReason: e.payload!.reason, eventCount: current.eventCount,
        assessmentCount: current.assessments, pingTimestampDifferences: current.pingTimestampDifferences,
        sourceMetrics: summarise(current.stats), modes: current.modes.map(m => ({
          mode: m.mode, eligibleSources: m.selected, replayedSamples: m.samples,
          status: !m.samples ? 'unscored-no-samples' : !m.calibrations.some(c => c.replayedSuccessful.length)
            ? 'unscored-no-calibration' : !current!.assessments ? 'unscored-no-assessments' : 'replayed',
          clockExchanges: { pings: m.pings, acceptedPongs: m.pongsAccepted, rejectedPongs: m.pongsRejected },
          coverageAtAssessments: [...m.coverage.values()], calibrations: m.calibrations, candidates: m.candidates,
          discrepancies: m.discrepancies, discrepancyCount: m.discrepancies.length,
          comparison: m.mode === 'combined' ? 'Comparison with recorded combined detector output.'
            : 'Ablation differences are expected; discrepancies are not accuracy measurements.'
        })) });
      current = null; continue;
    }
    const p = e.payload;
    if (e.type === 'source.connected' || e.type === 'source.disconnected') {
      if (e.type === 'source.connected') current.connected.add(e.source!); else current.connected.delete(e.source!);
      if (e.type === 'source.disconnected') current.pendingPings.get(e.source!)!.clear();
    } else if (['motion.sample', 'clock.ping', 'clock.pong'].includes(e.type)) {
      requireValue(current.connected.has(e.source!), e, 'Source data arrived without a connected source in this trial.');
    }
    if (e.type === 'motion.sample') {
      const sample = packet(p, e.source!, e);
      countSample(current.stats, sample, e.atMs, sequence(sample, current.states, e), e);
    } else if (e.type === 'clock.ping') {
      requireValue(p!.type === 'clock.ping' && identifier(p!.id) && timestamp(p!.serverSentMs), e, 'Malformed clock ping.');
      requireValue(!current.seenPingIds.get(e.source!)!.has(p!.id), e, 'Clock ping ID was reused within a source trial.');
      current.seenPingIds.get(e.source!)!.add(p!.id);
      current.pendingPings.get(e.source!)!.set(p!.id, e.atMs);
      if (p!.serverSentMs !== e.atMs) current.pingTimestampDifferences++;
    } else if (e.type === 'clock.pong') {
      requireValue(p!.type === 'clock.pong' && identifier(p!.id) && identifier(p!.sessionId)
        && timestamp(p!.deviceReceivedMs) && timestamp(p!.deviceSentMs) && p!.deviceSentMs >= p!.deviceReceivedMs,
      e, 'Malformed clock pong: IDs and ordered finite device timestamps are required.');
      const pending = current.pendingPings.get(e.source!)!;
      requireValue(pending.has(p!.id), e, 'Clock pong has no matching recorded pending ping.');
      const known = current.states.get(e.source!);
      requireValue(!known || known.session === p!.sessionId, e, 'Clock pong names a stale source session.');
      pending.delete(p!.id);
    } else if (e.type === 'calibration') {
      for (const s of sources(p!.sources, e)) current.recordedCalibrationSources.add(s);
    }
    else if (e.type === 'motion.reset') {
      requireValue(typeof p!.clocks === 'boolean' && typeof p!.cooldown === 'boolean', e,
        'motion.reset requires explicit boolean clocks and cooldown fields.');
      if (p!.clocks) for (const pending of current.pendingPings.values()) pending.clear();
    }
    else if (e.type === 'assessment') {
      requireValue(Object.hasOwn(p!, 'candidate'), e, 'assessment must explicitly contain candidate (null or Evidence).');
      evidence(p!.candidate, e); current.assessments++;
    }
    for (const m of current.modes) {
      if (e.source && !m.selected.includes(e.source)) continue;
      if (e.type === 'source.connected') m.motion.connected(e.source!);
      else if (e.type === 'source.disconnected') m.motion.disconnected(e.source!);
      else if (e.type === 'motion.sample') {
        requireValue(m.motion.sample(e.source!, p), e, 'Detector rejected a validated packet; inspect session/order continuity.'); m.samples++;
      } else if (e.type === 'clock.ping') { m.motion.ping(e.source!, p!.id as string); m.pings++; }
      else if (e.type === 'clock.pong') {
        if (m.motion.pong(e.source!, p as unknown as ClockPong)) m.pongsAccepted++; else m.pongsRejected++;
      } else if (e.type === 'calibration') {
        const recorded = sources(p!.sources, e), selected = recorded.filter(s => m.selected.includes(s));
        const calibrated = m.motion.calibrate(selected);
        m.calibrations.push({ atMs: e.atMs, recordedSuccessful: recorded, eligibleSources: selected,
          replayedSuccessful: calibrated, discrepancy: selected.length !== calibrated.length || selected.some(s => !calibrated.includes(s)) });
      } else if (e.type === 'motion.reset') {
        m.motion.reset({ clocks: p!.clocks as boolean, cooldown: p!.cooldown as boolean });
      } else if (e.type === 'assessment') {
        const candidate = m.motion.candidate(); const recorded = evidence(p!.candidate, e);
        if (candidate) m.candidates.push({ atMs: e.atMs, at: e.at, kind: candidate.kind, evidence: candidate });
        const reasons = difference(recorded, candidate);
        if (reasons.length) m.discrepancies.push({ atMs: e.atMs, at: e.at, recordedKind: recorded?.kind ?? null, replayedKind: candidate?.kind ?? null, reasons });
        for (const view of m.motion.views()) {
          const coverage = m.coverage.get(view.source); if (!coverage) continue;
          coverage.assessments++; if (view.fresh) coverage.fresh++; if (view.calibrated) coverage.calibratedFresh++;
          if (view.fresh && view.alignmentUncertaintyMs !== null && view.alignmentUncertaintyMs <= 100) coverage.alignedFresh++;
        }
      }
    }
  }
  requireValue(current === null, records.at(-1)!, 'Trial is unfinished. Stop recording before replaying this file.');
  return { format: 'trial-events-v1', status: 'offline-replay', recordCount: records.length, trials: results };
}

export function analyseRecording(path: string, remainingByteBudget = LIMITS.fileBytes) {
  const file = resolve(path); const location = { file, line: 1 };
  const stat = statSync(file);
  requireValue(stat.isFile(), location, 'Input must be a regular local file.');
  requireValue(stat.size <= LIMITS.fileBytes, location, 'File exceeds 128 MiB. Record shorter self-contained trials.');
  requireValue(stat.size <= remainingByteBudget, location, 'Inputs exceed the combined byte budget.');
  const bytes = readFileSync(file);
  requireValue(bytes.length <= LIMITS.fileBytes && bytes.length <= remainingByteBudget, location,
    'File grew beyond the byte budget while being read; stop recording first.');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new InputError(location, 'Input is not valid UTF-8 JSONL.'); }
  const lines = content.split('\n');
  requireValue(lines.length <= LIMITS.linesPerFile + 1, location, 'File exceeds 250,000 JSONL lines.');
  const records: InputRecord[] = [];
  for (const [index, line] of lines.entries()) {
    const at = { file, line: index + 1 };
    requireValue(Buffer.byteLength(line, 'utf8') <= LIMITS.lineBytes, at, 'JSONL line exceeds 64 KiB.');
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new InputError(at, 'Invalid JSON. Finish writing the file and check this line.'); }
    requireValue(object(value), at, 'Each JSONL line must contain an object.'); finiteTree(value, at);
    records.push({ ...at, value });
  }
  requireValue(records.length > 0, location, 'Input has no records.');
  const legacyFormat = records[0].value.type === 'motion.sample' && Object.hasOwn(records[0].value, 'hostMonotonicMs');
  for (const record of records) {
    const isLegacy = record.value.type === 'motion.sample' && Object.hasOwn(record.value, 'hostMonotonicMs');
    requireValue(isLegacy === legacyFormat, record, 'Legacy samples and ordered trial events cannot be mixed in one file.');
  }
  const result = legacyFormat ? legacy(records) : trials(records);
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...result };
}

function main(): void {
  const args = process.argv.slice(2); const files: string[] = []; let output: string | null = null;
  const usage = 'Usage: npm run replay:motion -- [--output report.json] <local.jsonl> [more.jsonl ...]';
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${usage}\nOffline metadata/detector debug output only; no live events or provider calls.\n`); return; }
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--output') {
        if (output !== null || !args[index + 1] || args[index + 1].startsWith('-')) throw new Error('--output requires one local destination path.');
        output = resolve(args[++index]);
      } else if (arg.startsWith('-')) throw new Error(`Unsupported argument ${arg}.`);
      else files.push(resolve(arg));
    }
    if (!files.length || files.length > LIMITS.files) throw new Error('Provide 1–32 local JSONL files.');
    if (new Set(files).size !== files.length) throw new Error('The same input file was supplied twice.');
    if (output && files.includes(output)) throw new Error('Output cannot overwrite an input recording.');
    if (output) {
      let destination: ReturnType<typeof statSync> | null = null;
      try { destination = statSync(output); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (destination && files.some(file => {
        const input = statSync(file); return input.dev === destination.dev && input.ino === destination.ino;
      })) throw new Error('Output cannot overwrite an input recording through an alias or symbolic link.');
    }
    let total = 0;
    for (const file of files) { total += statSync(file).size; if (total > LIMITS.totalBytes) throw new Error('Inputs exceed the combined 256 MiB bound.'); }
    const reports: ReturnType<typeof analyseRecording>[] = [];
    let actualBytes = 0, actualRecords = 0;
    for (const file of files) {
      const result = analyseRecording(file, LIMITS.totalBytes - actualBytes);
      actualBytes += result.bytes; actualRecords += result.recordCount;
      if (actualRecords > LIMITS.records) throw new Error('Inputs exceed the combined 500,000-record bound.');
      reports.push(result);
    }
    const report = { version: 1, kind: 'offline-motion-replay', live: false,
      interpretation: 'Algorithm/debug output. Native-stream capture and operator labels do not verify a bodily event. No accuracy percentages are produced.',
      detectorSha256: createHash('sha256').update(readFileSync(new URL('../src/motion.ts', import.meta.url))).digest('hex'), files: reports };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (output) {
      const temporary = resolve(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
      try { writeFileSync(temporary, json, { flag: 'wx', mode: 0o600 }); renameSync(temporary, output); }
      catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    }
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`Replay failed: ${error instanceof Error ? error.message : 'Invalid input.'}\n${usage}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
