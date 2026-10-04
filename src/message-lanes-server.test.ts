import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from './contracts.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
for (const scenario of ['slow-wearer', 'slow-answer'] as const) test(scenario === 'slow-wearer'
  ? 'a slow wearer submission does not delay deadline escalation or responder submission'
  : 'a slow clinical answer is persisted without delaying incoming responder acceptance', { timeout: 12_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-message-lanes-'));
  const log = join(dir, 'transport.jsonl');
  const child = spawn(process.execPath, ['--import', './src/test-helpers/message-lanes-offline.ts', './src/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_DISPATCH_MODE: 'live', LIFELINE_DEMO_MODE: '0', LIFELINE_CHECKIN_MS: '1000', LIFELINE_MESSAGE_GAP_MS: '0',
      LIFELINE_TEST_TRANSPORT_LOG: log, LIFELINE_LEGACY_PHONE: '0', LIFELINE_FIND_MY_ENABLED: '0', LIFELINE_WELLBEING_ENABLED: '0',
      LIFELINE_TEST_INBOUND_QUESTION: scenario === 'slow-answer' ? '1' : '0',
      SPECTRUM_PROJECT_ID: 'offline-fixture', SPECTRUM_PROJECT_SECRET: 'offline-fixture', ELEVENLABS_API_KEY: '',
      LIFELINE_LLM_API_KEY: scenario === 'slow-answer' ? 'offline' : '',
      LIFELINE_LLM_BASE_URL: scenario === 'slow-answer' ? 'https://model.example/v1' : '',
      LIFELINE_LLM_MODEL: scenario === 'slow-answer' ? 'offline' : '', LIFELINE_LOCATION_PUBLIC_URL: '',
      LIFELINE_WEARER_PHONE: '+12025550100',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Maya', phone: '+12025550101' }]),
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Isolated message-lane server did not start: ' + stderr)), 5000);
      child.stdout.on('data', bytes => {
        output += bytes.toString(); const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated server exited: ' + stderr)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const { token } = await (await fetch(`${base}/api/setup`)).json();
    const triggered = await fetch(`${base}/api/commands`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'trigger', kind: 'synthetic', summary: 'Isolated transport-delay fixture.' }) });
    assert.equal(triggered.status, 200);
    let state!: Snapshot;
    const end = Date.now() + 3000;
    do {
      state = await (await fetch(`${base}/api/state`)).json();
      if (scenario === 'slow-answer' ? state.incident?.phase === 'ACKNOWLEDGED'
        : state.actions.some(a => a.type === 'alert' && a.status === 'provider_accepted')) break;
      await pause(30);
    } while (Date.now() < end);
    assert.equal(state.incident?.phase, scenario === 'slow-answer' ? 'ACKNOWLEDGED' : 'HELP_REQUESTED');
    assert.equal(state.actions.some(a => a.type === 'alert' && a.status === 'provider_accepted'), true);
    const events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.some(e => e.phone === '+12025550100' && e.event === 'submission-start'), true);
    assert.equal(events.some(e => e.phone === '+12025550101' && e.event === 'submission-finish'), true);
    if (scenario === 'slow-wearer') {
      assert.equal(state.actions.find(a => a.type === 'wearer_checkin')?.status, 'attempting');
      assert.equal(events.some(e => e.phone === '+12025550100' && e.event === 'submission-finish'), false,
        'Responder submission completed while the wearer network request was still pending.');
    } else {
      assert.equal(state.incident?.ownerId, 'maya');
      assert.equal(state.timeline.some(e => e.type === 'QUESTION_RECEIVED'), true,
        'Original question is durable before model generation finishes.');
      assert.equal(events.some(e => e.event === 'generation-start'), true);
      assert.equal(events.some(e => e.event === 'generation-finish'), false,
        'Acceptance was processed while model generation was still pending.');
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, pause(1500)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
