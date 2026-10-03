import { randomUUID } from 'node:crypto';
import type { ClockPing, ClockPong, Evidence, MotionSample, SensorView, Source, Vec3 } from './contracts.ts';

const sources: Source[] = ['chest-phone', 'waist-airpod'];
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
interface Point { at: number; alignedAt: number | null; totalG: number; tiltDegrees: number | null; angularSpeed: number; linearG: number }
interface Stream {
  source: Source; connected: boolean; session: string | null; location: string | null;
  sequence: number; sensorTime: number; lastAt: number | null; baseline: Vec3 | null;
  points: Point[]; samples: { at: number; gravity: Vec3 }[];
  offset: number | null; uncertainty: number | null; syncAt: number | null;
  pending: Map<string, number>;
}
export class Motion {
  private streams = new Map<Source, Stream>();
  private lastCandidateAt = -Infinity;
  private now: () => number;
  constructor(now = () => performance.now()) {
    this.now = now;
    for (const source of sources) this.streams.set(source, {
      source, connected: false, session: null, location: null, sequence: -1, sensorTime: -1,
      lastAt: null, baseline: null, points: [], samples: [], offset: null, uncertainty: null, syncAt: null, pending: new Map()
    });
  }
  connected(source: Source): void { this.streams.get(source)!.connected = true; }
  disconnected(source: Source): void {
    const s = this.streams.get(source)!;
    s.connected = false; s.baseline = null; s.offset = null; s.uncertainty = null; s.pending.clear();
  }
  ping(source: Source): ClockPing {
    const s = this.streams.get(source)!; const id = randomUUID(); const t = this.now();
    for (const [key, at] of s.pending) if (t - at > 10_000) s.pending.delete(key);
    s.pending.set(id, t); return { type: 'clock.ping', id, serverSentMs: t };
  }
  pong(source: Source, p: ClockPong): boolean {
    const s = this.streams.get(source)!; const t0 = s.pending.get(p.id); const t3 = this.now();
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
  sample(source: Source, p: unknown): boolean {
    if (!validSample(p, source)) return false;
    const s = this.streams.get(source)!; const t = this.now();
    if (s.session !== p.sessionId || s.location !== p.sensorLocation) {
      s.session = p.sessionId; s.location = p.sensorLocation; s.sequence = -1; s.sensorTime = -1;
      s.baseline = null; s.points = []; s.samples = []; s.offset = null; s.uncertainty = null; s.syncAt = null;
    }
    if (p.sequence <= s.sequence || p.sensorTime <= s.sensorTime) return false;
    if (s.lastAt !== null && t - s.lastAt > 500) { s.baseline = null; s.offset = null; s.uncertainty = null; s.syncAt = null; }
    s.sequence = p.sequence; s.sensorTime = p.sensorTime; s.lastAt = t; s.connected = true;
    const tilt = s.baseline ? Math.acos(Math.min(1, Math.max(-1,
      p.gravity.reduce((sum, v, i) => sum + v * s.baseline![i], 0) / (norm(p.gravity) * norm(s.baseline))))) * 180 / Math.PI : null;
    const alignedAt = s.offset !== null && s.syncAt !== null && t - s.syncAt < 15_000 && s.uncertainty !== null && s.uncertainty <= 100
      ? p.sensorTime * 1000 + s.offset : null;
    s.points.push({ at: t, alignedAt, totalG: norm(p.gravity.map((v, i) => v + p.userAcceleration[i])),
      tiltDegrees: tilt, angularSpeed: norm(p.rotationRate), linearG: norm(p.userAcceleration) });
    s.samples.push({ at: t, gravity: p.gravity });
    s.points = s.points.filter(p => t - p.at < 15_000).slice(-1600);
    s.samples = s.samples.filter(p => t - p.at < 2000).slice(-220);
    return true;
  }
  calibrate(): Source[] {
    const calibrated: Source[] = []; const t = this.now();
    for (const source of sources) {
      const s = this.streams.get(source)!;
      const recent = s.samples.filter(p => t - p.at < 1200);
      if (!s.connected || s.lastAt === null || t - s.lastAt > 500 || recent.length < 5) continue;
      const baseline = [0, 1, 2].map(axis => recent.reduce((sum, p) => sum + p.gravity[axis], 0) / recent.length) as Vec3;
      if (norm(baseline) < .8) continue;
      s.baseline = baseline; s.points = []; calibrated.push(source);
    }
    this.lastCandidateAt = -Infinity; return calibrated;
  }
  reset(): void {
    for (const s of this.streams.values()) { s.baseline = null; s.points = []; }
    this.lastCandidateAt = this.now();
  }
  views(): SensorView[] {
    const t = this.now();
    return sources.map(source => {
      const s = this.streams.get(source)!; const age = s.lastAt === null ? null : t - s.lastAt;
      const fresh = s.connected && age !== null && age < 500;
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
    if (!chest.baseline || !chest.connected || chest.lastAt === null || t - chest.lastAt > 500) return null;
    const impact = chest.points.findLast(p => p.totalG >= 2.5 && t - p.at >= 2800 && t - p.at <= 5500);
    if (!impact) return null;
    const settled = chest.points.filter(p => t - p.at <= 2800);
    if (settled.length < 15 || settled[0].at > t - 2400 || settled.some(p => p.angularSpeed > .35 || p.linearG > .15)) return null;
    const waistFresh = waist.connected && waist.lastAt !== null && t - waist.lastAt < 500;
    let kind: Evidence['kind'];
    if (waistFresh) {
      if (!waist.baseline || impact.alignedAt === null) return null;
      const tilted = waist.points.some(p => p.tiltDegrees !== null && p.tiltDegrees >= 60 && p.alignedAt !== null && Math.abs(p.alignedAt - impact.alignedAt!) <= 2000);
      const ws = waist.points.filter(p => t - p.at <= 2800);
      if (!tilted || ws.length < 12 || ws[0].at > t - 2400 || ws.some(p => p.angularSpeed > .35 || p.linearG > .15)) return null;
      kind = 'cross-body';
    } else {
      if (!chest.points.some(p => p.at >= impact.at && p.tiltDegrees !== null && p.tiltDegrees >= 60)) return null;
      kind = 'single-source';
    }
    this.lastCandidateAt = t;
    return { kind, summary: `${kind === 'cross-body' ? 'Aligned chest impact and waist tilt' : 'Chest-only impact and tilt; waist unavailable'}, followed by low motion. Prototype thresholds, suspected incident.`,
      sourceSessions: { 'chest-phone': chest.session!, ...(kind === 'cross-body' ? { 'waist-airpod': waist.session! } : {}) } };
  }
}
