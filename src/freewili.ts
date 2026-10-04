import { randomUUID } from 'node:crypto';

/** Raw board acceleration includes gravity. This is not a Core Motion packet. */
export interface BodyWiliSample {
  type: 'accel.sample'; source: 'body-wili'; sessionId: string; sequence: number;
  sensorTime: number; captureClock: 'device-monotonic' | 'host-receipt'; accelerationG: [number, number, number];
  /** Stock SDK framing value is retained verbatim; its unit is not assumed. */
  frameTimestamp?: string;
  fullScaleG: 2 | 4 | 8 | 16; fresh: true; saturated: boolean; quality: 'measured';
}
export interface WiliClockPing { type: 'clock.ping'; id: string; serverSentMs: number }
export interface WiliClockPong {
  type: 'clock.pong'; id: string; sessionId: string; deviceReceivedMs: number; deviceSentMs: number;
}
export interface BodyWiliObservation {
  sample: BodyWiliSample; hostReceivedMs: number; alignedAtMs: number | null;
  captureFresh: boolean; saturated: boolean; totalG: number; usable: boolean;
}
export type BodyWiliQuality = 'disconnected' | 'awaiting-sample' | 'unsynchronized' | 'stale'
  | 'capture-stale' | 'insufficient-range' | 'saturated' | 'measured';
export interface BodyWiliView {
  source: 'body-wili'; sensorLocation: 'body'; connected: boolean; fresh: boolean; usable: boolean;
  sessionId: string | null; captureClock: 'device-monotonic' | 'host-receipt'; quality: BodyWiliQuality;
  receivedAgeMs: number | null; captureAgeMs: number | null; ageMs: number | null;
  alignmentUncertaintyMs: number | null; sampleHz: number;
  accelerationG: [number, number, number] | null; totalG: number | null;
  fullScaleG: number | null; saturated: boolean | null; rejectedSamples: number;
}

const fields = new Set(['type', 'source', 'sessionId', 'sequence', 'sensorTime', 'captureClock',
  'accelerationG', 'fullScaleG', 'fresh', 'saturated', 'quality', 'frameTimestamp']);
export const wiliId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1000;
export function validBodyWiliSample(value: unknown): value is BodyWiliSample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as BodyWiliSample;
  return Object.keys(p).every(key => fields.has(key))
    && p.type === 'accel.sample' && p.source === 'body-wili' && wiliId(p.sessionId)
    && Number.isSafeInteger(p.sequence) && p.sequence >= 0 && time(p.sensorTime)
    && ['device-monotonic', 'host-receipt'].includes(p.captureClock) && [2, 4, 8, 16].includes(p.fullScaleG)
    && (p.frameTimestamp === undefined || (typeof p.frameTimestamp === 'string' && /^\d{1,20}$/.test(p.frameTimestamp)))
    && (p.captureClock !== 'host-receipt' || p.frameTimestamp !== undefined)
    && p.fresh === true && p.quality === 'measured' && typeof p.saturated === 'boolean'
    && Array.isArray(p.accelerationG) && p.accelerationG.length === 3
    && p.accelerationG.every(axis => typeof axis === 'number' && Number.isFinite(axis)
      && Math.abs(axis) <= p.fullScaleG * 1.1 + .05);
}
export function validWiliPong(value: unknown): value is WiliClockPong {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as WiliClockPong;
  return p.type === 'clock.pong' && wiliId(p.id) && wiliId(p.sessionId)
    && time(p.deviceReceivedMs) && time(p.deviceSentMs) && p.deviceSentMs >= p.deviceReceivedMs;
}
const clone = (sample: BodyWiliSample): BodyWiliSample => ({ ...sample, accelerationG: [...sample.accelerationG] });

/** Bounded acquisition/clock adapter only. It does not detect falls or make safety decisions. */
export class FreeWili {
  private now: () => number;
  private online = false;
  private session: string | null = null;
  private retired = new Set<string>();
  private sequence = -1;
  private sensorTime = -1;
  private fullScale: number | null = null;
  private captureClock: BodyWiliSample['captureClock'] | null = null;
  private lastReceived: number | null = null;
  private latest: BodyWiliObservation | null = null;
  private points: BodyWiliObservation[] = [];
  private pending = new Map<string, number>();
  private offset: number | null = null;
  private uncertainty: number | null = null;
  private synchronizedAt: number | null = null;
  private rejected = 0;

  constructor(now = () => performance.now()) { this.now = now; }
  connected(): void { this.online = true; }
  /** Operator run boundary: clear old motion evidence without losing the live clock/session. */
  clearObservations(): void { this.points = []; }
  /** Recording boundary: discard earlier evidence, keeping the physical boot and replay guards. */
  resetForTrial(): void {
    this.lastReceived = null; this.latest = null; this.points = []; this.clearClock();
  }
  disconnected(): void {
    this.online = false;
    if (this.session) {
      this.retired.add(this.session);
      while (this.retired.size > 16) this.retired.delete(this.retired.values().next().value!);
    }
    this.session = null; this.sequence = -1; this.sensorTime = -1; this.fullScale = null;
    this.captureClock = null; this.lastReceived = null; this.latest = null; this.points = [];
    this.clearClock();
  }
  private clearClock(): void {
    this.offset = null; this.uncertainty = null; this.synchronizedAt = null; this.pending.clear();
  }
  private aligned(at: number): boolean {
    return this.offset !== null && this.uncertainty !== null && this.uncertainty <= 100
      && this.synchronizedAt !== null && at >= this.synchronizedAt && at - this.synchronizedAt < 15_000;
  }
  ping(id: string = randomUUID()): WiliClockPing {
    if (!wiliId(id)) throw new Error('Invalid WILi clock ID.');
    const at = this.now();
    if (!time(at)) throw new Error('Invalid host monotonic clock.');
    for (const [key, sent] of this.pending) if (at - sent > 10_000) this.pending.delete(key);
    if (this.pending.has(id)) throw new Error('WILi clock ID is already pending.');
    while (this.pending.size >= 8) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, at);
    return { type: 'clock.ping', id, serverSentMs: at };
  }
  pong(value: unknown, hostReceivedMs = this.now()): boolean {
    if (!this.online || !validWiliPong(value) || !time(hostReceivedMs) || value.sessionId !== this.session) return false;
    const sent = this.pending.get(value.id);
    if (sent === undefined || hostReceivedMs < sent || hostReceivedMs - sent > 10_000) return false;
    this.pending.delete(value.id);
    const latency = (hostReceivedMs - sent) - (value.deviceSentMs - value.deviceReceivedMs);
    if (latency < -1 || latency > 1000) return false;
    const uncertainty = Math.max(0, latency / 2);
    if (this.uncertainty === null || uncertainty <= this.uncertainty
      || this.synchronizedAt === null || hostReceivedMs - this.synchronizedAt >= 10_000) {
      this.offset = ((sent - value.deviceReceivedMs) + (hostReceivedMs - value.deviceSentMs)) / 2;
      this.uncertainty = uncertainty; this.synchronizedAt = hostReceivedMs;
    }
    return true;
  }
  sample(value: unknown, hostReceivedMs = this.now()): boolean {
    const reject = () => { this.rejected++; return false; };
    if (!this.online || !validBodyWiliSample(value) || !time(hostReceivedMs)
      || (this.lastReceived !== null && hostReceivedMs < this.lastReceived)) return reject();
    if (this.session === null) {
      if (this.retired.has(value.sessionId)) return reject();
      this.session = value.sessionId;
    }
    if (value.sessionId !== this.session || value.sequence <= this.sequence || value.sensorTime <= this.sensorTime
      || (this.fullScale !== null && value.fullScaleG !== this.fullScale)
      || (this.captureClock !== null && value.captureClock !== this.captureClock)) return reject();
    if (this.lastReceived !== null && hostReceivedMs - this.lastReceived >= 500) {
      // A sparse stock event stream does not reset the Mac gateway's clock.
      // It still goes stale in view(); no primary quiet/continuity is inferred.
      if (value.captureClock !== 'host-receipt') { this.points = []; this.clearClock(); }
      else if (hostReceivedMs - this.lastReceived >= 5000) this.points = [];
    }
    this.sequence = value.sequence; this.sensorTime = value.sensorTime; this.fullScale = value.fullScaleG;
    this.captureClock = value.captureClock;
    this.lastReceived = hostReceivedMs;
    const sample = clone(value);
    const alignedAtMs = this.aligned(hostReceivedMs) ? sample.sensorTime * 1000 + this.offset! : null;
    const captureAge = alignedAtMs === null ? null : hostReceivedMs - alignedAtMs;
    const captureFresh = captureAge !== null && captureAge >= -100 && captureAge < 500;
    // Device clipping flags are retained; near full-scale axes are conservatively marked as saturated too.
    const saturated = sample.saturated || sample.accelerationG.some(axis => Math.abs(axis) >= sample.fullScaleG * .98);
    const observation: BodyWiliObservation = { sample, hostReceivedMs, alignedAtMs, captureFresh, saturated,
      totalG: Math.hypot(...sample.accelerationG), usable: captureFresh && !saturated
        && (sample.fullScaleG > 2 || sample.captureClock === 'host-receipt') };
    this.latest = observation; this.points.push(observation);
    this.points = this.points.filter(point => hostReceivedMs - point.hostReceivedMs < 15_000).slice(-1600);
    return true;
  }
  observations(): BodyWiliObservation[] {
    return this.points.map(point => ({ ...point, sample: clone(point.sample) }));
  }
  view(at = this.now()): BodyWiliView {
    const latest = this.latest;
    const receivedAgeMs = this.lastReceived === null ? null : Math.max(0, at - this.lastReceived);
    const mapped = latest && this.aligned(at) ? latest.sample.sensorTime * 1000 + this.offset! : null;
    const captureAgeMs = mapped === null ? null : at - mapped;
    const receiptFresh = receivedAgeMs !== null && receivedAgeMs < 500;
    const fresh = this.online && receiptFresh && captureAgeMs !== null && captureAgeMs >= -100 && captureAgeMs < 500;
    const usable = fresh && Boolean(latest?.usable);
    const recent = this.points.filter(point => at - point.hostReceivedMs < 2000);
    const first = recent.at(0), end = recent.at(-1);
    const quality: BodyWiliQuality = !this.online ? 'disconnected' : !latest ? 'awaiting-sample'
      : !receiptFresh ? 'stale' : !this.aligned(at) ? 'unsynchronized' : !fresh ? 'capture-stale'
        : latest.saturated ? 'saturated' : latest.sample.fullScaleG <= 2 && latest.sample.captureClock !== 'host-receipt' ? 'insufficient-range' : 'measured';
    return { source: 'body-wili', sensorLocation: 'body', connected: this.online, fresh, usable,
      sessionId: this.session, captureClock: this.captureClock ?? 'device-monotonic', quality, receivedAgeMs, captureAgeMs,
      ageMs: receivedAgeMs === null ? null : Math.max(receivedAgeMs, captureAgeMs ?? 0),
      alignmentUncertaintyMs: this.aligned(at) ? this.uncertainty : null,
      sampleHz: first && end && end.hostReceivedMs > first.hostReceivedMs
        ? Math.round((recent.length - 1) * 1000 / (end.hostReceivedMs - first.hostReceivedMs)) : 0,
      accelerationG: fresh && latest ? [...latest.sample.accelerationG] : null,
      totalG: fresh ? latest?.totalG ?? null : null, fullScaleG: latest?.sample.fullScaleG ?? null,
      saturated: latest?.saturated ?? null, rejectedSamples: this.rejected };
  }
}
