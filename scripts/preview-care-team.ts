import { createPhotonAdapter, createCloudPhoton, type PhotonClient } from '../src/providers/photon.ts';
import type { Action, Snapshot } from '../src/contracts.ts';
import { pathToFileURL } from 'node:url';

/** Read-only copies; never alters recipient identity, ownership or original delivery evidence. */
export function careTeamPreviews(actions: Action[], startedAt: number, seen: Set<string>): Action[] {
  return actions.filter(a => a.createdAt >= startedAt && a.recipientId !== null
    && ['alert', 'handoff', 'answer', 'wearer_relay', 'status'].includes(a.type)
    && ['provider_accepted', 'simulated', 'failed', 'unknown'].includes(a.status) && !seen.has(a.id));
}
async function main() {
  const phone = process.env.LIFELINE_WEARER_PHONE;
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Approved wearer phone required.');
  const base = 'http://127.0.0.1:8877';
  const initial: Snapshot = await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5000) })).json();
  const seen = new Set(initial.actions.map(a => a.id));
  const startedAt = Date.now(), endsAt = startedAt + 30 * 60_000;
  let client: PhotonClient | undefined, stopping = false;
  process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
  const adapter = createPhotonAdapter({ projectId: process.env.SPECTRUM_PROJECT_ID,
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET, timeoutMs: 15000,
    factory: async (...args) => (client = await createCloudPhoton(...args)) });
  if (!adapter.status().configured) throw new Error('Spectrum credentials required.');
  console.log('Care-team preview armed for the next incident. Copies go only to the approved wearer phone; expires in 30 minutes.');
  try {
    while (!stopping && Date.now() < endsAt) {
      try {
        const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Backend unavailable');
        const state: Snapshot = await response.json();
        for (const action of careTeamPreviews(state.actions, startedAt, seen)) {
          seen.add(action.id); // Unknown cloud outcomes must never cause duplicate submission.
          const name = state.responders.find(r => r.id === action.recipientId)?.name || 'Care team';
          const result = await adapter.sendMessage(phone, `Care-team preview · ${name}\n\n${action.text}`,
            () => !stopping);
          console.log(`Care-team copy: ${result.status}`);
          if (result.status !== 'provider_accepted') console.log(result.detail);
        }
      } catch { console.log('Preview temporarily unavailable; original incident flow is unchanged.'); }
      await new Promise(r => setTimeout(r,1000));
    }
  } finally { await client?.stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Care-team preview could not start; check private configuration and local backend.'); process.exitCode=1; });
}
