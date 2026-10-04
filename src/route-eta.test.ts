import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteEta } from './route-eta.ts';
import type { RouteEtaSpawn } from './route-eta.ts';

// Public campus coordinates used only as generated test input; no private location reads.
const origin = { latitude: 42.278, longitude: -83.7382 }, target = { latitude: 42.2766, longitude: -83.7373 };

test('Apple ETA adapter uses bounded argv execution and retains routed walking provenance', async () => {
  let calls = 0;
  const spawn: RouteEtaSpawn = (file, args, options, callback) => {
    calls++; assert.equal(file, '/private/offline-eta-helper');
    assert.deepEqual(args, ['42.278', '-83.7382', '42.2766', '-83.7373']);
    assert.deepEqual(options, { timeout: 8000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true });
    callback(null, JSON.stringify({ seconds: 160, distanceMeters: 177, transport: 'walking' }), 'ignored private diagnostic');
  };
  const before = Date.now(), result = await createRouteEta({ helperPath: '/private/offline-eta-helper', spawn }).estimate(origin, target);
  assert.equal(calls, 1); assert.ok(result);
  assert.equal(result.method, 'apple-maps-walking'); assert.equal(result.seconds, 160); assert.equal(result.distanceMeters, 177);
  assert.ok(result.updatedAt >= before && result.updatedAt <= Date.now());
});

test('invalid coordinates or relative helper cannot invoke any routing process', async () => {
  let calls = 0;
  const spawn: RouteEtaSpawn = () => { calls++; throw new Error('must not run'); };
  const eta = createRouteEta({ helperPath: '/private/offline-eta-helper', spawn });
  for (const point of [{ latitude: NaN, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: -91, longitude: 0 },
    { latitude: 0, longitude: Infinity }, { latitude: 0, longitude: 181 }, { latitude: 0, longitude: -181 }]) {
    assert.equal(await eta.estimate(point, target), null); assert.equal(await eta.estimate(origin, point), null);
  }
  assert.equal(await createRouteEta({ helperPath: 'relative/path', spawn }).estimate(origin, target), null);
  assert.equal(calls, 0);
});

test('malformed, excessive and non-walking output never becomes an ETA or fallback', async () => {
  for (const stdout of ['null', '{}', 'not json', '[]', 'x'.repeat(4097), '{"seconds":NaN}',
    ...[{ seconds: -1, distanceMeters: 1, transport: 'walking' }, { seconds: 86401, distanceMeters: 1, transport: 'walking' },
      { seconds: 1, distanceMeters: -1, transport: 'walking' }, { seconds: 1, distanceMeters: 500001, transport: 'walking' },
      { seconds: '1', distanceMeters: 1, transport: 'walking' }, { seconds: 1, distanceMeters: 1, transport: 'automobile' },
      { seconds: 1, distanceMeters: 1, transport: 'walking', rawLatitude: 42 }].map(value => JSON.stringify(value))]) {
    const spawn: RouteEtaSpawn = (_file, _args, _options, callback) => callback(null, stdout, '');
    assert.equal(await createRouteEta({ spawn }).estimate(origin, target), null);
  }
});

test('failed process, timeout/overflow and absent helper remain null without logging error content', async () => {
  const spawn: RouteEtaSpawn = (_file, _args, _options, callback) => callback(new Error('private diagnostic'), '', 'private diagnostic');
  assert.equal(await createRouteEta({ spawn }).estimate(origin, target), null);
  assert.equal(await createRouteEta({ spawn: () => { throw new Error('spawn failed'); } }).estimate(origin, target), null);
  assert.equal(await createRouteEta({ helperPath: '/private/does-not-exist/lifeline-eta' }).estimate(origin, target), null);
});
