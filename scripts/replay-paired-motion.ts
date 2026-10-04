import { FreeWili, validBodyWiliSample, validWiliPong } from '../src/freewili.ts';
import type { BodyWiliSample } from '../src/freewili.ts';
import { Motion, validSample } from '../src/motion.ts';
import { DEFAULT_WILI_THRESHOLDS, WiliAssessment } from '../src/wili-assessment.ts';
import { WiliDeviceProtocol, validWiliHello } from '../native/freewili/protocol.ts';
import type { ClockPong, Evidence, MotionSample } from '../src/contracts.ts';

// Imported only by the offline CLI. No controller, server, providers or network clients.
type Obj = Record<string, unknown>;
type Source = 'body-wili' | 'waist-airpod';
export interface PairedInput { value: Obj; file: string; line: number }
const SOURCES: Source[] = ['body-wili', 'waist-airpod'];
const TYPES = new Set(['trial.start', 'trial.stop', 'trial.marker', 'source.connected', 'source.disconnected',
  'device.hello', 'clock.ping', 'clock.pong', 'accel.sample', 'motion.sample', 'calibration', 'motion.reset', 'assessment']);
const SCENARIOS = new Set(['standing', 'phone-drop', 'sit', 'bend', 'staged-fall', 'other']);
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER / 1000;
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,80}$/.test(v);
const text = (v: unknown, max = 80): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const source = (v: unknown): v is Source => SOURCES.includes(v as Source);
function check(condition: unknown, r: PairedInput, message: string): asserts condition {
  if (!condition) throw new Error(`${r.file}:${r.line}: ${message}`);
}
function sources(v: unknown, r: PairedInput): Source[] {
  check(Array.isArray(v) && v.every(source) && new Set(v).size === v.length, r,
    'Paired sources must be unique body-wili/waist-airpod values.'); return v;
}
const round = (v: number | null) => v === null ? null : Math.round(v * 1000) / 1000;
function gaps(values: number[]) {
  return { intervals: values.length, meanMs: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
    maxMs: values.length ? round(values.reduce((a, b) => Math.max(a, b), 0)) : null,
    gapsOver200Ms: values.filter(v => v > 200).length, gapsOver500Ms: values.filter(v => v > 500).length };
}
function metrics(s: Source) {
  return { source: s, sampleCount: 0, sessionIds: new Set<string>(), reportingLocations: new Set<string>(),
    captureClocks: new Set<string>(), fullScaleG: new Set<number>(), firstHostMs: null as number | null,
    lastHostMs: null as number | null, arrival: [] as number[], sensor: [] as number[],
    last: null as { session: string; sequence: number; sensorTime: number; location: string } | null,
    seen: new Set<string>(), sequenceGapEvents: 0, missingSequenceValues: 0,
    rawSaturatedSamples: 0, conservativelySaturatedSamples: 0, alignedSamples: 0, captureFreshSamples: 0,
    firstFrameTimestamp: null as string | null, lastFrameTimestamp: null as string | null,
    maxTotalG: null as number | null };
}
type Metrics = ReturnType<typeof metrics>;
function count(m: Metrics, p: BodyWiliSample | MotionSample, at: number, r: PairedInput) {
  const location = p.type === 'accel.sample' ? 'body' : p.sensorLocation;
  if (m.last?.session === p.sessionId) {
    check(m.last.location === location, r, 'Reporting bud changed within a session.');
    check(p.sequence > m.last.sequence && p.sensorTime > m.last.sensorTime, r, 'Sequence and sensorTime must strictly increase.');
    m.sensor.push((p.sensorTime - m.last.sensorTime) * 1000);
    const missing = p.sequence - m.last.sequence - 1;
    if (missing) { m.sequenceGapEvents++; m.missingSequenceValues += missing; }
    check(Number.isSafeInteger(m.missingSequenceValues), r, 'Sequence-gap total exceeds safe bounds.');
  } else check(!m.seen.has(p.sessionId), r, 'A retired source session reappeared.');
  if (m.lastHostMs !== null) m.arrival.push(at - m.lastHostMs);
  m.last = { session: p.sessionId, sequence: p.sequence, sensorTime: p.sensorTime, location };
  m.seen.add(p.sessionId); m.sessionIds.add(p.sessionId); m.reportingLocations.add(location);
  m.firstHostMs ??= at; m.lastHostMs = at; m.sampleCount++;
  if (p.type === 'accel.sample') {
    m.captureClocks.add(p.captureClock); m.fullScaleG.add(p.fullScaleG);
    if (p.saturated) m.rawSaturatedSamples++;
    if (p.saturated || p.accelerationG.some(v => Math.abs(v) >= p.fullScaleG * .98)) m.conservativelySaturatedSamples++;
    const total = Math.hypot(...p.accelerationG); m.maxTotalG = Math.max(total, m.maxTotalG ?? total);
    if (p.frameTimestamp !== undefined) { m.firstFrameTimestamp ??= p.frameTimestamp; m.lastFrameTimestamp = p.frameTimestamp; }
  } else m.captureClocks.add('device-monotonic');
}
function summary(m: Metrics) {
  const span = m.firstHostMs === null || m.lastHostMs === null ? null : m.lastHostMs - m.firstHostMs;
  const sensorDuration = m.sensor.reduce((a, b) => a + b, 0);
  return { source: m.source, sampleCount: m.sampleCount, sessionIds: [...m.sessionIds], reportingLocations: [...m.reportingLocations],
    captureClocks: [...m.captureClocks], fullScaleG: [...m.fullScaleG], firstHostMs: m.firstHostMs, lastHostMs: m.lastHostMs,
    spanMs: round(span), receivedCadenceHz: span && m.sampleCount > 1 ? round((m.sampleCount - 1) * 1000 / span) : null,
    withinSessionDeclaredClockCadenceHz: sensorDuration > 0 ? round(m.sensor.length * 1000 / sensorDuration) : null,
    clockInterpretation: m.source === 'body-wili' && m.captureClocks.has('host-receipt')
      ? 'sensorTime is gateway receipt, not board acquisition; frameTimestamp unit is not assumed.'
      : 'sensorTime is the declared device-monotonic acquisition clock.',
    arrivalGaps: gaps(m.arrival), declaredClockGaps: gaps(m.sensor), sequenceGapEvents: m.sequenceGapEvents,
    missingSequenceValues: m.missingSequenceValues, rawSaturatedSamples: m.rawSaturatedSamples,
    conservativelySaturatedSamples: m.conservativelySaturatedSamples, maxTotalG: round(m.maxTotalG),
    alignedSamples: m.alignedSamples, captureFreshSamples: m.captureFreshSamples,
    frameTimestamp: { first: m.firstFrameTimestamp, last: m.lastFrameTimestamp, unitAssumed: false } };
}
function evidence(value: unknown, r: PairedInput): Evidence | null {
  if (value === null) return null;
  check(obj(value) && value.kind === 'cross-body' && text(value.summary, 4000)
    && obj(value.sourceSessions) && Object.keys(value.sourceSessions).length === 2
    && SOURCES.every(s => id((value.sourceSessions as Obj)[s])) && obj(value.assessment), r,
  'Paired candidate must be null or source-labelled cross-body evidence.');
  const a = value.assessment;
  check(a.detector === 'wili-waist-provisional-v1' && time(a.assessedAtMs) && obj(a.thresholds)
    && Object.keys(DEFAULT_WILI_THRESHOLDS).every(k => time((a.thresholds as Obj)[k]))
    && time(a.selectedImpactG) && obj(a.impact) && obj(a.supportingWaist) && obj(a.quietWaist)
    && obj(a.alignmentAtAssessment), r, 'Paired candidate is missing its finite immutable assessment features.');
  for (const [key, expected] of [['impact', 'body-wili'], ['supportingWaist', 'waist-airpod'], ['quietWaist', 'waist-airpod']] as const) {
    const point = a[key] as Obj;
    check(point.source === expected && point.sessionId === (value.sourceSessions as Obj)[expected], r,
      'Assessment feature source/session does not match candidate provenance.');
  }
  return value as unknown as Evidence;
}
function differences(recorded: Evidence | null, replayed: Evidence | null) {
  if ((recorded === null) !== (replayed === null)) return ['candidate-presence'];
  if (!recorded || !replayed) return [];
  const reasons: string[] = [];
  if (SOURCES.some(s => recorded.sourceSessions?.[s] !== replayed.sourceSessions?.[s])) reasons.push('source-sessions');
  if (JSON.stringify(recorded.assessment) !== JSON.stringify(replayed.assessment)) reasons.push('assessment-features');
  return reasons;
}

export function replayPairedTrials(records: PairedInput[]) {
  const results: unknown[] = [], trialIds = new Set<string>(); let lastAt = -Infinity;
  function create(start: PairedInput, payload: Obj, atMs: number, at: number) {
    const initial = sources(payload.initialSources, start);
    check(obj(payload.initialSessions) && Object.entries(payload.initialSessions).every(([s, session]) => source(s) && initial.includes(s) && id(session)),
      start, 'initialSessions must name safe sessions of initially connected sources.');
    check(Array.isArray(payload.preservedCalibration) && payload.preservedCalibration.every(c => obj(c) && c.source === 'waist-airpod'
      && c.sessionId === (payload.initialSessions as Obj)['waist-airpod'] && ['Left', 'Right'].includes(c.sensorLocation as string)),
      start, 'Preserved calibration must identify the initial waist session and actual reporting bud.');
    const state = { start, payload, now: atMs, startAtMs: atMs, startAt: at, connected: new Set(initial),
      wili: null as unknown as FreeWili, motion: null as unknown as Motion, detector: null as unknown as WiliAssessment,
      protocol: new WiliDeviceProtocol(), stats: new Map(SOURCES.map(s => [s, metrics(s)])),
      pending: new Map(SOURCES.map(s => [s, new Set<string>()])), seenPings: new Map(SOURCES.map(s => [s, new Set<string>()])),
      clocks: new Map(SOURCES.map(s => [s, { source: s, pings: 0, acceptedPongs: 0, unusablePreSamplePongs: 0, rejectedPongs: 0 }])),
      coverage: new Map(SOURCES.map(s => [s, { source: s, assessments: 0, receiptFresh: 0, alignedFresh: 0, usable: 0 }])),
      markers: [] as { atMs: number; at: number; label: string }[], hellos: [] as { atMs: number; packet: unknown }[],
      calibrations: [] as { atMs: number; sources: string[]; replayedSuccessful: string[]; discrepancy: boolean }[],
      candidates: [] as { atMs: number; at: number; evidence: Evidence }[], discrepancies: [] as { atMs: number; reasons: string[] }[],
      assessments: 0, pairedAlignedAssessments: 0, skippedAssessments: 0, eventCount: 1 };
    state.wili = new FreeWili(() => state.now); state.motion = new Motion(() => state.now); state.detector = new WiliAssessment(() => state.now);
    state.motion.reset({ clocks: true, cooldown: false });
    if (initial.includes('body-wili')) state.wili.connected();
    if (initial.includes('waist-airpod')) state.motion.connected('waist-airpod');
    return state;
  }
  let state: ReturnType<typeof create> | null = null;
  for (const r of records) {
    const e = r.value;
    check(typeof e.type === 'string' && TYPES.has(e.type) && time(e.atMs) && time(e.at), r, 'Unknown event or invalid host timestamps.');
    check(e.atMs >= lastAt, r, 'Host monotonic event times are out of order.'); lastAt = e.atMs;
    const isSourceEvent = ['source.connected', 'source.disconnected', 'device.hello', 'accel.sample', 'motion.sample', 'clock.ping', 'clock.pong'].includes(e.type);
    check(isSourceEvent ? source(e.source) : e.source === undefined, r, 'Event has an invalid or missing source.');
    check(e.payload === undefined || obj(e.payload), r, 'Event payload must be an object.');
    if (!['source.connected', 'source.disconnected'].includes(e.type)) check(obj(e.payload), r, 'Event requires its recorded payload.');
    const p = e.payload as Obj, s = e.source as Source;
    if (e.type === 'trial.start') {
      check(state === null && p.version === 2 && p.captureMode === 'wili-waist' && p.stateBoundary === 'fresh-history-and-clocks'
        && p.capture === 'native-stream' && id(p.id) && text(p.label) && SCENARIOS.has(p.scenario as string), r,
      'Start requires a version-2 paired trial with an explicit fresh-history-and-clocks boundary.');
      check(!trialIds.has(p.id), r, 'Trial ID was reused.'); trialIds.add(p.id); state = create(r, p, e.atMs, e.at); continue;
    }
    check(state !== null, r, 'Event is outside trial boundaries.'); state.now = e.atMs; state.eventCount++;
    if (e.type === 'trial.stop') {
      check(text(p.reason, 200), r, 'Stop requires a bounded reason.');
      const counts = SOURCES.map(s => state!.stats.get(s)!.sampleCount);
      const pairedAligned = state.pairedAlignedAssessments > 0;
      const status = !counts.some(Boolean) ? 'unscored-no-samples' : !counts.every(Boolean) ? 'unscored-missing-paired-samples'
        : !state.assessments ? 'unscored-no-assessments' : !pairedAligned ? 'unscored-no-paired-alignment' : 'replayed';
      results.push({ id: state.payload.id, label: state.payload.label, scenario: state.payload.scenario,
        capture: 'native-stream', captureMode: 'wili-waist', status,
        missing: [...SOURCES.filter(s => !state!.stats.get(s)!.sampleCount).map(s => `${s} samples`),
          ...(!state.assessments ? ['evaluated assessment times'] : []),
          ...(!pairedAligned ? ['simultaneous fresh paired clock alignment at an evaluated assessment'] : [])],
        initialSources: state.payload.initialSources, initialSessions: state.payload.initialSessions,
        preservedCalibration: state.payload.preservedCalibration,
        calibrationInterpretation: 'Preserved baseline is an annotation; paired acceleration assessment does not use or invent it.',
        startAtMs: state.startAtMs, stopAtMs: e.atMs, startAt: state.startAt, stopAt: e.at,
        durationMs: round(e.atMs - state.startAtMs), stopReason: p.reason, eventCount: state.eventCount,
        sampleCount: counts.reduce((a, b) => a + b, 0), assessmentCount: state.assessments,
        pairedAlignedAssessments: state.pairedAlignedAssessments,
        skippedActiveIncidentAssessments: state.skippedAssessments, markers: state.markers, helloHistory: state.hellos,
        sourceMetrics: SOURCES.map(s => summary(state!.stats.get(s)!)),
        clockExchanges: [...state.clocks.values()], coverageAtEvaluatedAssessments: [...state.coverage.values()],
        calibrationEvents: state.calibrations, detector: 'wili-waist-provisional-v1', thresholds: DEFAULT_WILI_THRESHOLDS,
        candidates: state.candidates, discrepancies: state.discrepancies, discrepancyCount: state.discrepancies.length,
        comparison: 'Current paired prototype rule only; no single-device fallback, accuracy score or inferred ground truth.' });
      state = null; continue;
    }
    if (isSourceEvent && !['source.connected', 'source.disconnected'].includes(e.type))
      check(state.connected.has(s), r, 'Source data arrived while disconnected.');
    if (e.type === 'source.connected') {
      check(!state.connected.has(s), r, 'Source connected twice without disconnect.'); state.connected.add(s);
      if (s === 'body-wili') { state.protocol = new WiliDeviceProtocol(); state.wili.connected(); } else state.motion.connected(s);
    } else if (e.type === 'source.disconnected') {
      check(state.connected.delete(s), r, 'Source disconnected without a connection.'); state.pending.get(s)!.clear();
      if (s === 'body-wili') { state.wili.disconnected(); state.protocol = new WiliDeviceProtocol(); } else state.motion.disconnected(s);
    } else if (e.type === 'device.hello') {
      check(s === 'body-wili' && validWiliHello(p), r, 'Malformed board hello/capabilities.');
      try { state.protocol.accept(p); } catch (error) { check(false, r, (error as Error).message); }
      state.hellos.push({ atMs: e.atMs, packet: p });
    } else if (e.type === 'accel.sample' || e.type === 'motion.sample') {
      if (e.type === 'accel.sample') {
        check(s === 'body-wili' && validBodyWiliSample(p), r, 'Malformed raw acceleration, range, clock or saturation.');
        try { state.protocol.accept(p); } catch (error) { check(false, r, (error as Error).message); }
        count(state.stats.get(s)!, p, e.atMs, r); check(state.wili.sample(p), r, 'Board adapter rejected recorded sample/session.');
        const observation = state.wili.observations().at(-1)!;
        if (observation.alignedAtMs !== null) state.stats.get(s)!.alignedSamples++;
        if (observation.captureFresh) state.stats.get(s)!.captureFreshSamples++;
      } else {
        check(s === 'waist-airpod' && validSample(p, s) && time(p.sensorTime), r, 'Malformed waist motion or reporting bud.');
        count(state.stats.get(s)!, p, e.atMs, r); check(state.motion.sample(s, p), r, 'Motion adapter rejected recorded sample/session.');
        const observation = state.motion.observations(s).at(-1)!;
        if (observation.alignedAtMs !== null) state.stats.get(s)!.alignedSamples++;
        if (observation.alignedAtMs !== null && observation.captureFresh) state.stats.get(s)!.captureFreshSamples++;
      }
    } else if (e.type === 'clock.ping') {
      check(p.type === 'clock.ping' && id(p.id) && p.serverSentMs === e.atMs && !state.seenPings.get(s)!.has(p.id), r,
        'Clock ping must use its actual recorded host send time and a new safe ID.');
      state.seenPings.get(s)!.add(p.id); state.pending.get(s)!.add(p.id); state.clocks.get(s)!.pings++;
      if (s === 'body-wili') {
        check(state.protocol.hello, r, 'Board ping precedes hello.'); state.wili.ping(p.id);
      } else state.motion.ping(s, p.id);
    } else if (e.type === 'clock.pong') {
      check(validWiliPong(p) && state.pending.get(s)!.delete(p.id), r, 'Clock pong has no valid matching recorded ping.');
      const session = state.stats.get(s)!.last?.session;
      check(!session || session === p.sessionId, r, 'Clock pong identifies a stale sample session.');
      if (s === 'body-wili') try { state.protocol.accept(p); } catch (error) { check(false, r, (error as Error).message); }
      const accepted = s === 'body-wili' ? state.wili.pong(p) : state.motion.pong(s, p as ClockPong);
      const clocks = state.clocks.get(s)!;
      if (accepted) clocks.acceptedPongs++; else if (!session) clocks.unusablePreSamplePongs++; else clocks.rejectedPongs++;
    } else if (e.type === 'calibration') {
      const selected = sources(p.sources, r); check(selected.every(s => s === 'waist-airpod'), r, 'Raw WILi acceleration cannot be Core Motion calibrated.');
      const replayed = state.motion.calibrate(selected as 'waist-airpod'[]);
      state.calibrations.push({ atMs: e.atMs, sources: selected, replayedSuccessful: replayed,
        discrepancy: JSON.stringify(selected) !== JSON.stringify(replayed) });
    } else if (e.type === 'motion.reset') {
      check(typeof p.clocks === 'boolean' && typeof p.cooldown === 'boolean', r, 'Reset requires explicit clock/cooldown booleans.');
      state.motion.reset({ clocks: p.clocks, cooldown: p.cooldown }); state.detector.reset({ cooldown: p.cooldown });
      if (p.clocks) state.pending.get('waist-airpod')!.clear();
    } else if (e.type === 'trial.marker') {
      check(text(p.label), r, 'Marker label must be bounded and contain no control characters.');
      state.markers.push({ atMs: e.atMs, at: e.at, label: p.label });
    } else if (e.type === 'assessment') {
      check(typeof p.evaluated === 'boolean' && p.detector === 'wili-waist-provisional-v1', r, 'Assessment requires evaluated flag and paired detector ID.');
      const recorded = evidence(p.candidate, r);
      if (!p.evaluated) { check(recorded === null, r, 'Skipped assessment cannot contain a candidate.'); state.skippedAssessments++; continue; }
      state.assessments++; const candidate = state.detector.candidate(state.wili, state.motion);
      if (candidate) state.candidates.push({ atMs: e.atMs, at: e.at, evidence: candidate });
      const reasons = differences(recorded, candidate); if (reasons.length) state.discrepancies.push({ atMs: e.atMs, reasons });
      const body = state.wili.view(), waist = state.motion.views().find(v => v.source === 'waist-airpod')!;
      if ([body, waist].every(v => v.fresh && v.alignmentUncertaintyMs !== null && v.alignmentUncertaintyMs <= 100)) state.pairedAlignedAssessments++;
      for (const s of SOURCES) {
        const v = s === 'body-wili' ? body : waist;
        const c = state.coverage.get(s)!; c.assessments++;
        const lastReceived = state.stats.get(s)!.lastHostMs;
        if (v.connected && lastReceived !== null && e.atMs - lastReceived < 500) c.receiptFresh++;
        if (v.fresh && v.alignmentUncertaintyMs !== null && v.alignmentUncertaintyMs <= 100) c.alignedFresh++;
        if (s === 'body-wili' ? body.usable : v.fresh && v.alignmentUncertaintyMs !== null) c.usable++;
      }
    }
  }
  check(state === null, records.at(-1)!, 'Paired trial is unfinished; stop recording before replay.');
  return { format: 'trial-events-v2', status: 'offline-replay', recordCount: records.length, trials: results };
}

export function analyseRawWili(records: PairedInput[]) {
  const m = metrics('body-wili'); let lastAt = -Infinity;
  for (const r of records) {
    const { receivedAt, hostMonotonicMs, ...packet } = r.value;
    check(time(receivedAt) && time(hostMonotonicMs) && hostMonotonicMs >= lastAt && validBodyWiliSample(packet), r,
      'Raw board file needs valid accel.sample and finite ordered receive clocks.');
    lastAt = hostMonotonicMs; count(m, packet, hostMonotonicMs, r);
  }
  return { format: 'raw-wili-samples', status: 'unscored', recordCount: records.length, sourceMetrics: [summary(m)],
    candidates: null, missing: ['paired waist stream', 'hello/capabilities', 'recorded clock exchanges', 'trial boundaries', 'assessment times'],
    modes: [{ mode: 'wili-waist', status: 'unscored', candidates: null,
      reason: 'Raw board measurements have no recorded paired alignment or assessment history.' }],
    interpretation: 'Raw metadata only. No clock alignment, paired evidence or board acquisition timestamp is invented.' };
}
