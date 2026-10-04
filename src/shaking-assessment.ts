import type { Evidence } from './contracts.ts';
import type { FreeWili, BodyWiliObservation } from './freewili.ts';
import type { Motion, MotionObservation } from './motion.ts';

// Exploratory movement gates, not clinical seizure criteria. Independent of fall thresholds.
export const SHAKING_GATES = Object.freeze({ windowMs: 4000, maxGapMs: 200,
  minAngularSpeed: 1.2, minLinearG: .25, minActiveFraction: .65,
  minReversals: 16, minBodyRangeG: .35, minBodyReversals: 8, cooldownMs: 20_000 });
export interface ShakingFeatures {
  detector: 'sustained-shaking-exploratory-v1'; assessedAtMs: number;
  gates: typeof SHAKING_GATES; durationMs: number; waistSampleCount: number; bodySampleCount: number;
  waistReversals: number; bodyReversals: number; waistAxis: number;
  activeFraction: number; peakAngularSpeed: number; bodyRangeG: number;
  bodySession: string; waistSession: string; bodyFirstSequence: number; bodyLastSequence: number;
  waistFirstSequence: number; waistLastSequence: number; maxGapMs: number;
  bodyTiming: 'device-monotonic' | 'host-receipt'; bodyUncertaintyMs: number; waistUncertaintyMs: number;
}
function reversals(values: number[], deadband: number): number {
  let sign = 0, count = 0;
  for (const value of values) {
    const next = value > deadband ? 1 : value < -deadband ? -1 : 0;
    if (!next) continue;
    if (sign && next !== sign) count++;
    sign = next;
  }
  return count;
}
type Timed = { alignedAtMs: number | null; hostReceivedMs: number; captureFresh: boolean };
function coverage(points: Timed[], now: number): number | null {
  const g = SHAKING_GATES;
  if (points.length < 25 || points.some(p => !p.captureFresh || p.alignedAtMs === null
    || !Number.isFinite(p.alignedAtMs) || !Number.isFinite(p.hostReceivedMs)
    || p.hostReceivedMs - p.alignedAtMs < -100 || p.hostReceivedMs - p.alignedAtMs >= 500)) return null;
  if (points[0].alignedAtMs! > now - g.windowMs + g.maxGapMs || points.at(-1)!.alignedAtMs! < now - g.maxGapMs) return null;
  let maxGap = 0;
  for (let i = 1; i < points.length; i++) {
    const capture = points[i].alignedAtMs! - points[i - 1].alignedAtMs!;
    const receipt = points[i].hostReceivedMs - points[i - 1].hostReceivedMs;
    if (capture <= 0 || receipt < 0 || capture > g.maxGapMs || receipt > g.maxGapMs) return null;
    maxGap = Math.max(maxGap, capture, receipt);
  }
  return maxGap;
}

/** Sustained, alternating movement at BOTH sites starts an unresolved check-in.
 * No seizure diagnosis, fall threshold changes, simulated input, or orientation claim.
 */
export class ShakingAssessment {
  private lastAt = -Infinity;
  private now: () => number;
  constructor(now = () => performance.now()) { this.now = now; }
  reset(): void { this.lastAt = this.now(); }
  candidate(wili: Pick<FreeWili, 'view' | 'observations'>, motion: Pick<Motion, 'views' | 'observations'>,
    now = this.now()): Evidence | null {
    const g = SHAKING_GATES;
    if (!Number.isFinite(now) || now < 0 || now - this.lastAt < g.cooldownMs) return null;
    const body = wili.view(now), waist = motion.views(now).find(v => v.source === 'waist-airpod');
    if (!body.connected || !body.fresh || !body.usable || body.quality !== 'measured' || body.saturated !== false
      || !body.sessionId || !waist?.connected || !waist.fresh || !waist.sessionId
      || !['Left', 'Right'].includes(waist.sensorLocation ?? '')
      || body.alignmentUncertaintyMs === null || body.alignmentUncertaintyMs > 100
      || waist.alignmentUncertaintyMs === null || waist.alignmentUncertaintyMs > 100) return null;
    const inWindow = (p: Timed) => p.hostReceivedMs >= now - g.windowMs && p.hostReceivedMs <= now;
    const b: BodyWiliObservation[] = wili.observations().filter(inWindow);
    const w: MotionObservation[] = motion.observations('waist-airpod').filter(inWindow);
    if (b.some(p => p.sample.sessionId !== body.sessionId || p.sample.source !== 'body-wili' || !p.usable
      || p.saturated || p.sample.quality !== 'measured' || p.sample.captureClock !== body.captureClock || !Number.isFinite(p.totalG))
      || w.some(p => p.sessionId !== waist.sessionId || p.sensorLocation !== waist.sensorLocation
        || !Number.isFinite(p.linearG) || !Number.isFinite(p.angularSpeed)
        || !Array.isArray(p.rotationRate) || p.rotationRate.length !== 3 || !p.rotationRate.every(Number.isFinite))) return null;
    const bg = coverage(b, now), wg = coverage(w, now);
    if (bg === null || wg === null) return null;
    const activeFraction = w.filter(p => p.angularSpeed >= g.minAngularSpeed && p.linearG >= g.minLinearG).length / w.length;
    const axes = [0, 1, 2].map(axis => reversals(w.map(p => p.rotationRate[axis]), g.minAngularSpeed));
    const waistReversals = Math.max(...axes), waistAxis = axes.indexOf(waistReversals);
    const bodyRangeG = Math.max(...b.map(p => p.totalG)) - Math.min(...b.map(p => p.totalG));
    const mean = b.reduce((sum, p) => sum + p.totalG, 0) / b.length;
    const bodyReversals = reversals(b.map(p => p.totalG - mean), .1);
    if (activeFraction < g.minActiveFraction || waistReversals < g.minReversals
      || bodyRangeG < g.minBodyRangeG || bodyReversals < g.minBodyReversals) return null;
    this.lastAt = now;
    const shaking: ShakingFeatures = {
      detector: 'sustained-shaking-exploratory-v1', assessedAtMs: now, gates: { ...g },
      durationMs: Math.min(b.at(-1)!.alignedAtMs! - b[0].alignedAtMs!, w.at(-1)!.alignedAtMs! - w[0].alignedAtMs!),
      waistSampleCount: w.length, bodySampleCount: b.length, waistReversals, bodyReversals, waistAxis, activeFraction,
      peakAngularSpeed: Math.max(...w.map(p => p.angularSpeed)), bodyRangeG,
      bodySession: body.sessionId, waistSession: waist.sessionId,
      bodyFirstSequence: b[0].sample.sequence, bodyLastSequence: b.at(-1)!.sample.sequence,
      waistFirstSequence: w[0].sequence, waistLastSequence: w.at(-1)!.sequence, maxGapMs: Math.max(bg, wg),
      bodyTiming: body.captureClock, bodyUncertaintyMs: body.alignmentUncertaintyMs, waistUncertaintyMs: waist.alignmentUncertaintyMs,
    };
    Object.freeze(shaking.gates); Object.freeze(shaking);
    return Object.freeze({ kind: 'cross-body', eventType: 'sustained-shaking', shaking,
      sourceSessions: Object.freeze({ 'body-wili': body.sessionId, 'waist-airpod': waist.sessionId }),
      summary: `Sustained unusual movement / possible seizure-like motion: ${(shaking.durationMs / 1000).toFixed(1)} s at chest and waist, ${waistReversals} waist rotation reversals. This motion pattern is not a seizure diagnosis.` });
  }
}
