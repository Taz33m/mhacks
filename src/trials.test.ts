import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Trials } from './trials.ts';

async function finished(trials: Trials): Promise<void> {
  for (let i = 0; i < 100 && trials.view()?.status === 'stopping'; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(trials.view()?.status, 'stopped');
}
test('trial preserves ordered clock/calibration events and accepted counts in a private file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-trial-')); let now = 100;
  const trials = new Trials(directory, () => now, () => 10000 + now);
  try {
    const started = trials.start('Synthetic recorder fixture', 'other', ['chest-phone']);
    assert.throws(() => trials.start('duplicate', 'standing', []), /already/);
    assert.throws(() => trials.download(started.id), /Stop/);
    now += 20; trials.record('clock.ping', { id: 'ping' }, 'chest-phone');
    now += 10; trials.record('clock.pong', { id: 'ping' }, 'chest-phone');
    now += 10; trials.record('motion.sample', { fixture: true }, 'chest-phone');
    now += 1100; trials.record('calibration', { sources: ['chest-phone'] });
    trials.stop(); await finished(trials);
    const view = trials.view()!; assert.equal(view.sampleCounts['chest-phone'], 1);
    assert.equal(view.sampleCounts['waist-airpod'], 0);
    const path = join(directory, `trial-${started.id}.jsonl`);
    const events = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.type), ['trial.start', 'clock.ping', 'clock.pong', 'motion.sample', 'calibration', 'trial.stop']);
    assert.deepEqual(events[4].payload, { sources: ['chest-phone'] });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const downloaded: Buffer[] = [];
    for await (const chunk of trials.download(started.id)) downloaded.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(downloaded).toString('utf8'), readFileSync(path, 'utf8'));
    assert.equal(trials.stop().status, 'stopped');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('trial input/path validation and recording duration limit preserve explicit stop reason', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-trial-')); let now = 0;
  const trials = new Trials(directory, () => now);
  try {
    assert.throws(() => trials.start('', 'standing', []), /label/);
    assert.throws(() => trials.start('multiple\nlines', 'standing', []), /label/);
    assert.throws(() => trials.start('test', 'unknown', []), /scenario/);
    assert.throws(() => trials.download('../pairing-token'), /Invalid/);
    assert.throws(() => trials.stop(), /No trial/);
    trials.start('Synthetic duration fixture', 'other', []);
    now = 600000; trials.record('assessment', { candidate: null });
    await finished(trials);
    assert.match(trials.view()!.reason!, /Ten-minute/);
    assert.equal(trials.recording, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
