import type { Evidence } from './contracts.ts';
import type { FreeWili } from './freewili.ts';
import type { Motion } from './motion.ts';
import { DEFAULT_WILI_THRESHOLDS, WILI_ALIVE_MS, usableRange, waistPoint, wiliPoint } from './wili-assessment.ts';
import type { WiliAssessmentFeatures } from './wili-assessment.ts';

export interface EarlyCheckinFeatures {
  detector: 'wili-waist-early-checkin-v1';
  assessedAtMs: number;
  selectedAccelerationG: number;
  acceleration: WiliAssessmentFeatures['impact'];
  supportingWaist: WiliAssessmentFeatures['supportingWaist'];
  alignmentAtAssessment: WiliAssessmentFeatures['alignmentAtAssessment'];
  thresholds: { accelerationG: number; waistLinearG: number; waistAngularSpeed: number; correlationMs: number; maxEventAgeMs: number };
}

export function detectionProfile(value: string | undefined): 'fall-confirmation' | 'early-checkin' {
  const profile = value?.trim() || 'fall-confirmation';
  if (profile !== 'fall-confirmation' && profile !== 'early-checkin')
    throw new Error('LIFELINE_DETECTION_PROFILE must be fall-confirmation or early-checkin.');
  return profile;
}

/** An opt-in sensitive check-in, not a fall prediction. Uses measured paired motion;
 * does not require stillness, infer descent height, or fabricate a floor impact. */
export class EarlyCheckinAssessment {
  private lastCandidateAt = -Infinity;
  private consumed = new Set<string>();
  private readonly now: () => number;
  constructor(now = () => performance.now()) { this.now = now; }
  reset(options: { cooldown?: boolean } = {}): void {
    this.lastCandidateAt = options.cooldown === false ? -Infinity : this.now();
  }
  candidate(wili: Pick<FreeWili, 'view' | 'observations'>, motion: Pick<Motion, 'views' | 'observations'>,
    assessedAtMs = this.now()): Evidence | null {
    const now = assessedAtMs, t = DEFAULT_WILI_THRESHOLDS;
    if (!Number.isFinite(now) || now < 0 || now - this.lastCandidateAt < t.cooldownMs) return null;
    const body = wili.view(now), waist = motion.views(now).find(v => v.source === 'waist-airpod');
    if (!body.connected || !body.sessionId || body.receivedAgeMs === null || body.receivedAgeMs < 0 || body.receivedAgeMs >= WILI_ALIVE_MS
      || body.fullScaleG === null || !usableRange(body.captureClock, body.fullScaleG)
      || body.alignmentUncertaintyMs === null || body.alignmentUncertaintyMs > t.maxAlignmentUncertaintyMs
      || !waist?.connected || !waist.fresh || !waist.sessionId
      || !['Left', 'Right'].includes(waist.sensorLocation ?? '')
      || waist.alignmentUncertaintyMs === null || waist.alignmentUncertaintyMs > t.maxAlignmentUncertaintyMs) return null;
    const threshold = body.captureClock === 'host-receipt' ? t.stockImpactG : t.impactG;
    for (const point of wili.observations().reverse()) {
      if (!wiliPoint(point, body.sessionId) || point.sample.captureClock !== body.captureClock
        || point.totalG < threshold || point.hostReceivedMs > now || point.alignedAtMs > now
        || now - point.alignedAtMs > 1500) continue;
      const identity = `${point.sample.sessionId}:${point.sample.sequence}`;
      if (this.consumed.has(identity)) continue;
      const support = motion.observations('waist-airpod').filter(p => waistPoint(p, waist.sessionId!)
        && p.hostReceivedMs <= now && p.alignedAtMs! <= now
        && Math.abs(p.alignedAtMs! - point.alignedAtMs) <= t.correlationMs
        && (p.linearG >= t.waistLinearG || p.angularSpeed >= t.waistAngularSpeed))
        .sort((a, b) => Math.abs(a.alignedAtMs! - point.alignedAtMs) - Math.abs(b.alignedAtMs! - point.alignedAtMs))[0];
      if (!support || support.alignedAtMs === null) continue;
      const onset: EarlyCheckinFeatures = {
        detector: 'wili-waist-early-checkin-v1', assessedAtMs: now, selectedAccelerationG: threshold,
        thresholds: { accelerationG: threshold, waistLinearG: t.waistLinearG, waistAngularSpeed: t.waistAngularSpeed,
          correlationMs: t.correlationMs, maxEventAgeMs: 1500 },
        acceleration: { source: 'body-wili', sessionId: point.sample.sessionId, sequence: point.sample.sequence,
          sensorTime: point.sample.sensorTime, captureClock: point.sample.captureClock, alignedAtMs: point.alignedAtMs,
          hostReceivedMs: point.hostReceivedMs, accelerationG: [...point.sample.accelerationG], totalG: point.totalG,
          fullScaleG: point.sample.fullScaleG, quality: 'measured', saturated: point.saturated || point.sample.saturated },
        supportingWaist: { source: 'waist-airpod', sessionId: support.sessionId, sensorLocation: support.sensorLocation,
          sequence: support.sequence, sensorTime: support.sensorTime, alignedAtMs: support.alignedAtMs,
          hostReceivedMs: support.hostReceivedMs, linearG: support.linearG, angularSpeed: support.angularSpeed,
          separationMs: Math.abs(support.alignedAtMs - point.alignedAtMs) },
        alignmentAtAssessment: { bodyClock: point.sample.captureClock, bodyUncertaintyMs: body.alignmentUncertaintyMs,
          waistUncertaintyMs: waist.alignmentUncertaintyMs },
      };
      this.lastCandidateAt = now; this.consumed.add(identity);
      while (this.consumed.size > 64) this.consumed.delete(this.consumed.values().next().value!);
      const magnitude = onset.acceleration.saturated ? `at least ${point.sample.fullScaleG.toFixed(2)} g (sensor limit)` : `${point.totalG.toFixed(2)} g`;
      return { kind: 'cross-body', eventType: 'possible-balance-loss', onset,
        sourceSessions: { 'body-wili': body.sessionId, 'waist-airpod': waist.sessionId },
        summary: `Possible loss of balance: chest acceleration ${magnitude} correlated with waist movement ${onset.supportingWaist.separationMs.toFixed(0)} ms apart. Early check-in; floor impact and stillness not established.` };
    }
    return null;
  }
}
