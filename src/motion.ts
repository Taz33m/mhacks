import { randomUUID } from 'node:crypto';
import type { ClockPing, ClockPong, Evidence, MotionSample, SensorView, Source, Vec3 } from './contracts.ts';

const sources: Source[] = ['chest-phone', 'waist-airpod'];
export type DetectionMode = 'combined' | 'chest-only' | 'waist-only';
const norm = (v: number[]) => Math.hypot(...v);
const vec = (v: unknown, length: number): v is number[] => Array.isArray(v) && v.length === length && v.every(n => typeof n === 'number' && Number.isFinite(n));
export function validSample(p: unknown, source: Source): p is MotionSample {
  if (!p || typeof p !== 'object') return false;
  const s = p as MotionSample;
  return s.type === 'motion.sample' && s.source === source
    && (source === 'chest-phone' ? s.sensorLocation === 'phone' : ['Left', 'Right'].includes(s.sensorLocation))
    && typeof s.sessionId === 'string' && /^[\w-]{1,80}$/.test(s.sessionId)
    && Number.isSafeInteger(s.sequence) && s.sequence >= 0 && Number.isFinite(s.sensorTime) && s.sensorTime >= 0
    && vec(s.quaternion, 4) && norm(s.quaternion) > .7 && norm(s.quaternion) < 1.3
    && vec(s.rotationRate, 3) && norm(s.rotationRate) < 100
    && vec(s.gravity, 3) && norm(s.gravity) > .5 && norm(s.gravity) < 1.5
    && vec(s.userAcceleration, 3) && norm(s.userAcceleration) < 100;
}
interface Point { at: number; alignedAt: number | null; captureFresh: boolean; totalG: number; tiltDegrees: number | null; angularSpeed: number; linearG: number }
interface Stream {
  source: Source; connected: boolean; session: string | null; location: string | null;
  sequence: number; sensorTime: number; lastAt: number | null; lastCaptureAt: number | null; baseline: Vec3 | null;
  points: Point[]; samples: { at: number; gravity: Vec3; angularSpeed: number; linearG: number; captureFresh: boolean }[];
  offset: number | null; uncertainty: number | null; syncAt: number | null;
  pending: Map<string, number>;
}
export class Motion {
  private streams = new Map<Source, Stream>();
  private lastCandidateAt = -Infinity;
  private now: () => number;
  private mode: DetectionMode;
  constructor(now = () => performance.now(), options: { mode?: DetectionMode } = {}) {
    this.now = now;
    this.mode = options.mode ?? 'combined';
    for (const source of sources) this.streams.set(source, {
      source, connected: false, session: null, location: null, sequence: -1, sensorTime: -1,
      lastAt: null, lastCaptureAt: null, baseline: null, points: [], samples: [], offset: null, uncertainty: null, syncAt: null, pending: new Map()
    });
  }
  connected(source: Source): void { this.streams.get(source)!.connected = true; }
  disconnected(source: Source): void {
    const s = this.streams.get(source)!;
    s.connected = false; s.baseline = null; s.points = []; s.samples = []; s.lastAt = null; s.lastCaptureAt = null;
    s.offset = null; s.uncertainty = null; s.syncAt = null; s.pending.clear();
  }
  ping(source: Source, id: string = randomUUID()): ClockPing {
    const s = this.streams.get(source)!; const t = this.now();
    for (const [key, at] of s.pending) if (t - at > 10_000) s.pending.delete(key);
    s.pending.set(id, t); return { type: 'clock.ping', id, serverSentMs: t };
  }
  pong(source: Source, p: ClockPong, receivedMs = this.now()): boolean {
    const s = this.streams.get(source)!; const t0 = s.pending.get(p.id); const t3 = receivedMs;
    if (t0 === undefined || !s.session || p.sessionId !== s.session || !Number.isFinite(p.deviceReceivedMs)
      || !Number.isFinite(p.deviceSentMs) || p.deviceSentMs < p.deviceReceivedMs) return false;
    s.pending.delete(p.id);
    const latency = (t3 - t0) - (p.deviceSentMs - p.deviceReceivedMs);
    if (latency < -1 || latency > 1000) return false;
    const uncertainty = Math.max(0, latency / 2);
    if (s.uncertainty === null || uncertainty <= s.uncertainty || s.syncAt === null || t3 - s.syncAt > 10_000) {
      s.offset = ((t0 - p.deviceReceivedMs) + (t3 - p.deviceSentMs)) / 2;
      s.uncertainty = uncertainty; s.syncAt = t3;
    }
    return true;
  }
  sample(source: Source, p: unknown, receivedMs = this.now()): boolean {
    if (!validSample(p, source)) return false;
    const s = this.streams.get(source)!; const t = receivedMs;
    if (s.session !== p.sessionId || s.location !== p.sensorLocation) {
      s.session = p.sessionId; s.location = p.sensorLocation; s.sequence = -1; s.sensorTime = -1;
      s.baseline = null; s.points = []; s.samples = []; s.lastAt = null; s.lastCaptureAt = null;
      s.offset = null; s.uncertainty = null; s.syncAt = null;
    }
    if (p.sequence <= s.sequence || p.sensorTime <= s.sensorTime) return false;
    if (s.lastAt !== null && t - s.lastAt > 500) {
      s.baseline = null; s.points = []; s.samples = [];
      s.offset = null; s.uncertainty = null; s.syncAt = null;
    }
    s.sequence = p.sequence; s.sensorTime = p.sensorTime; s.lastAt = t; s.connected = true;
    const tilt = s.baseline ? Math.acos(Math.min(1, Math.max(-1,
      p.gravity.reduce((sum, v, i) => sum + v * s.baseline![i], 0) / (norm(p.gravity) * norm(s.baseline))))) * 180 / Math.PI : null;
    const alignedAt = s.offset !== null && s.syncAt !== null && t - s.syncAt < 15_000 && s.uncertainty !== null && s.uncertainty <= 100
      ? p.sensorTime * 1000 + s.offset : null;
    s.lastCaptureAt = alignedAt;
    const captureFresh = alignedAt === null || (t - alignedAt >= -100 && t - alignedAt < 500);
    s.points.push({ at: t, alignedAt, captureFresh, totalG: norm(p.gravity.map((v, i) => v + p.userAcceleration[i])),
      tiltDegrees: tilt, angularSpeed: norm(p.rotationRate), linearG: norm(p.userAcceleration) });
    s.samples.push({ at: t, gravity: p.gravity, angularSpeed: norm(p.rotationRate), linearG: norm(p.userAcceleration), captureFresh });
    s.points = s.points.filter(p => t - p.at < 15_000).slice(-1600);
    s.samples = s.samples.filter(p => t - p.at < 2000).slice(-220);
    return true;
  }
  calibrate(selected: Source[] = sources): Source[] {
    const calibrated: Source[] = []; const t = this.now();
    for (const source of selected) {
      const s = this.streams.get(source)!;
      const recent = s.samples.filter(p => t - p.at < 1200);
      if (!this.fresh(s, t) || recent.length < 5
        || recent.at(-1)!.at - recent[0].at < 1000
        || recent.some((p, index) => !p.captureFresh || p.angularSpeed > .35 || p.linearG > .15 || (index > 0 && p.at - recent[index - 1].at > 200))) continue;
      const baseline = [0, 1, 2].map(axis => recent.reduce((sum, p) => sum + p.gravity[axis], 0) / recent.length) as Vec3;
      if (norm(baseline) < .8 || recent.some(p => norm(p.gravity.map((v, axis) => v - baseline[axis])) > .12)) continue;
      s.baseline = baseline; s.points = []; calibrated.push(source);
    }
    if (calibrated.length) this.lastCandidateAt = -Infinity;
    return calibrated;
  }
  reset(options: { clocks?: boolean; cooldown?: boolean } = {}): void {
    for (const s of this.streams.values()) {
      s.baseline = null; s.points = []; s.samples = [];
      if (options.clocks) { s.offset = null; s.uncertainty = null; s.syncAt = null; s.lastCaptureAt = null; s.pending.clear(); }
    }
    this.lastCandidateAt = options.cooldown === false ? -Infinity : this.now();
  }
  views(): SensorView[] {
    const t = this.now();
    return sources.map(source => {
      const s = this.streams.get(source)!;
      const age = s.lastAt === null ? null : Math.max(t - s.lastAt, s.lastCaptureAt === null ? 0 : t - s.lastCaptureAt);
      const fresh = this.fresh(s, t);
      const recent = s.points.filter(p => t - p.at < 2000); const last = s.points.at(-1);
      const first = recent.at(0), end = recent.at(-1);
      return { source, connected: s.connected, fresh, calibrated: fresh && Boolean(s.baseline),
        sensorLocation: s.location, sessionId: s.session, ageMs: age === null ? null : Math.round(age),
        sampleHz: first && end && end.at > first.at ? Math.round((recent.length - 1) * 1000 / (end.at - first.at)) : 0,
        alignmentUncertaintyMs: s.syncAt !== null && t - s.syncAt < 15_000 ? s.uncertainty : null,
        totalG: fresh ? last?.totalG ?? null : null, tiltDegrees: fresh ? last?.tiltDegrees ?? null : null,
        trace: s.points.filter((_, index) => index % Math.max(1, Math.floor(s.points.length / 250)) === 0)
          .map(p => ({ at: p.at, totalG: p.totalG, tiltDegrees: p.tiltDegrees, angularSpeed: p.angularSpeed })) };
    });
  }
  candidate(): Evidence | null {
    const t = this.now(); if (t - this.lastCandidateAt < 20_000) return null;
    const chest = this.streams.get('chest-phone')!; const waist = this.streams.get('waist-airpod')!;
    const primary = this.mode === 'waist-only' ? waist : chest;
    if (!primary.baseline || !this.fresh(primary, t)) return null;
    const impact = primary.points.findLast(p => p.captureFresh && p.totalG >= 2.5 && t - p.at >= 2800 && t - p.at <= 5500);
    if (!impact) return null;
    if (!this.quiet(primary, t)) return null;
    const waistFresh = this.fresh(waist, t);
    let kind: Evidence['kind'];
    if (this.mode === 'combined' && waistFresh) {
      if (!waist.baseline || impact.alignedAt === null || !this.aligned(chest, t) || !this.aligned(waist, t)) return null;
      const tilted = waist.points.some(p => p.captureFresh && p.tiltDegrees !== null && p.tiltDegrees >= 60 && p.alignedAt !== null && Math.abs(p.alignedAt - impact.alignedAt!) <= 2000);
      if (!tilted || !this.quiet(waist, t)) return null;
      kind = 'cross-body';
    } else {
      if (!primary.points.some(p => p.captureFresh && p.at >= impact.at && p.tiltDegrees !== null && p.tiltDegrees >= 60)) return null;
      kind = 'single-source';
    }
    this.lastCandidateAt = t;
    const description = kind === 'cross-body' ? 'Aligned chest impact and waist tilt'
      : this.mode === 'combined' ? 'Chest-only impact and tilt; waist unavailable'
        : `${this.mode === 'waist-only' ? 'Waist' : 'Chest'}-only impact and tilt (diagnostic assessment)`;
    return { kind, summary: `${description}, followed by continuous low motion. Prototype thresholds, suspected incident.`,
      sourceSessions: kind === 'cross-body' ? { 'chest-phone': chest.session!, 'waist-airpod': waist.session! } : { [primary.source]: primary.session! } };
  }
  private fresh(s: Stream, t: number): boolean {
    return s.connected && s.lastAt !== null && t - s.lastAt < 500
      && (s.lastCaptureAt === null || (t - s.lastCaptureAt >= -100 && t - s.lastCaptureAt < 500));
  }
  private aligned(s: Stream, t: number): boolean { return s.syncAt !== null && t - s.syncAt < 15_000 && s.uncertainty !== null && s.uncertainty <= 100; }
  private quiet(s: Stream, t: number): boolean {
    const points = s.points.filter(p => t - p.at <= 2800);
    return points.length >= 15 && points[0].at <= t - 2400 && points.at(-1)!.at >= t - 200
      && points.every((p, index) => p.captureFresh && p.angularSpeed <= .35 && p.linearG <= .15 && (index === 0 || p.at - points[index - 1].at <= 200));
  }
}
