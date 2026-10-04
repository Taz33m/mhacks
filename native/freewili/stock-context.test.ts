import test from 'node:test';
import assert from 'node:assert/strict';
import { stockContextToDeliver } from './stock-bridge.ts';
import type { WiliIncidentContext } from './protocol.ts';
import { validHostPacket } from './protocol.ts';

test('movement check-in passes the wire validator and reaches the stock worker', () => {
  const context: WiliIncidentContext = { type: 'incident.context', sessionId: 'fixture-session',
    incidentId: 'LF-fixture', checkinId: 'fixture-checkin', phase: 'CONFIRMING',
    checkinDeadline: 20000, serverTime: 1000, voiceAsset: 'MOVEMENT', dispatchMode: 'live',
    statusText: 'LIFELINE\nCHECKING ON YOU', ownerName: null };
  assert.equal(validHostPacket(JSON.parse(JSON.stringify(context))), true);
  assert.equal(stockContextToDeliver(context, true, 1000)?.voiceAsset, 'MOVEMENT');
  assert.equal(validHostPacket({ ...context, voiceAsset: 'UNKNOWN' }), false);
});

test('reconnection starts at silent idle for a closed incident; a fresh closing transition still speaks', () => {
  for (const phase of ['RESOLVED', 'CANCELLED_FALSE_ALARM'] as const) {
    const context = { type: 'incident.context', phase, voiceAsset: 'RESOLVED' } as WiliIncidentContext;
    assert.equal(stockContextToDeliver(context, true, Date.now(), true)?.voiceAsset, null);
    assert.equal(stockContextToDeliver(context, true, Date.now(), true)?.phase, null);
    assert.equal(stockContextToDeliver(context, true, Date.now(), true)?.incidentId, null);
    assert.equal(stockContextToDeliver(context, true)?.voiceAsset, 'RESOLVED');
    assert.equal(context.voiceAsset, 'RESOLVED', 'restoring cannot mutate live transition context');
  }
});

test('setup and expired check-ins cannot play; a current check-in still can', () => {
  const context = { type: 'incident.context', phase: 'CONFIRMING', incidentId: 'fixture', checkinId: 'checkin',
    checkinDeadline: 100, voiceAsset: 'CHECKIN' } as WiliIncidentContext;
  assert.equal(stockContextToDeliver(context, false, 50, true), null);
  assert.equal(stockContextToDeliver(context, true, 100, true), null);
  assert.equal(stockContextToDeliver(context, true, 50, true)?.voiceAsset, 'CHECKIN');
});

test('grey reset calls the existing fast-reset endpoint without a calibration request', async () => {
  const { resetFromGreyButton } = await import('./stock-bridge.ts');
  const requests: { url: string; body: unknown }[] = [];
  await resetFromGreyButton(new URL('http://127.0.0.1:8877'), 'fixture-private-token', (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:8877/api/commands', body: { type: 'reset', readyImmediately: true } }]);
  await assert.rejects(resetFromGreyButton(new URL('http://127.0.0.1:8877'), 'fixture',
    (async () => new Response('{}', { status: 401 })) as typeof fetch), /not accepted/);
});
