import type { Evidence } from './contracts.ts';
import type { BodyWiliObservation, FreeWili } from './freewili.ts';
import type { Motion, MotionObservation } from './motion.ts';

/** Provisional demo thresholds, not validated clinical fall criteria. */
export interface WiliAssessmentThresholds {
  impactG: number;
  stockImpactG: number;
  waistLinearG: number;
  waistAngularSpeed: number;
  correlationMs: number;
  settlingMs: number;
  quietMs: number;
  quietLinearG: number;
  quietAngularSpeed: number;
  maxSampleGapMs: number;
  maxEventAgeMs: number;
  maxAlignmentUncertaintyMs: number;
  cooldownMs: number;
}
export const DEFAULT_WILI_THRESHOLDS: Readonly<WiliAssessmentThresholds> = Object.freeze({
  impactG: 2.5, stockImpactG: 1.65, waistLinearG: .4, waistAngularSpeed: 1.2, correlationMs: 750,
  settlingMs: 800, quietMs: 2400, quietLinearG: .15, quietAngularSpeed: .35,
  maxSampleGapMs: 200, maxEventAgeMs: 6000, maxAlignmentUncertaintyMs: 100, cooldownMs: 20_000,
});

export interface WiliAssessmentFeatures {
  detector: 'wili-waist-provisional-v1';
  assessedAtMs: number;
  thresholds: Readonly<WiliAssessmentThresholds>;
  selectedImpactG: number;
  impact: {
    source: 'body-wili'; sessionId: string; sequence: number; sensorTime: number;
    captureClock: 'device-monotonic' | 'host-receipt'; frameTimestamp?: string; alignedAtMs: number; hostReceivedMs: number;
    accelerationG: [number, number, number]; totalG: number; fullScaleG: number;
    quality: 'measured'; saturated: false;
  };
  supportingWaist: {
    source: 'waist-airpod'; sessionId: string; sensorLocation: string; sequence: number;
    sensorTime: number; alignedAtMs: number; hostReceivedMs: number;
    linearG: number; angularSpeed: number; separationMs: number;
  };
  quietWaist: {
    source: 'waist-airpod'; sessionId: string; firstSequence: number; lastSequence: number;
    fromAlignedAtMs: number; toAlignedAtMs: number; durationMs: number; sampleCount: number;
    maxLinearG: number; maxAngularSpeed: number; maxCaptureGapMs: number; maxReceiveGapMs: number;
  };
  alignmentAtAssessment: { bodyClock: 'device-monotonic' | 'host-receipt'; bodyUncertaintyMs: number; waistUncertaintyMs: number };
}
export interface WiliAssessmentEvidence extends Evidence {
  kind: 'cross-body';
  sourceSessions: { 'body-wili': string; 'waist-airpod': string };
  assessment: WiliAssessmentFeatures;
}
type AlignedWili = BodyWiliObservation & { alignedAtMs: number };
type AlignedWaist = MotionObservation & { alignedAtMs: number };
const finite = (value: number): boolean => Number.isFinite(value);
const hostReceipt = (clock: 'device-monotonic' | 'host-receipt'): boolean => clock === 'host-receipt';
// Stock OG range is usable only with its honestly labelled bridge receipt clock.
function usableRange(clock: 'device-monotonic' | 'host-receipt', fullScaleG: number): boolean {
  return fullScaleG > 2 || (clock === 'host-receipt' && fullScaleG === 2);
}
function captureFresh(received: number, captured: number): boolean {
  return finite(received) && finite(captured) && received - captured >= -100 && received - captured < 500;
}
function wiliPoint(point: BodyWiliObservation, session: string): point is AlignedWili {
  return point.sample.sessionId === session && point.alignedAtMs !== null && point.captureFresh && point.usable
    && captureFresh(point.hostReceivedMs, point.alignedAtMs) && !point.saturated && !point.sample.saturated
    && point.sample.quality === 'measured' && usableRange(point.sample.captureClock, point.sample.fullScaleG)
    && finite(point.totalG) && point.totalG >= 0;
}
function waistPoint(point: MotionObservation, session: string): point is AlignedWaist {
  return point.source === 'waist-airpod' && point.sessionId === session && point.alignedAtMs !== null
    && point.captureFresh && captureFresh(point.hostReceivedMs, point.alignedAtMs)
    && finite(point.linearG) && point.linearG >= 0 && finite(point.angularSpeed) && point.angularSpeed >= 0;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Actual primary acceleration + waist movement followed by waist quiet.
 * Never infers primary orientation or a diagnosis, and never falls back to one device.
 */
export class WiliAssessment {
  private readonly now: () => number;
  private readonly thresholds: Readonly<WiliAssessmentThresholds>;
  private lastCandidateAt = -Infinity;
  private consumed = new Set<string>();

  constructor(now = () => performance.now(), thresholds: Partial<WiliAssessmentThresholds> = {}) {
    this.now = now;
    const configured = { ...DEFAULT_WILI_THRESHOLDS, ...thresholds };
    if (Object.values(configured).some(value => !finite(value) || value < 0)
      || configured.impactG <= 1 || configured.stockImpactG <= 1 || configured.stockImpactG >= 2
      || configured.waistLinearG <= 0 || configured.waistAngularSpeed <= 0
      || configured.quietMs < 500 || configured.maxSampleGapMs <= 0 || configured.maxSampleGapMs >= 500
      || configured.maxAlignmentUncertaintyMs > 100 || configured.correlationMs > 2000
      || configured.maxEventAgeMs > 14_000
      || configured.maxEventAgeMs < configured.quietMs + configured.settlingMs + configured.maxSampleGapMs)
      throw new Error('Invalid provisional WILi assessment thresholds.');
    this.thresholds = Object.freeze(configured);
  }

  reset(options: { cooldown?: boolean } = {}): void {
    this.lastCandidateAt = options.cooldown === false ? -Infinity : this.now();
    // Already emitted impact identities remain consumed even if the same history is passed again.
  }

  candidate(wili: Pick<FreeWili, 'view' | 'observations'>, motion: Pick<Motion, 'views' | 'observations'>,
    assessedAtMs = this.now()): WiliAssessmentEvidence | null {
    const now = assessedAtMs, t = this.thresholds;
    if (!finite(now) || now < 0 || now - this.lastCandidateAt < t.cooldownMs) return null;
    const body = wili.view(now), waist = motion.views(now).find(view => view.source === 'waist-airpod');
    if (!body.connected || !body.fresh || !body.usable || body.quality !== 'measured' || body.saturated !== false
      || !body.sessionId || body.fullScaleG === null || !usableRange(body.captureClock, body.fullScaleG)
      || body.alignmentUncertaintyMs === null || body.alignmentUncertaintyMs > t.maxAlignmentUncertaintyMs
      || !waist?.connected || !waist.fresh || !waist.sessionId
      || !['Left', 'Right'].includes(waist.sensorLocation ?? '')
      || waist.alignmentUncertaintyMs === null || waist.alignmentUncertaintyMs > t.maxAlignmentUncertaintyMs) return null;

    const waistHistory = motion.observations('waist-airpod');
    const quietRaw = waistHistory.filter(point => point.hostReceivedMs >= now - t.quietMs && point.hostReceivedMs <= now);
    if (quietRaw.length < 5 || quietRaw.some(point => !waistPoint(point, waist.sessionId!))) return null;
    const quiet = quietRaw as AlignedWaist[];
    const first = quiet[0], last = quiet.at(-1)!;
    if (first.alignedAtMs > now - t.quietMs + t.maxSampleGapMs || last.alignedAtMs < now - t.maxSampleGapMs
      || last.alignedAtMs > now + 100 || quiet.some(point => point.linearG > t.quietLinearG || point.angularSpeed > t.quietAngularSpeed)) return null;
    let maxCaptureGapMs = 0, maxReceiveGapMs = 0;
    for (let index = 1; index < quiet.length; index++) {
      const captureGap = quiet[index].alignedAtMs - quiet[index - 1].alignedAtMs;
      const receiveGap = quiet[index].hostReceivedMs - quiet[index - 1].hostReceivedMs;
      if (captureGap <= 0 || captureGap > t.maxSampleGapMs || receiveGap < 0 || receiveGap > t.maxSampleGapMs) return null;
      maxCaptureGapMs = Math.max(maxCaptureGapMs, captureGap); maxReceiveGapMs = Math.max(maxReceiveGapMs, receiveGap);
    }

    const selectedImpactG = hostReceipt(body.captureClock) ? t.stockImpactG : t.impactG;
    const impacts = wili.observations().filter(point => wiliPoint(point, body.sessionId!)
      && point.sample.captureClock === body.captureClock
      && point.totalG >= selectedImpactG && point.alignedAtMs! <= first.alignedAtMs - t.settlingMs
      && now - point.alignedAtMs! <= t.maxEventAgeMs && point.hostReceivedMs <= now) as AlignedWili[];
    for (const impact of impacts.reverse()) {
      const identity = `${impact.sample.sessionId}:${impact.sample.sequence}`;
      if (this.consumed.has(identity)) continue;
      const movement = waistHistory.filter(point => waistPoint(point, waist.sessionId!)
        && Math.abs(point.alignedAtMs! - impact.alignedAtMs) <= t.correlationMs
        && point.alignedAtMs! < first.alignedAtMs && point.hostReceivedMs <= now
        && (point.linearG >= t.waistLinearG || point.angularSpeed >= t.waistAngularSpeed)) as AlignedWaist[];
      movement.sort((a, b) => Math.max(b.linearG / t.waistLinearG, b.angularSpeed / t.waistAngularSpeed)
        - Math.max(a.linearG / t.waistLinearG, a.angularSpeed / t.waistAngularSpeed));
      const support = movement[0];
      if (!support) continue;
      this.lastCandidateAt = now; this.consumed.add(identity);
      while (this.consumed.size > 64) this.consumed.delete(this.consumed.values().next().value!);
      const assessment: WiliAssessmentFeatures = {
        detector: 'wili-waist-provisional-v1', assessedAtMs: now, thresholds: { ...t }, selectedImpactG,
        impact: { source: 'body-wili', sessionId: impact.sample.sessionId, sequence: impact.sample.sequence,
          sensorTime: impact.sample.sensorTime, captureClock: impact.sample.captureClock, alignedAtMs: impact.alignedAtMs,
          ...('frameTimestamp' in impact.sample && typeof impact.sample.frameTimestamp === 'string' ? { frameTimestamp: impact.sample.frameTimestamp } : {}),
          hostReceivedMs: impact.hostReceivedMs, accelerationG: [...impact.sample.accelerationG], totalG: impact.totalG,
          fullScaleG: impact.sample.fullScaleG, quality: 'measured', saturated: false },
        supportingWaist: { source: 'waist-airpod', sessionId: support.sessionId, sensorLocation: support.sensorLocation,
          sequence: support.sequence, sensorTime: support.sensorTime, alignedAtMs: support.alignedAtMs,
          hostReceivedMs: support.hostReceivedMs, linearG: support.linearG, angularSpeed: support.angularSpeed,
          separationMs: Math.abs(support.alignedAtMs - impact.alignedAtMs) },
        quietWaist: { source: 'waist-airpod', sessionId: waist.sessionId, firstSequence: first.sequence, lastSequence: last.sequence,
          fromAlignedAtMs: first.alignedAtMs, toAlignedAtMs: last.alignedAtMs, durationMs: last.alignedAtMs - first.alignedAtMs,
          sampleCount: quiet.length, maxLinearG: Math.max(...quiet.map(point => point.linearG)),
          maxAngularSpeed: Math.max(...quiet.map(point => point.angularSpeed)), maxCaptureGapMs, maxReceiveGapMs },
        alignmentAtAssessment: { bodyClock: impact.sample.captureClock, bodyUncertaintyMs: body.alignmentUncertaintyMs, waistUncertaintyMs: waist.alignmentUncertaintyMs },
      };
      return freeze({ kind: 'cross-body',
        summary: `Possible fall: ${impact.totalG.toFixed(2)} g impact with waist movement ${assessment.supportingWaist.separationMs.toFixed(0)} ms apart, then ${(assessment.quietWaist.durationMs / 1000).toFixed(1)} s of stillness.`,
        sourceSessions: { 'body-wili': impact.sample.sessionId, 'waist-airpod': waist.sessionId }, assessment });
    }
    return null;
  }
}
