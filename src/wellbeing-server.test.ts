import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Snapshot } from './contracts.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// An isolated actual server and generated WILi packets; no physical recording or cloud-send claim.
test('daily conversation records attributed voice without an incident, dedupes prompts, and yields to explicit help', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-wellbeing-server-'));
  const child = spawn(process.execPath, ['--import', './src/test-helpers/offline.ts', './src/server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      LIFELINE_DATA_DIR: dir, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_WEARER_PHONE: '+15555550101', LIFELINE_WEARER_NAME: 'Demo wearer',
      LIFELINE_WELLBEING_ENABLED: '1', LIFELINE_WELLBEING_HOUR: String((new Date().getUTCHours() + 1) % 24), LIFELINE_WELLBEING_TIMEZONE: 'UTC',
      SPECTRUM_PROJECT_ID: '', SPECTRUM_PROJECT_SECRET: '', ELEVENLABS_API_KEY: '',
      LIFELINE_LLM_API_KEY: '', LIFELINE_LLM_BASE_URL: '', LIFELINE_LLM_MODEL: '',
      LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'maya', name: 'Demo responder', phone: null }]),
    },
  });
  const exited = once(child, 'exit'); let ws: WebSocket | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''; const timer = setTimeout(() => reject(new Error('Wellbeing fixture failed to start.')), 5000);
      child.stdout.on('data', bytes => { out += bytes.toString(); const match = out.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Wellbeing fixture exited before startup.')); });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await (await fetch(`${base}/api/setup`)).json() as { token: string };
    const state = async () => await (await fetch(`${base}/api/state`)).json() as Snapshot;
    async function waitFor(matches: (s: Snapshot) => boolean) {
      const end = Date.now() + 4000;
      do { const s = await state(); if (matches(s)) return s; await pause(20); } while (Date.now() < end);
      throw new Error('Wellbeing fixture did not reach its expected state.');
    }
    const post = (authenticated = true) => fetch(`${base}/api/wellbeing/checkin`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${setup.token}` } : {}) }, body: '{}' });
    assert.equal((await post(false)).status, 401);
    const first = await post(); assert.equal(first.status, 200);
    assert.equal((await first.json() as { queued: boolean }).queued, true);
    const repeated = await post(); assert.equal((await repeated.json() as { queued: boolean }).queued, false);
    assert.equal((await state()).incident, null);

    const packets: { type: string; enabled?: boolean; conversationId?: string }[] = [];
    const sessionId = 'generated-wellbeing-board';
    ws = new WebSocket(`ws://127.0.0.1:${port}/motion?source=body-wili&token=${setup.token}`);
    ws.on('message', bytes => packets.push(JSON.parse(bytes.toString()))); ws.on('error', () => {});
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId,
      deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
      capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } }));
    await waitFor(() => packets.some(p => p.type === 'wellbeing.context' && p.enabled === true));
    const conversationId = packets.find(p => p.type === 'wellbeing.context' && p.enabled)!.conversationId!;
    const sendVoice = (eventId: string, transcript: string, target = conversationId) => ws!.send(JSON.stringify({
      type: 'wellbeing.reply', source: 'body-wili', sessionId, eventId, conversationId: target, transcript,
    }));
    sendVoice('stale-voice', 'This should be ignored.', 'unbound-wellbeing');
    await pause(50);
    assert.equal((await state()).wellbeing!.messages.some(m => m.text === 'This should be ignored.'), false);
    sendVoice('generated-lonely-voice', "I'm feeling lonely today.");
    const recorded = await waitFor(s => Boolean(s.wellbeing?.messages.some(m => m.speaker === 'wearer')));
    assert.equal(recorded.incident, null, 'loneliness does not open a medical incident');
    const message = recorded.wellbeing!.messages.find(m => m.speaker === 'wearer')!;
    assert.equal(message.text, "I'm feeling lonely today.");
    assert.equal(message.source, 'freewili-local-speech');
    await waitFor(s => Boolean(s.wellbeing?.messages.some(m => m.source === 'agent')));
    sendVoice('generated-explicit-help', 'I need help');
    const help = await waitFor(s => s.incident?.phase === 'HELP_REQUESTED');
    assert.equal(help.incident!.evidence.kind, 'manual');
    assert.match(help.incident!.evidence.summary, /explicitly requested help.*wellbeing/);
    await waitFor(() => packets.some(p => p.type === 'wellbeing.context' && p.enabled === false));
    assert.equal((await post()).status, 409);
  } finally {
    ws?.terminate(); if (child.exitCode === null) child.kill('SIGTERM'); await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
