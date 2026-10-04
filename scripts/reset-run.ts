import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recoverWili } from './recover-wili.ts';

// Uses the running backend; recovers an exited USB bridge only when needed.
// Never generates an incident or sends a new message to either phone.
const origin = process.env.LIFELINE_RESET_ORIGIN ?? 'http://127.0.0.1:8877';
const url = new URL(origin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
  throw new Error('Reset must target the local backend.');
try {
  const token = (await readFile(resolve('data/pairing-token'), 'utf8')).trim();
  const response = await fetch(new URL('/api/commands', url), { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'reset', readyImmediately: true }), signal: AbortSignal.timeout(5000) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Reset failed (${response.status}).`);
  const stateResponse = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(5000) });
  if (!stateResponse.ok) throw new Error('Reset accepted but readiness could not be checked.');
  let state = await stateResponse.json() as { incident: { phase: string } | null;
    wili?: { connected: boolean; receivedAgeMs?: number | null }; sensors: { source: string; calibrated: boolean; connected: boolean; fresh: boolean }[] };
  if (state.incident && !['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(state.incident.phase))
    throw new Error('An incident is still active.');
  console.log('Reset accepted. Returning WILi to silent idle.');
  if (!state.wili?.connected || state.wili.receivedAgeMs == null) {
    const recovered = await recoverWili(process.env.LIFELINE_WILI_DISPLAY_PORT);
    if (recovered !== 'unplugged') {
      console.log(recovered === 'started' ? 'USB found. Restarting the exited WILi bridge…' : 'Waiting for the WILi bridge…');
      const end = Date.now() + 45_000;
      while (Date.now() < end) {
        await new Promise(done => setTimeout(done, 1000));
        const response = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Could not check wearable recovery.');
        state = await response.json() as typeof state;
        if (state.wili?.connected && state.wili.receivedAgeMs != null && state.wili.receivedAgeMs < 3000) break;
      }
    }
  }
  const boardReady = state.wili?.connected && state.wili.receivedAgeMs != null && state.wili.receivedAgeMs < 3000;
  console.log(boardReady ? 'WILi connected and streaming.' : 'WILi not ready. Check USB and data/wili-bridge.log.');
  const waist = state.sensors.find(s => s.source === 'waist-airpod');
  console.log(waist?.connected && waist.fresh && waist.calibrated ? 'Waist calibration preserved.'
    : 'Waist calibration unavailable: use http://127.0.0.1:8877/calibration.');
  if (!boardReady || !waist?.connected || !waist.fresh || !waist.calibrated) process.exitCode = 1;
  else console.log('Ready for the next run.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Reset failed.'); process.exitCode = 1;
}
