import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Location } from './location.ts';
import { Controller } from './controller.ts';
import type { Snapshot } from './contracts.ts';

// Existing offline helper disables all external provider traffic. The real
// sharing gateway needs native fetch only for its own loopback backend proxy.
const bootstrap = `const nativeFetch = globalThis.fetch;
await import('./src/test-helpers/offline.ts');
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
    return Promise.reject(new Error('External network disabled in location integration test.'));
  return nativeFetch(input, init);
};
await import('./src/server.ts');`;
const responders = [{ id: 'maya', name: 'Maya', phone: '+12025550101' }, { id: 'jordan', name: 'Jordan', phone: '+12025550102' }];
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-location-server-'));
  const child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap], { cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      LIFELINE_DATA_DIR: directory, LIFELINE_PORT: '0', LIFELINE_HOST: '127.0.0.1',
      LIFELINE_LOCATION_PUBLIC_URL: 'https://sharing.example', LIFELINE_LOCATION_GATEWAY_PORT: '0',
      LIFELINE_WELLBEING_ENABLED: '0', LIFELINE_LEGACY_PHONE: '0', LIFELINE_DEMO_MODE: '0',
      LIFELINE_CHECKIN_MS: '20000', LIFELINE_ACCEPT_MS: '60000', LIFELINE_PROGRESS_MS: '120000',
      LIFELINE_WEARER_PHONE: '+12025550100', LIFELINE_WEARER_NAME: 'Offline wearer', LIFELINE_RESPONDERS_JSON: JSON.stringify(responders),
      SPECTRUM_PROJECT_ID: '', SPECTRUM_PROJECT_SECRET: '', ELEVENLABS_API_KEY: '',
      LIFELINE_LLM_API_KEY: '', LIFELINE_LLM_BASE_URL: '', LIFELINE_LLM_MODEL: '',
    } });
  const exited = once(child, 'exit');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited;
    rmSync(directory, { recursive: true, force: true }); };
  try {
    const ports = await new Promise<{ backend: number; gateway: number }>((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(new Error('Isolated location server or gateway did not start.')), 5000);
      child.stdout.on('data', bytes => {
        output += String(bytes);
        const backend = output.match(/LIFELINE running at http:\/\/127\.0\.0\.1:(\d+)/);
        const gateway = output.match(/Location sharing gateway ready on 127\.0\.0\.1:(\d+)/);
        if (backend && gateway) { clearTimeout(timeout); resolve({ backend: Number(backend[1]), gateway: Number(gateway[1]) }); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Isolated location server exited before ready.')); });
    });
    assert.notEqual(ports.backend, 0); assert.notEqual(ports.gateway, 0); assert.notEqual(ports.backend, ports.gateway);
    const base = `http://127.0.0.1:${ports.backend}`, gateway = `http://127.0.0.1:${ports.gateway}`;
    const setup = await (await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(2000) })).json() as { token: string };
    const request = (origin: string, path: string, method = 'GET', bearer?: string, body?: unknown) => fetch(origin + path, {
      method, signal: AbortSignal.timeout(2500), headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { directory, base, gateway, operator: setup.token, request, stop,
      state: async () => (await request(base, '/api/state')).json() as Promise<Snapshot>,
      command: (body: unknown) => request(base, '/api/commands', 'POST', setup.token, body) };
  } catch (error) { await stop(); throw error; }
}

test('actual location HTTP/gateway routes require scoped bearer, validate points, hide private state and revoke sharing', { timeout: 15_000 }, async () => {
  const f = await fixture();
  const locations = new Location(join(f.directory, 'lifeline.sqlite'), { wearerName: 'Offline wearer' });
  try {
    const initial = await f.state(); assert.equal(initial.location!.configured, true); assert.equal(initial.location!.wearer, null);
    assert.equal((await f.request(f.base, '/api/location/invite', 'POST', undefined, {})).status, 401);
    const invitation = await f.request(f.base, '/api/location/invite', 'POST', f.operator, {});
    assert.equal(invitation.status, 200); const queued = await invitation.json(); assert.equal(queued.queued, true);
    assert.equal(queued.location.invite.status, 'queued', 'empty credentials cannot fake a submitted invitation');
    assert.equal((await f.request(f.base, '/api/location/invite', 'POST', f.operator, {})).status, 200);
    const bearer = locations.issue({ key: 'offline-wearer-http', role: 'wearer', name: 'Offline wearer' });
    for (const denied of [undefined, f.operator, 'f'.repeat(64)]) {
      assert.equal((await f.request(f.base, '/api/location/share', 'GET', denied)).status, 401);
      assert.equal((await f.request(f.gateway, '/api/location/share', 'GET', denied)).status, 401);
    }
    for (const path of ['/health', '/api/setup', '/api/state', '/api/patient-record', '/api/commands', '/api/location/invite', '/live', '/dashboard'])
      assert.equal((await f.request(f.gateway, path, 'GET', f.operator)).status, 404);
    assert.equal((await f.request(f.gateway, `/api/location/share?grant=${bearer}`, 'GET', bearer)).status, 404);
    const grant = await f.request(f.gateway, '/api/location/share', 'GET', bearer);
    assert.equal(grant.status, 200, 'ephemeral gateway must forward to the actual assigned backend port');
    assert.equal(grant.headers.get('cache-control'), 'no-store'); assert.equal(grant.headers.get('referrer-policy'), 'no-referrer');
    assert.match(grant.headers.get('permissions-policy')!, /geolocation=\(self\)/);
    const sample = { latitude: 42.2808, longitude: -83.7430, accuracy: 8, timestamp: Date.now(), sequence: 0, mode: 'walking' };
    for (const malformed of [{ ...sample, role: 'administrator' }, { ...sample, timestamp: Date.now() + 60_000 },
      { ...sample, accuracy: 1001 }, { ...sample, latitude: '42.2808' }, { ...sample, timestamp: Date.now() - 180_000 }])
      assert.equal((await f.request(f.gateway, '/api/location/share', 'POST', bearer, malformed)).status, 400);
    const update = await f.request(f.gateway, '/api/location/share', 'POST', bearer, sample);
    assert.equal(update.status, 200); assert.equal((await update.json()).location.wearer.latitude, sample.latitude);
    assert.equal((await f.request(f.gateway, '/api/location/share', 'POST', bearer, sample)).status, 400, 'replay sequence is rejected');
    const publicResponse = await (await f.request(f.gateway, '/api/location/share', 'GET', bearer)).json();
    assert.deepEqual(Object.keys(publicResponse).sort(), ['incidentId', 'location', 'name', 'role']);
    assert.equal(publicResponse.role, 'wearer'); assert.equal(publicResponse.location.wearer.source, 'browser-geolocation');
    assert.equal(publicResponse.location.wearer.fresh, true); assert.equal(publicResponse.location.eta, null);
    const publicText = JSON.stringify(publicResponse);
    for (const secret of [bearer, f.operator, 'patientRecord', 'recordIds', 'clinical_context', 'providerMessageId']) assert.ok(!publicText.includes(secret));
    assert.equal((await f.request(f.gateway, '/api/location/share', 'DELETE', bearer)).status, 200);
    assert.equal((await f.state()).location!.wearer, null); assert.equal((await f.state()).incident, null);
    assert.equal((await f.request(f.gateway, '/api/location/share', 'GET', bearer)).status, 401);
    assert.equal((await f.request(f.gateway, '/api/location/share', 'POST', bearer, { ...sample, sequence: 1 })).status, 401);
  } finally { locations.close(); await f.stop(); }
});

test('actual responder sharing requires contacted active incident and accepted ownership for public approach visibility', { timeout: 15_000 }, async () => {
  const f = await fixture(), locations = new Location(join(f.directory, 'lifeline.sqlite'), { wearerName: 'Offline wearer' });
  try {
    assert.equal((await f.command({ type: 'trigger', kind: 'manual', summary: 'Generated location authorization test; no physical fall.' })).status, 200);
    const active = (await f.state()).incident!; assert.equal(active.phase, 'HELP_REQUESTED');
    assert.equal((await f.request(f.base, '/api/location/invite', 'POST', f.operator, {})).status, 409);
    const responder = locations.issue({ key: 'contacted-maya', role: 'responder', incidentId: active.id, responderId: 'maya', name: 'Maya' });
    const outsider = locations.issue({ key: 'not-contacted', role: 'responder', incidentId: active.id, responderId: 'stranger', name: 'Stranger' });
    const stale = locations.issue({ key: 'old-incident', role: 'responder', incidentId: 'LF-STALE', responderId: 'maya', name: 'Maya' });
    for (const bearer of [outsider, stale]) assert.equal((await f.request(f.base, '/api/location/share', 'GET', bearer)).status, 401);
    assert.equal((await f.request(f.gateway, '/api/location/share', 'GET', responder)).status, 200);
    const sample = { latitude: 42.28, longitude: -83.744, accuracy: 10, timestamp: Date.now(), sequence: 0 };
    assert.equal((await f.request(f.gateway, '/api/location/share', 'POST', responder, sample)).status, 200);
    assert.equal((await f.state()).location!.responder, null, 'sharing before acceptance does not appoint the responder');
    assert.equal((await f.state()).incident!.ownerId, null);
    assert.equal((await f.command({ type: 'accept', incidentId: active.id, responderId: 'maya' })).status, 200);
    const owned = await f.state(); assert.equal(owned.location!.responder!.name, 'Maya'); assert.equal(owned.location!.wearer, null);
    assert.equal(owned.location!.eta, null, 'without wearer location the route helper must not run');
    assert.equal(owned.incident!.phase, 'ACKNOWLEDGED', 'coordinates cannot claim departure or arrival');
    const jordan = locations.issue({ key: 'other-owner', role: 'responder', incidentId: active.id, responderId: 'jordan', name: 'Jordan' });
    assert.equal((await f.request(f.base, '/api/location/share', 'GET', jordan)).status, 401);
    assert.equal((await f.command({ type: 'depart', incidentId: active.id, responderId: 'maya' })).status, 200);
    assert.equal((await f.command({ type: 'arrive', incidentId: active.id, responderId: 'maya' })).status, 200);
    assert.equal((await f.command({ type: 'resolve', incidentId: active.id, responderId: 'maya', outcome: 'Generated test responder recorded a concrete outcome.' })).status, 200);
    assert.equal((await f.request(f.gateway, '/api/location/share', 'GET', responder)).status, 401);
    assert.equal((await f.state()).location!.responder, null);
    assert.equal((await f.state()).actions.some(action => action.status === 'provider_accepted'), false);
  } finally { locations.close(); await f.stop(); }
});

test('real controller persists the exact decorated send body and permits approach updates only for current en-route ownership', () => {
  let at = 1000; const c = new Controller(':memory:', [{ id: 'maya', name: 'Maya', phone: null }], () => at);
  try {
    const incident = c.trigger({ kind: 'synthetic', summary: 'Generated message preparation test.' });
    const checkin = c.claimAction('wearer')!; assert.equal(checkin.type, 'wearer_checkin');
    const exact = `${checkin.text}\n\nOptional location sharing: https://sharing.example/share-location#grant=offline-test-link`;
    assert.equal(c.decorateAction(checkin.id, exact).text, exact);
    c.finishAction(checkin.id, 'unknown', 'Recorded test uncertainty; no provider submission.');
    assert.equal(c.actions(incident.id).find(action => action.id === checkin.id)!.text, exact);
    assert.throws(() => c.decorateAction(checkin.id, 'An altered uncertainty body.'), /Only the current/);
    c.trigger({ kind: 'manual', summary: 'Generated explicit help test.' });
    assert.equal(c.queueApproachUpdate(incident.id, c.active()!.version, 'Unowned ETA must not queue.'), false);
    c.accept(incident.id, 'maya'); assert.equal(c.queueApproachUpdate(incident.id, c.active()!.version, 'Acceptance is not departure.'), false);
    const beforeDepart = c.active()!.version; c.progress(incident.id, 'maya', 'depart');
    assert.equal(c.queueApproachUpdate(incident.id, beforeDepart, 'Stale generation.'), false);
    const currentVersion = c.active()!.version, text = `${incident.id}: Maya estimates a two-minute walk; arrival is not confirmed.`;
    assert.equal(c.queueApproachUpdate(incident.id, currentVersion, text), true);
    assert.equal(c.queueApproachUpdate(incident.id, currentVersion, text), false, 'same-minute approach messages dedupe');
    const action = c.actions(incident.id).find(action => action.type === 'wearer_location')!;
    assert.equal(action.text, text); assert.equal(c.actionPermitted(action), true);
    at += 60_001; assert.equal(c.queueApproachUpdate(incident.id, currentVersion, text), true);
    c.progress(incident.id, 'maya', 'arrive'); assert.equal(c.actionPermitted(action), false);
    assert.equal(c.queueApproachUpdate(incident.id, c.active()!.version, text), false);
  } finally { c.close(); }
});
