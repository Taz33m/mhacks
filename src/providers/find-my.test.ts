import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import test from 'node:test';
import type { ClientOptions, SharedFriendLocation, SharedFriendLocationUpdated } from '@photon-ai/advanced-imessage/grpc';
import type { TokenData } from '@spectrum-ts/core';
import { createFindMy, createNativeFindMyClient, normalizeFindMyPoint } from './find-my.ts';
import type { FindMyClient, FindMyFactoryOptions, FindMyPoint, FindMyStream, FindMySubject } from './find-my.ts';

const wearer = '+12025550100', maya = '+12025550101', jordan = '+12025550102';
const env = { SPECTRUM_PROJECT_ID: 'offline-project', SPECTRUM_PROJECT_SECRET: 'private-offline-secret',
  LIFELINE_WEARER_PHONE: wearer, LIFELINE_RESPONDERS_JSON: JSON.stringify([
    { id: 'maya', name: 'Maya', phone: maya }, { id: 'jordan', name: 'Jordan', phone: jordan },
  ]) };
const wearerSubject: FindMySubject = { role: 'wearer', address: wearer, name: 'Offline wearer' };
const responder = (address = maya, responderId = 'maya', incidentId = 'incident-one'): FindMySubject =>
  ({ role: 'responder', address, responderId, incidentId, name: 'Offline responder' });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); await immediate(); }
function location(address = wearer, values: Partial<SharedFriendLocation> = {}): SharedFriendLocation {
  return { address, latitude: 42.278, longitude: -83.7382, locationTimestamp: new Date(Date.now() - 1000),
    isLocatingInProgress: false, locationType: 'live', ...values };
}
class Stream implements FindMyStream {
  closed = 0;
  private queue: Array<{ value?: SharedFriendLocationUpdated; error?: unknown }> = [];
  private nextResult: ReturnType<typeof deferred<IteratorResult<SharedFriendLocationUpdated>>> | undefined;
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<SharedFriendLocationUpdated>> {
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    const item = this.queue.shift();
    if (item) return item.error ? Promise.reject(item.error) : Promise.resolve({ done: false, value: item.value! });
    this.nextResult = deferred<IteratorResult<SharedFriendLocationUpdated>>(); return this.nextResult.promise;
  }
  push(value: SharedFriendLocationUpdated) {
    if (this.nextResult) { const next = this.nextResult; this.nextResult = undefined; next.resolve({ done: false, value }); }
    else this.queue.push({ value });
  }
  fail(error: unknown) {
    if (this.nextResult) { const next = this.nextResult; this.nextResult = undefined; next.reject(error); }
    else this.queue.push({ error });
  }
  async close() { this.closed++; this.nextResult?.resolve({ done: true, value: undefined }); this.nextResult = undefined; }
}
function clientFixture() {
  const streams: Array<{ address: string; stream: Stream }> = [], gets: string[] = [];
  const requests: Array<{ chatId: string; address: string; id?: string }> = [];
  let closes = 0;
  const client: FindMyClient = {
    locations: {
      get: async address => { gets.push(address); throw { name: 'NotFoundError', grpcCode: 5, message: 'PRIVATE ERROR' }; },
      request: async (chatId, address, options) => {
        requests.push({ chatId, address, id: options?.clientMessageId });
        return { address, status: 'accepted', messageGuid: 'private-native-card-id' };
      },
      watch: address => { const stream = new Stream(); streams.push({ address, stream }); return stream; },
    },
    close: async () => { closes++; },
  };
  return { client, streams, gets, requests, closes: () => closes };
}

test('unconfigured adapter performs no calls or simulated position output', async () => {
  let calls = 0;
  const adapter = createFindMy({ env: {}, factory: async () => { calls++; return clientFixture().client; } });
  assert.equal(adapter.status().configured, false);
  assert.equal((await adapter.request(wearer, `any;-;${wearer}`)).status, 'failed');
  const stop = await adapter.start(() => [wearerSubject], () => assert.fail('no injected location'));
  await stop(); assert.equal(calls, 0);
});

test('Nook shared routing renews at 80 percent TTL with one in-flight mint and no unary retries', async () => {
  let now = 0, mints = 0, options!: ClientOptions;
  const next = deferred<TokenData>(), fixture = clientFixture();
  await createNativeFindMyClient({ env, onHeartbeat: () => {} }, {
    now: () => now,
    mint: async () => { mints++; return mints === 1 ? { type: 'shared', token: 'first-token', expiresIn: 10 } : next.promise; },
    createClient: value => { options = value; return fixture.client; },
  });
  assert.equal(options.address, 'imessage.spectrum.photon.codes:443');
  assert.equal(options.tls, true); assert.equal(options.retry, false); assert.equal(options.timeout, 10_000);
  const token = options.token as () => Promise<string>;
  now = 7999; assert.equal(await token(), 'first-token'); assert.equal(mints, 1);
  now = 8000; const pending = [token(), token(), token()]; await flush(); assert.equal(mints, 2);
  next.resolve({ type: 'shared', token: 'second-token', expiresIn: 10 });
  assert.deepEqual(await Promise.all(pending), ['second-token', 'second-token', 'second-token']);
});

test('dedicated routing stays on the selected line and rejects a refreshed missing line token', async () => {
  let now = 0, options!: ClientOptions, mintCount = 0;
  await createNativeFindMyClient({ env: { ...env, SPECTRUM_IMESSAGE_LINE_ID: 'line-b' }, onHeartbeat: () => {} }, {
    now: () => now,
    mint: async (): Promise<TokenData> => ({ type: 'dedicated', expiresIn: 10, numbers: {},
      auth: ++mintCount === 1 ? { 'line-a': 'a', 'line-b': 'b' } : { 'line-a': 'new-a' } }),
    createClient: value => { options = value; return clientFixture().client; },
  });
  assert.equal(options.address, 'line-b.imsg.photon.codes:443');
  const token = options.token as () => Promise<string>; assert.equal(await token(), 'b');
  now = 8000; await assert.rejects(token(), /line token unavailable/);
});

test('request uses existing chat and durable id; created card is accepted without claiming delivery or permission', async () => {
  const fixture = clientFixture(), adapter = createFindMy({ env, factory: async () => fixture.client });
  const result = await adapter.request(wearer, `any;-;${wearer}`, 'stable-request-id');
  assert.deepEqual(fixture.requests, [{ chatId: `any;-;${wearer}`, address: wearer, id: 'stable-request-id' }]);
  assert.equal(result.status, 'provider_accepted'); assert.equal(result.messageId, 'private-native-card-id');
  assert.match(result.detail, /delivery and location-sharing permission remain unverified/);
  for (const [address, chat] of [[maya, `any;-;${maya}`], ['+12025550999', 'any;-;other'], [wearer, 'new-chat'], ['12025550100', `any;-;${wearer}`]])
    assert.equal((await adapter.request(address, chat)).status, 'failed');
  assert.equal(fixture.requests.length, 1, 'no unapproved responder or chat creation');
  await (await adapter.start(() => []))(); assert.equal(fixture.closes(), 1);
});

test('unknown receipt or deadline after submission remains uncertain and never retries automatically', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const fixture = clientFixture();
  fixture.client.locations.request = async (chatId, address) => {
    fixture.requests.push({ chatId, address }); return new Promise(() => {});
  };
  const adapter = createFindMy({ env, factory: async () => fixture.client });
  const pending = adapter.request(wearer, `any;-;${wearer}`, 'once'); await flush();
  t.mock.timers.tick(10_000); const result = await pending;
  assert.equal(result.status, 'unknown'); assert.match(result.detail, /deadline exceeded.*no automatic retry/);
  t.mock.timers.tick(60_000); await flush(); assert.equal(fixture.requests.length, 1);
  fixture.client.locations.request = async (_, address) => ({ address, status: 'unexpected-state', reason: 'PRIVATE SECRET' });
  const unknown = await adapter.request(wearer, `any;-;${wearer}`, 'another-explicit-request');
  assert.equal(unknown.status, 'unknown'); assert.doesNotMatch(unknown.detail, /PRIVATE|120255/);
  await (await adapter.start(() => []))();
});

test('request revocation while client preparation awaits prevents any native mutation', async () => {
  const fixture = clientFixture(), ready = deferred<FindMyClient>(); let allowed = true;
  const adapter = createFindMy({ env, factory: async () => ready.promise });
  const pending = adapter.request(wearer, `any;-;${wearer}`, 'revoked-request', () => allowed); await flush();
  allowed = false; ready.resolve(fixture.client);
  assert.deepEqual(await pending, { status: 'failed', detail: 'Sharing request authorization ended before submission.' });
  assert.equal(fixture.requests.length, 0);
  await (await adapter.start(() => []))();
});

test('approved address watches only, wearer-only cached read, truthful native timestamps and null accuracy', async () => {
  const fixture = clientFixture(), seen: Array<{ subject: FindMySubject; point: FindMyPoint | null }> = [];
  const adapter = createFindMy({ env, factory: async () => fixture.client });
  const stop = await adapter.start(() => [wearerSubject, responder(), { ...responder(jordan, 'not-approved'), name: 'Unapproved' }],
    (subject, point) => seen.push({ subject, point })); await flush();
  assert.deepEqual(fixture.streams.map(value => value.address), [wearer, maya]); assert.deepEqual(fixture.gets, [wearer]);
  const stream = fixture.streams[0].stream, capture = Date.now() - 10 * 60_000;
  stream.push({ sourceSequence: 10, location: location(wearer, { locationTimestamp: new Date(capture) }) }); await flush();
  assert.equal(seen.length, 1); assert.equal(seen[0].point?.timestamp, capture);
  assert.equal(seen[0].point?.accuracy, null); assert.equal(seen[0].point?.source, 'photon-find-my');
  assert.ok(seen[0].point!.receivedAt > capture); assert.match(adapter.status().detail, /receiving approved location updates/);
  stream.push({ sourceSequence: 10, location: location() });
  stream.push({ sourceSequence: 9, location: location() });
  stream.push({ sourceSequence: 11, location: location(jordan) });
  stream.push({ sourceSequence: 12, location: location(wearer, { locationTimestamp: undefined }) });
  stream.push({ sourceSequence: 13, location: location(wearer, { latitude: undefined, isLocatingInProgress: true }) });
  await flush(); assert.equal(seen.length, 1, 'transient missing data does not revoke last-known position');
  stream.push({ sourceSequence: 14, location: location(wearer, { expiresAt: new Date(Date.now() - 1) }) });
  await flush(); assert.equal(seen.length, 2); assert.equal(seen[1].point, null);
  await stop(); assert.equal(fixture.closes(), 1); assert.ok(fixture.streams.every(value => value.stream.closed === 1));
});

test('dynamic ownership changes reject late updates before reconciliation and retire only that responder watch', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const fixture = clientFixture(), seen: FindMySubject[] = [];
  let subjects = [wearerSubject, responder()];
  const adapter = createFindMy({ env, factory: async () => fixture.client });
  const stop = await adapter.start(() => subjects, subject => seen.push(subject)); await flush();
  const old = fixture.streams[1].stream;
  subjects = [wearerSubject, responder(jordan, 'jordan', 'incident-two')];
  old.push({ sourceSequence: 1, location: location(maya) }); await flush(); assert.equal(seen.length, 0);
  assert.equal((await adapter.request(maya, `any;-;${maya}`)).status, 'failed');
  t.mock.timers.tick(1000); await flush();
  assert.equal(old.closed, 1); assert.equal(fixture.streams[0].stream.closed, 0);
  assert.equal(fixture.streams[2].address, jordan); assert.deepEqual(fixture.gets, [wearer]);
  fixture.streams[2].stream.push({ sourceSequence: 1, location: location(jordan) }); await flush();
  assert.equal(seen[0].incidentId, 'incident-two'); assert.equal(seen[0].responderId, 'jordan');
  await stop();
});

test('a late initial cached position is suppressed after the approved wearer is removed', async () => {
  const fixture = clientFixture(), snapshot = deferred<SharedFriendLocation>(); let subjects = [wearerSubject], calls = 0;
  fixture.client.locations.get = () => snapshot.promise;
  const adapter = createFindMy({ env, factory: async () => fixture.client });
  const stop = await adapter.start(() => subjects, () => { calls++; }); await flush();
  subjects = []; snapshot.resolve(location()); await flush(); assert.equal(calls, 0); await stop();
});

test('watch reconnect backoff is cancellable; native sequence may restart but cached reads do not repeat', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const fixture = clientFixture(), seen: FindMyPoint[] = [];
  const adapter = createFindMy({ env, factory: async () => fixture.client });
  const stop = await adapter.start(() => [wearerSubject], (_, point) => { if (point) seen.push(point); }); await flush();
  fixture.streams[0].stream.push({ sourceSequence: 50, location: location() }); await flush();
  fixture.streams[0].stream.fail({ grpcCode: 14, message: 'PRIVATE URL AND TOKEN' }); await flush();
  assert.equal(fixture.streams[0].stream.closed, 1); assert.doesNotMatch(adapter.status().detail, /PRIVATE/);
  t.mock.timers.tick(999); await flush(); assert.equal(fixture.streams.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(fixture.streams.length, 2);
  fixture.streams[1].stream.push({ sourceSequence: 1, location: location() }); await flush();
  assert.deepEqual(seen.map(point => point.sourceSequence), [50, 1]);
  fixture.streams[1].stream.fail({ grpcCode: 14 }); await flush();
  await stop(); t.mock.timers.tick(60_000); await flush();
  assert.equal(fixture.streams.length, 2); assert.deepEqual(fixture.gets, [wearer]); assert.equal(fixture.closes(), 1);
});

test('authentication failure pauses a watch without endlessly recreating it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const fixture = clientFixture(), adapter = createFindMy({ env, factory: async () => fixture.client });
  const stop = await adapter.start(() => [wearerSubject]); await flush();
  fixture.streams[0].stream.fail({ grpcCode: 16, name: 'AuthenticationError', message: env.SPECTRUM_PROJECT_SECRET }); await flush();
  t.mock.timers.tick(120_000); await flush();
  assert.equal(fixture.streams.length, 1); assert.deepEqual(fixture.gets, [wearer]);
  assert.match(adapter.status().detail, /UNAUTHENTICATED/); assert.doesNotMatch(adapter.status().detail, /private-offline-secret/);
  await stop();
});

test('native heartbeats preserve idle watches; a silent connection is retired and restarted', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const fixture = clientFixture(); let factoryOptions!: FindMyFactoryOptions;
  const adapter = createFindMy({ env, factory: async options => { factoryOptions = options; return fixture.client; } });
  const stop = await adapter.start(() => [wearerSubject]); await flush();
  t.mock.timers.tick(75_000); factoryOptions.onHeartbeat();
  t.mock.timers.tick(60_000); await flush(); assert.equal(fixture.streams[0].stream.closed, 0);
  t.mock.timers.tick(45_000); await flush(); assert.equal(fixture.streams[0].stream.closed, 1);
  t.mock.timers.tick(1000); await flush(); assert.equal(fixture.streams.length, 2); await stop();
});

test('initial token/network failure recovers with bounded backoff without closing the adapter', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const fixture = clientFixture(); let attempts = 0;
  const adapter = createFindMy({ env, factory: async () => {
    if (++attempts === 1) throw { grpcCode: 14, message: 'PRIVATE PROJECT AND TOKEN' };
    return fixture.client;
  } });
  const stop = await adapter.start(() => [wearerSubject]); await flush();
  assert.equal(attempts, 1); assert.match(adapter.status().detail, /reconnecting with bounded backoff/);
  assert.doesNotMatch(adapter.status().detail, /PRIVATE/);
  t.mock.timers.tick(999); await flush(); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(attempts, 2); assert.equal(fixture.streams.length, 1);
  assert.equal((await adapter.request(wearer, `any;-;${wearer}`, 'after-recovery')).status, 'provider_accepted');
  assert.equal(fixture.requests.length, 1); await stop(); assert.equal(fixture.closes(), 1);
});

test('stop during pending initialization returns promptly and closes a late client without reads or watches', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const fixture = clientFixture(), ready = deferred<FindMyClient>(); let attempts = 0, outputs = 0;
  const adapter = createFindMy({ env, factory: async () => { attempts++; return ready.promise; } });
  const stop = await adapter.start(() => [wearerSubject], () => { outputs++; }); await flush();
  await stop(); assert.equal(attempts, 1); assert.equal(fixture.closes(), 0);
  ready.resolve(fixture.client); await flush(); t.mock.timers.tick(120_000); await flush();
  assert.equal(fixture.closes(), 1); assert.equal(fixture.streams.length, 0); assert.equal(fixture.gets.length, 0);
  assert.equal(outputs, 0); assert.equal(attempts, 1);
});

test('initial authentication rejection stays visibly unavailable and does not retry token creation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  let attempts = 0;
  const adapter = createFindMy({ env, factory: async () => {
    attempts++; throw { name: 'AuthenticationError', grpcCode: 16, message: env.SPECTRUM_PROJECT_SECRET };
  } });
  const stop = await adapter.start(() => [wearerSubject]); await flush();
  assert.match(adapter.status().detail, /UNAUTHENTICATED.*verify native account configuration/);
  t.mock.timers.tick(120_000); await flush(); assert.equal(attempts, 1); await stop();
});

test('native normalization rejects absent/invalid capture evidence and never repairs it from receipt', () => {
  const now = Date.now(), base = location(wearer, { accuracy: 12 });
  assert.equal(normalizeFindMyPoint(base, 1, now)?.accuracy, 12);
  for (const value of [
    { locationTimestamp: undefined }, { locationTimestamp: new Date(NaN) }, { locationTimestamp: new Date(now + 10_001) },
    { latitude: NaN }, { longitude: 181 }, { latitude: 91 }, { accuracy: -1 }, { accuracy: Infinity },
    { expiresAt: new Date(NaN) }, { expiresAt: new Date(now - 1) },
  ]) assert.equal(normalizeFindMyPoint(location(wearer, value), 1, now), null);
  assert.equal(normalizeFindMyPoint(base, -1, now), null); assert.equal(normalizeFindMyPoint(base, Infinity, now), null);
  assert.equal(normalizeFindMyPoint(base, 1, NaN), null);
});
