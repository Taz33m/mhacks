import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP state and phone check-in expose the selected policy and actual incident deadline', { timeout: 10_000 }, async () => {
  for (const demoMode of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-policy-'));
    const child = spawn(process.execPath, ['--import', './src/test-helpers/offline.ts', './src/server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
        LIFELINE_DEMO_MODE: demoMode ? '1' : '0', LIFELINE_CHECKIN_MS: '45000',
        LIFELINE_ACCEPT_MS: '60000', LIFELINE_PROGRESS_MS: '120000',
        SPECTRUM_PROJECT_ID: '', SPECTRUM_PROJECT_SECRET: '', ELEVENLABS_API_KEY: '', LIFELINE_LLM_API_KEY: '',
        LIFELINE_WEARER_PHONE: '', LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Maya', phone: null }]) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = once(child, 'exit');
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Policy fixture server did not start')), 4000);
        child.stdout.on('data', chunk => {
          const match = String(chunk).match(/127\.0\.0\.1:(\d+)/);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', () => { clearTimeout(timer); reject(new Error('Policy fixture stopped before readiness')); });
      });
      const base = `http://127.0.0.1:${port}`;
      const setup = await (await fetch(`${base}/api/setup`)).json();
      const headers = { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' };
      const expected = { demoMode, checkinMs: demoMode ? 5000 : 45_000, configuredCheckinMs: 45_000 };
      const state = await (await fetch(`${base}/api/state`)).json();
      assert.deepEqual(state.policy, expected);
      assert.equal((await fetch(`${base}/api/commands`, { method: 'POST', headers,
        body: JSON.stringify({ type: 'trigger', kind: 'synthetic', summary: 'Offline profile fixture' }) })).status, 200);
      const phone = await (await fetch(`${base}/api/checkin`, { headers })).json();
      assert.deepEqual(phone.policy, expected);
      assert.equal(phone.incident.checkinDeadline - phone.incident.createdAt, expected.checkinMs);
      assert.equal(phone.incident.phase, 'CONFIRMING');
    } finally { child.kill('SIGTERM'); await exited; rmSync(dir, { recursive: true, force: true }); }
  }
});
