import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Source, TrialRecord, TrialScenario, TrialView } from './contracts.ts';
import { PolicyError } from './controller.ts';

const scenarios: TrialScenario[] = ['standing', 'phone-drop', 'sit', 'bend', 'staged-fall', 'other'];
export class Trials {
  private current: TrialView | null = null;
  private writer: WriteStream | null = null;
  private bytes = 0;
  private startedMs = 0;
  private readonly directory: string;
  private now: () => number;
  private wall: () => number;
  constructor(directory: string, now = () => performance.now(), wall = Date.now) {
    this.now = now; this.wall = wall;
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true });
  }
  view(): TrialView | null { return this.current ? structuredClone(this.current) : null; }
  get recording(): boolean { return this.current?.status === 'recording'; }
  start(label: unknown, scenario: unknown, initialSources: Source[]): TrialView {
    if (this.current && ['recording', 'stopping'].includes(this.current.status)) throw new PolicyError('A trial is already recording or finishing.');
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\u0000-\u001f]/.test(label) || !scenarios.includes(scenario as TrialScenario))
      throw new PolicyError('Use a trial label of 1–80 characters and a supported scenario.');
    const trial: TrialView = { id: randomUUID(), label: label.trim(), scenario: scenario as TrialScenario,
      status: 'recording', startedAt: this.wall(), endedAt: null,
      sampleCounts: { 'chest-phone': 0, 'waist-airpod': 0 }, reason: null };
    this.current = trial; this.bytes = 0; this.startedMs = this.now();
    const writer = createWriteStream(this.path(trial.id), { flags: 'wx', mode: 0o600 }); this.writer = writer;
    writer.on('error', () => {
      if (this.current === trial) { trial.status = 'error'; trial.reason = 'Storage failed; recording is incomplete.'; trial.endedAt = this.wall(); this.writer = null; }
    });
    this.record('trial.start', { version: 1, id: trial.id, label: trial.label, scenario: trial.scenario,
      initialSources, capture: 'native-stream' });
    return this.view()!;
  }
  record(type: TrialRecord['type'], payload?: unknown, source?: Source, atMs = this.now()): void {
    if (!this.recording || !this.writer) return;
    if (atMs - this.startedMs >= 600_000) { this.stop('Ten-minute recording limit reached.'); return; }
    const line = JSON.stringify({ type, atMs, at: this.wall(), ...(source ? { source } : {}), ...(payload === undefined ? {} : { payload }) } satisfies TrialRecord) + '\n';
    if (this.bytes + Buffer.byteLength(line) > 100_000_000) { this.stop('Recording size limit reached.'); return; }
    this.bytes += Buffer.byteLength(line);
    const ready = this.writer.write(line);
    if (type === 'motion.sample' && source) this.current!.sampleCounts[source]++;
    if (!ready) this.stop('Storage could not keep up; recording stopped before losing stream events.');
  }
  stop(reason = 'Stopped by operator.'): TrialView {
    const trial = this.current;
    if (!trial) throw new PolicyError('No trial has been started.');
    if (trial.status !== 'recording' || !this.writer) return this.view()!;
    const writer = this.writer;
    writer.write(JSON.stringify({ type: 'trial.stop', atMs: this.now(), at: this.wall(), payload: { reason } } satisfies TrialRecord) + '\n');
    trial.status = 'stopping'; trial.reason = reason; trial.endedAt = this.wall();
    writer.end(() => { if (trial.status === 'stopping') trial.status = 'stopped'; if (this.writer === writer) this.writer = null; });
    return this.view()!;
  }
  private path(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new PolicyError('Invalid trial ID.');
    return resolve(this.directory, `trial-${id}.jsonl`);
  }
  download(id: string) {
    if (this.current?.id === id && this.current.status !== 'stopped') throw new PolicyError('Stop the recording and wait for it to finish before downloading.');
    const path = this.path(id);
    if (!existsSync(path)) throw new PolicyError('Trial recording was not found.');
    return createReadStream(path);
  }
}
