import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPhotonAdapter } from './photon.ts';
import type { PhotonClient, PhotonMessage, PhotonSpace } from './photon.ts';
import type { ProviderInbound } from '../contracts.ts';

type Tuple = readonly [unknown, PhotonMessage];
const message = (id: string): Tuple => [undefined, {
  id, platform: 'imessage', direction: 'inbound', sender: { id: 'offline-sender' },
  content: { type: 'text', text: `Message ${id}` },
}];
const credentials = { projectId: 'offline-project', projectSecret: 'offline-secret' };

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1500;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'expected listener state was not reached');
    await delay(1);
  }
}

class Messages implements AsyncIterable<Tuple>, AsyncIterator<Tuple> {
  nextCalls = 0;
  returnCalls = 0;
  private buffer: Tuple[] = [];
  private pending: ReturnType<typeof Promise.withResolvers<IteratorResult<Tuple>>> | undefined;
  private ended = false;
  private failure: Error | undefined;
  [Symbol.asyncIterator](): AsyncIterator<Tuple> { return this; }
  next(): Promise<IteratorResult<Tuple>> {
    this.nextCalls++;
    if (this.buffer.length) return Promise.resolve({ done: false, value: this.buffer.shift()! });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    assert.equal(this.pending, undefined, 'only one next call may be pending');
    this.pending = Promise.withResolvers<IteratorResult<Tuple>>();
    return this.pending.promise;
  }
  return(): Promise<IteratorResult<Tuple>> {
    this.returnCalls++; this.end();
    return Promise.resolve({ done: true, value: undefined });
  }
  push(value: Tuple): void {
    if (this.ended || this.failure) return;
    if (this.pending) { const next = this.pending; this.pending = undefined; next.resolve({ done: false, value }); }
    else this.buffer.push(value);
  }
  end(): void {
    this.ended = true;
    this.pending?.resolve({ done: true, value: undefined }); this.pending = undefined;
  }
  fail(): void {
    this.failure = new Error('offline iterator failure');
    this.pending?.reject(this.failure); this.pending = undefined;
  }
}

function client(messages = new Messages(), space?: PhotonSpace) {
  const stats = { stops: 0 };
  const value: PhotonClient = {
    messages, openDm: async () => space,
    stop: async () => { stats.stops++; messages.end(); },
  };
  return { value, messages, stats };
}

test('initial listener failures retry with capped backoff and reserve one subscription', async () => {
  const active = client(); let factories = 0; const events: ProviderInbound[] = [];
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 30, listenerRetryBaseMs: 2, listenerRetryMaxMs: 8,
    factory: async () => { factories++; if (factories <= 3) throw new Error('private SDK error'); return active.value; },
  });
  const stop = await adapter.startPhotonListener(async event => { events.push(event); });
  try {
    await assert.rejects(adapter.startPhotonListener(async () => {}), /already running/);
    await until(() => adapter.status().detail.includes('retrying in 8 ms'));
    assert.ok(!adapter.status().detail.includes('private SDK error'));
    await until(() => active.messages.nextCalls > 0);
    assert.equal(factories, 4);
    active.messages.push(message('first'));
    await until(() => events.length === 1);
    assert.match(adapter.status().detail, /received an inbound event/);
  } finally { await stop(); }
  assert.equal(active.stats.stops, 1);
  assert.equal(active.messages.returnCalls, 1);
});

test('iterator end and error rebuild clients without redispatching successfully handled IDs', async () => {
  const clients = [client(), client(), client()];
  let factories = 0; const ids: string[] = [];
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 30, listenerRetryBaseMs: 2, listenerRetryMaxMs: 4,
    factory: async () => clients[factories++].value,
  });
  const stop = await adapter.startPhotonListener(async event => { ids.push(event.messageId); });
  try {
    await until(() => clients[0].messages.nextCalls > 0);
    clients[0].messages.push(message('duplicate'));
    await until(() => ids.length === 1);
    clients[0].messages.end();
    await until(() => clients[1].messages.nextCalls > 0);
    clients[1].messages.push(message('duplicate'));
    clients[1].messages.push(message('second'));
    await until(() => ids.length === 2);
    clients[1].messages.fail();
    await until(() => clients[2].messages.nextCalls > 0);
    clients[2].messages.push(message('duplicate'));
    clients[2].messages.push(message('third'));
    await until(() => ids.length === 3);
    assert.deepEqual(ids, ['duplicate', 'second', 'third']);
    assert.equal(factories, 3);
  } finally { await stop(); }
  assert.deepEqual(clients.map(c => c.stats.stops), [1, 1, 1]);
  assert.deepEqual(clients.map(c => c.messages.returnCalls), [1, 1, 1]);
});

test('idle subscribed streams do not time out; handler failure leaves a redelivery unacknowledged', async () => {
  const active = client(); let factories = 0; let handled = 0;
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 5, listenerRetryBaseMs: 2,
    factory: async () => { factories++; return active.value; },
  });
  const stop = await adapter.startPhotonListener(async () => { if (++handled === 1) throw new Error('handler failed'); });
  try {
    await until(() => active.messages.nextCalls > 0);
    await delay(15);
    assert.equal(factories, 1);
    active.messages.push(message('retry-handler'));
    await until(() => adapter.status().detail.includes('handler failed'));
    active.messages.push(message('retry-handler'));
    await until(() => handled === 2);
    active.messages.push(message('retry-handler'));
    await delay(5);
    assert.equal(handled, 2);
  } finally { await stop(); }
});

test('shutdown during retry cancels backoff and is idempotent', async () => {
  let factories = 0;
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 20, listenerRetryBaseMs: 30, listenerRetryMaxMs: 30,
    factory: async () => { factories++; throw new Error('offline'); },
  });
  const stop = await adapter.startPhotonListener(async () => {});
  await until(() => adapter.status().detail.includes('retrying in 30 ms'));
  const first = stop(); assert.equal(stop(), first); await first;
  const attempts = factories; await delay(40);
  assert.equal(factories, attempts);
  assert.match(adapter.status().detail, /Cloud listener stopped/);
  await assert.rejects(adapter.startPhotonListener(async () => {}), /has stopped/);
});

test('shutdown during DM preparation prevents a late submission without a caller permission hook', async () => {
  const dm = Promise.withResolvers<PhotonSpace>(); let sends = 0, opened = false;
  const active = client();
  active.value.openDm = async () => { opened = true; return dm.promise; };
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 100, factory: async () => active.value });
  const stop = await adapter.startPhotonListener(async () => {});
  const sending = adapter.sendMessage('+12025550101', 'Offline message');
  await until(() => opened);
  await stop();
  dm.resolve({ send: async () => { sends++; return { id: 'unexpected' }; } });
  assert.equal((await sending).status, 'cancelled');
  assert.equal(sends, 0);
});

test('startup timeouts reuse one pending factory and clean up late completion after shutdown', async () => {
  const pending = Promise.withResolvers<PhotonClient>();
  const late = client(); let factories = 0, dispatched = 0;
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 5, listenerRetryBaseMs: 2, listenerRetryMaxMs: 2,
    factory: () => { factories++; return pending.promise; },
  });
  const stop = await adapter.startPhotonListener(async () => { dispatched++; });
  await until(() => factories === 1);
  await delay(25);
  assert.equal(factories, 1, 'timeouts must not leak overlapping SDK initializations');
  await stop();
  assert.match(adapter.status().detail, /SDK cleanup incomplete/);
  pending.resolve(late.value);
  await until(() => late.stats.stops === 1);
  await delay(10);
  assert.equal(late.messages.nextCalls, 0);
  assert.equal(dispatched, 0);
  assert.equal(factories, 1);
  assert.equal((await adapter.sendMessage('+15551234567', 'after stop')).status, 'failed');
});

test('shutdown bounds uncooperative SDK cleanup and never dispatches a late next result', async () => {
  const next = Promise.withResolvers<IteratorResult<Tuple>>();
  const cleanup = Promise.withResolvers<void>();
  let stops = 0, returns = 0, dispatched = 0, factories = 0;
  const iterator: AsyncIterator<Tuple> = {
    next: () => next.promise,
    return: async () => { returns++; await cleanup.promise; return { done: true, value: undefined }; },
  };
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 5, listenerRetryBaseMs: 2,
    factory: async () => { factories++; return {
      messages: { [Symbol.asyncIterator]: () => iterator }, openDm: async () => undefined,
      stop: async () => { stops++; await cleanup.promise; },
    }; },
  });
  const stop = await adapter.startPhotonListener(async () => { dispatched++; });
  await until(() => adapter.status().detail.includes('subscribed'));
  await stop();
  assert.equal(stops, 1); assert.equal(returns, 1);
  assert.match(adapter.status().detail, /stopped dispatch\/recovery; SDK cleanup incomplete/);
  next.resolve({ done: false, value: message('late') }); cleanup.resolve();
  await delay(10);
  assert.equal(dispatched, 0); assert.equal(factories, 1);
});

test('failed-client retirement blocks replacements until SDK cleanup completes', async () => {
  const old = client(), recovered = client();
  const cleanup = Promise.withResolvers<void>();
  old.value.stop = async () => { old.stats.stops++; await cleanup.promise; };
  let factories = 0;
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 5, listenerRetryBaseMs: 2, listenerRetryMaxMs: 2,
    factory: async () => (++factories === 1 ? old.value : recovered.value),
  });
  const stop = await adapter.startPhotonListener(async () => {});
  try {
    await until(() => old.messages.nextCalls > 0); old.messages.fail();
    await until(() => old.stats.stops === 1); await delay(20);
    assert.equal(factories, 1, 'an unclosed SDK instance cannot cause unbounded replacement clients');
    cleanup.resolve();
    await until(() => recovered.messages.nextCalls > 0);
    assert.equal(factories, 2);
  } finally { cleanup.resolve(); await stop(); }
});

test('two submitted send lanes remain unknown on listener replacement and are never resent', async () => {
  const submissions = [Promise.withResolvers<{ id: string }>(), Promise.withResolvers<{ id: string }>()];
  let sends = 0, replacementSends = 0, factories = 0;
  const old = client(new Messages(), { send: () => submissions[sends++].promise });
  const recovered = client(new Messages(), { send: async () => { replacementSends++; return { id: 'new-submit' }; } });
  old.value.stop = async () => {
    old.stats.stops++; old.messages.end();
    for (const submitted of submissions) submitted.reject(new Error('connection ended after submission'));
  };
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 40, listenerRetryBaseMs: 2,
    factory: async () => (++factories === 1 ? old.value : recovered.value),
  });
  const stop = await adapter.startPhotonListener(async () => {});
  try {
    await until(() => old.messages.nextCalls > 0);
    const lanes = [adapter.sendMessage('+15551234567', 'wearer'), adapter.sendMessage('+15551234568', 'responder')];
    await until(() => sends === 2); old.messages.fail();
    const outcomes = await Promise.all(lanes);
    assert.deepEqual(outcomes.map(result => result.status), ['unknown', 'unknown']);
    await until(() => recovered.messages.nextCalls > 0);
    assert.equal(sends, 2); assert.equal(replacementSends, 0);
    assert.match(adapter.status().detail, /listener subscribed/);
    assert.match(adapter.status().detail, /outcome unknown/);
    const later = await adapter.sendMessage('+15551234567', 'new authorized action');
    assert.equal(later.status, 'provider_accepted'); assert.equal(replacementSends, 1);
    assert.match(adapter.status().detail, /listener subscribed/);
    assert.match(adapter.status().detail, /Cloud accepted a message/);
  } finally { await stop(); }
});

test('shutdown during failed-client retirement reports unfinished SDK cleanup without resurrection', async () => {
  const old = client(); const cleanup = Promise.withResolvers<void>(); let factories = 0;
  old.value.stop = async () => { old.stats.stops++; await cleanup.promise; };
  const adapter = createPhotonAdapter({ ...credentials, timeoutMs: 5, listenerRetryBaseMs: 2, listenerRetryMaxMs: 2,
    factory: async () => { factories++; return old.value; },
  });
  const stop = await adapter.startPhotonListener(async () => {});
  await until(() => old.messages.nextCalls > 0); old.messages.fail();
  await until(() => adapter.status().detail.includes('cleanup incomplete'));
  await stop();
  assert.match(adapter.status().detail, /stopped dispatch\/recovery; SDK cleanup incomplete/);
  cleanup.resolve(); await delay(10);
  assert.equal(factories, 1); assert.equal(old.stats.stops, 1);
});
