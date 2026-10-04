import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocationGateway } from './location-gateway.ts';

test('public sharing gateway blocks broader product routes and query-string capabilities', async () => {
  const calls: string[] = [];
  const gateway = createLocationGateway(8877, (async (url) => { calls.push(String(url)); return new Response('{}'); }) as typeof fetch);
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  try {
    for (const path of ['/api/state', '/api/setup', '/live', '/api/patient-record', '/dashboard', '/api/commands', '/share-location?grant=secret']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    assert.equal((await fetch(base + '/api/location/share')).status, 401);
    assert.equal(calls.length, 0);
    const response = await fetch(base + '/share-location');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('permissions-policy')!, /geolocation=\(self\)/);
    assert.deepEqual(calls, ['http://127.0.0.1:8877/share-location']);
  } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
});

test('sharing forwards only a scoped bearer and bounded location body', async () => {
  let observed: RequestInit | undefined;
  const gateway = createLocationGateway(8877, (async (_, init) => { observed = init; return Response.json({ ok: true }); }) as typeof fetch);
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + '/api/location/share', { method: 'POST',
      headers: { Authorization: 'Bearer test-grant', Cookie: 'operator=must-not-forward', 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 42, longitude: -83 }) });
    assert.equal(response.status, 200);
    assert.equal(new Headers(observed?.headers).get('authorization'), 'Bearer test-grant');
    assert.equal(new Headers(observed?.headers).get('cookie'), null);
    assert.equal((await fetch(base + '/api/location/share', { method: 'POST', headers: { Authorization: 'Bearer test-grant' }, body: 'x'.repeat(8001) })).status, 413);
  } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
});
