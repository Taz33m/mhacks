import type { Evidence } from './contracts.ts';
import type { FreeWili } from './freewili.ts';
import type { Motion } from './motion.ts';
import { wiliPoint, waistPoint } from './wili-assessment.ts';

export interface EventWindow {
  version: 1; triggerAtMs: number; completedAtMs: number; beforeMs: 2000; afterMs: 4000;
  classification: 'possible-loss-of-balance' | 'fall-like-motion' | 'recovered-motion' | 'sustained-shaking' | 'insufficient-evidence';
  summary: string;
  quality: { bodySamples: number; waistSamples: number; bodyMaxGapMs: number; waistMaxGapMs: number;
    bodyClipped: boolean; continuousWaist: boolean; continuousBody: boolean; sameSessions: boolean };
  features: { peakAccelerationG: number | null; peakAngularSpeed: number | null; postureChangeDegrees: number | null;
    postQuietMs: number; waistReversals: number };
  body: { atMs: number; sequence: number; accelerationG: [number, number, number]; totalG: number; clipped: boolean }[];
  waist: { atMs: number; sequence: number; linearG: number; angularSpeed: number; tiltDegrees: number | null; rotationRate: [number, number, number] }[];
}
const maxGap = (times: number[], from: number, to: number) => times.length ? Math.max(times[0] - from,
  to - times.at(-1)!, ...times.slice(1).map((v, i) => v - times[i])) : to - from;

/** Captures original measured samples around the first trigger. No resampling or synthetic fill. */
export class EventWindowCapture {
  private trigger: number;
  private sessions: Evidence['sourceSessions'];
  private body = new Map<number, EventWindow['body'][number]>();
  private waist = new Map<number, EventWindow['waist'][number]>();
  private done = false;
  constructor(evidence: Evidence, now: number) {
    this.trigger = evidence.onset?.acceleration.alignedAtMs ?? evidence.assessment?.impact.alignedAtMs
      ?? evidence.shaking?.assessedAtMs ?? now;
    this.sessions = evidence.sourceSessions;
  }
  collect(wili: Pick<FreeWili, 'observations' | 'view'>, motion: Pick<Motion, 'observations' | 'views'>, now: number): EventWindow | null {
    if (this.done) return null;
    const from = this.trigger - 2000, to = this.trigger + 4000;
    const bodySession = this.sessions?.['body-wili'], waistSession = this.sessions?.['waist-airpod'];
    for (const p of wili.observations()) {
      if (!bodySession || !wiliPoint(p, bodySession) || p.alignedAtMs < from || p.alignedAtMs > Math.min(now, to)) continue;
      this.body.set(p.sample.sequence, { atMs: p.alignedAtMs, sequence: p.sample.sequence,
        accelerationG: [...p.sample.accelerationG], totalG: p.totalG, clipped: p.saturated || p.sample.saturated });
    }
    for (const p of motion.observations('waist-airpod')) {
      if (!waistSession || !waistPoint(p, waistSession) || p.alignedAtMs < from || p.alignedAtMs > Math.min(now, to)) continue;
      this.waist.set(p.sequence, { atMs: p.alignedAtMs, sequence: p.sequence, linearG: p.linearG,
        angularSpeed: p.angularSpeed, tiltDegrees: p.tiltDegrees, rotationRate: [...p.rotationRate] });
    }
    if (now < to) return null;
    this.done = true;
    const body = [...this.body.values()].sort((a,b) => a.atMs-b.atMs), waist = [...this.waist.values()].sort((a,b) => a.atMs-b.atMs);
    const sameSessions = Boolean(bodySession && waistSession && wili.view(now).sessionId === bodySession
      && motion.views(now).find(v => v.source === 'waist-airpod')?.sessionId === waistSession);
    const bodyMaxGapMs = maxGap(body.map(p=>p.atMs), from, to), waistMaxGapMs = maxGap(waist.map(p=>p.atMs), from, to);
    const continuousWaist = sameSessions && waist.length >= 25 && waistMaxGapMs <= 200;
    const continuousBody = sameSessions && body.length >= 25 && bodyMaxGapMs <= 200;
    const post = waist.filter(p=>p.atMs >= this.trigger + 1000), quiet = post.filter(p=>p.linearG <= .15 && p.angularSpeed <= .35);
    const postQuietMs = continuousWaist && post.length && quiet.length === post.length ? post.at(-1)!.atMs - post[0].atMs : 0;
    const beforeTilt = waist.filter(p=>p.atMs < this.trigger - 500 && p.tiltDegrees !== null).map(p=>p.tiltDegrees!);
    const afterTilt = post.filter(p=>p.tiltDegrees !== null).map(p=>p.tiltDegrees!);
    const mean = (v: number[]) => v.reduce((a,b)=>a+b,0)/v.length;
    const postureChangeDegrees = beforeTilt.length && afterTilt.length ? Math.abs(mean(afterTilt)-mean(beforeTilt)) : null;
    const peakAccelerationG = body.length ? Math.max(...body.map(p=>p.totalG)) : null;
    const peakAngularSpeed = waist.length ? Math.max(...waist.map(p=>p.angularSpeed)) : null;
    let waistReversals = 0;
    for (let axis=0;axis<3;axis++) {
      let sign=0, count=0;
      for (const p of waist) { const v=p.rotationRate[axis], next=v>.5?1:v<-.5?-1:0;
        if (next) { if(sign && next!==sign)count++; sign=next; } }
      waistReversals=Math.max(waistReversals,count);
    }
    let classification: EventWindow['classification'] = 'possible-loss-of-balance';
    if (!continuousWaist || !body.length || !sameSessions) classification='insufficient-evidence';
    else if (continuousBody && waistReversals>=16 && waist.filter(p=>p.angularSpeed>=1.2).length/waist.length>=.65
      && Math.max(...body.map(p=>p.totalG))-Math.min(...body.map(p=>p.totalG))>=.35) classification='sustained-shaking';
    else if (continuousBody && (peakAccelerationG ?? 0)>=1.65 && (postureChangeDegrees ?? 0)>=45 && postQuietMs>=2400) classification='fall-like-motion';
    else if (postQuietMs>=2400 && postureChangeDegrees!==null && postureChangeDegrees<20) classification='recovered-motion';
    const quality={bodySamples:body.length,waistSamples:waist.length,bodyMaxGapMs,waistMaxGapMs,
      bodyClipped:body.some(p=>p.clipped),continuousWaist,continuousBody,sameSessions};
    const summary=`Motion window: ${classification.replaceAll('-',' ')}. ${body.length} chest / ${waist.length} waist measurements across 2 s before and 4 s after onset.`
      + (!continuousBody ? ' Chest reporting is sparse; impact sequence and shaking cannot be established.' : '')
      + (!continuousWaist ? ' Waist coverage is incomplete.' : '')
      + (quality.bodyClipped ? ' Clipped acceleration is a lower bound.' : '')
      + ' Provisional motion interpretation; does not resolve the incident or diagnose injury/seizure.';
    return {version:1,triggerAtMs:this.trigger,completedAtMs:now,beforeMs:2000,afterMs:4000,classification,summary,quality,
      features:{peakAccelerationG,peakAngularSpeed,postureChangeDegrees,postQuietMs,waistReversals},body,waist};
  }
}
