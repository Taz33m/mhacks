import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventWindowCapture } from './event-window.ts';
import type { EventWindow } from './event-window.ts';
import type { FreeWili } from './freewili.ts';
import type { Motion } from './motion.ts';
import { PolicyError } from './controller.ts';

export const TEACH_LABELS = ['controlled-descent', 'fall-like-movement', 'shaking', 'walking', 'sitting', 'bending', 'device-adjustment', 'standing'] as const;
type Label = typeof TEACH_LABELS[number];
type Example = { id: string; recordedAt: number; label: Label | null; window: EventWindow };
export class Teaching {
  private pending: { id: string; recordedAt: number; endsAtMs: number; capture: EventWindowCapture } | null = null;
  private examples: Example[] = [];
  private practicing = false;
  private error: string | null = null;
  constructor(privateDirectory: string) {
    this.directory = resolve(privateDirectory); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(f => /^[\w-]+\.json$/.test(f))) {
      try {
        const example = JSON.parse(readFileSync(resolve(this.directory, file), 'utf8')) as Example;
        if (example.id && file === `${example.id}.json` && example.window?.version === 1
          && example.window.quality && Number.isFinite(example.recordedAt)
          && (example.label === null || TEACH_LABELS.includes(example.label))) this.examples.push(example);
      } catch { /* A damaged local example must never prevent incident monitoring from starting. */ }
    }
    this.examples.sort((a, b) => a.recordedAt - b.recordedAt);
  }
  private readonly directory: string;
  get recording(): boolean { return this.pending !== null; }
  get practiceMode(): boolean { return this.practicing; }
  view(now = performance.now()) {
    return { error: this.error, practiceMode: this.practicing, recording: this.recording, remainingMs: this.pending ? Math.max(0, this.pending.endsAtMs - now) : 0,
      labels: TEACH_LABELS, examples: this.examples.slice(-100).reverse().map(e => ({ id: e.id, label: e.label,
        recordedAt: e.recordedAt, bodySamples: e.window.quality.bodySamples, waistSamples: e.window.quality.waistSamples,
        quality: e.window.quality, interpretation: e.window.classification })) };
  }
  start(wili: FreeWili, motion: Motion, now = performance.now()): void {
    if (this.pending) throw new PolicyError('A movement is already recording.');
    const body = wili.view(now), waist = motion.views(now).find(v => v.source === 'waist-airpod');
    if (!body.connected || !body.sessionId || body.receivedAgeMs === null || body.receivedAgeMs >= 3000
      || !waist?.connected || !waist.fresh || !waist.calibrated || !waist.sessionId)
      throw new PolicyError('Connect both sensors and calibrate the waist before recording.');
    const evidence = { kind: 'cross-body' as const, summary: 'Human-labelled movement recording',
      sourceSessions: { 'body-wili': body.sessionId, 'waist-airpod': waist.sessionId } };
    this.error = null; this.practicing = true;
    this.pending = { id: randomUUID(), recordedAt: Date.now(), endsAtMs: now + 6000,
      capture: new EventWindowCapture(evidence, now + 2000) };
    this.pending.capture.collect(wili, motion, now);
  }
  tick(wili: FreeWili, motion: Motion, now = performance.now()): void {
    if (!this.pending) return;
    const window = this.pending.capture.collect(wili, motion, now);
    if (!window) return;
    const example: Example = { id: this.pending.id, recordedAt: this.pending.recordedAt, label: null, window };
    try { this.save(example); this.examples.push(example); }
    catch { this.error = 'Movement could not be saved. Check local storage, then record again or resume monitoring.'; }
    finally { this.pending = null; }
  }
  label(id: unknown, label: unknown): void {
    const example = this.examples.find(e => e.id === id);
    if (!example || !TEACH_LABELS.includes(label as Label)) throw new PolicyError('Select a saved movement and a valid label.');
    const updated = { ...example, label: label as Label };
    try { this.save(updated); } catch { throw new PolicyError('Label could not be saved. Check local storage and try again.'); }
    example.label = updated.label; this.error = null;
  }
  cancel(): void { this.pending = null; this.practicing = false; }
  private save(example: Example): void {
    const target = resolve(this.directory, `${example.id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(example), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, target);
    } finally { try { unlinkSync(temporary); } catch { /* Renamed or not created. */ } }
  }
}
