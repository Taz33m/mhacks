import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotonAdapter, normalizePhoton } from './photon.ts';
import type { PhotonClient, PhotonMessage, PhotonSendOptions, PhotonSpace } from './photon.ts';

const phone = '+15551234567';
const chatId = `any;-;${phone}`;
const lineId = '+15557654321';
const spaceIdentity = { id: chatId, phone: lineId, type: 'dm' };
const replyOptions = { replyToMessageId: 'incoming-question', chatId, lineId };
function inbound(overrides: Partial<PhotonMessage> = {}): PhotonMessage {
  return { id: replyOptions.replyToMessageId, platform: 'imessage', direction: 'inbound',
    sender: { id: phone }, space: spaceIdentity, timestamp: new Date(1700000000123),
    content: { type: 'text', text: 'What allergies are recorded?' }, ...overrides };
}
function transport(target: PhotonMessage | undefined = inbound()) {
  const counts = { dm: 0, plain: 0, lookup: 0, reply: 0, bound: 0 };
  if (target && !target.reply) target.reply = async text => {
    counts.reply++; assert.equal(text, 'Recorded allergy context');
    return { id: 'native-reply', space: spaceIdentity };
  };
  const space: PhotonSpace = { ...spaceIdentity,
    getMessage: async id => { counts.lookup++; assert.equal(id, replyOptions.replyToMessageId); return target; },
    send: async () => { counts.plain++; return { id: 'plain-send', space: spaceIdentity }; },
  };
  const client: PhotonClient = {
    messages: (async function* () {})(), stop: async () => {},
    openDm: async () => { counts.dm++; return space; },
    openSpace: async (chat, line) => {
      counts.bound++; assert.equal(chat, chatId); assert.equal(line, lineId); return space;
    },
  };
  const adapter = createPhotonAdapter({ projectId: 'offline', projectSecret: 'offline', timeoutMs: 20,
    factory: async () => client });
  return { adapter, client, space, counts };
}

test('native inbound channel/time belong to the event, preserving the original reply target', () => {
  const at = 1700000000123;
  const target = { id: 'original-alert', space: { id: 'old-chat', phone: 'old-line' }, timestamp: new Date(1) };
  for (const content of [
    { type: 'text', text: 'arrived' },
    { type: 'reply', target, content: { type: 'text', text: 'arrived' } },
    { type: 'reaction', target, emoji: '👍' },
  ]) {
    const event = normalizePhoton(inbound({ content }));
    assert.equal(event?.chatId, chatId);
    assert.equal(event?.lineId, lineId);
    assert.equal(event?.providerTimestamp, at);
    assert.equal(event?.targetMessageId, content.type === 'text' ? undefined : 'original-alert');
  }
  assert.equal(normalizePhoton(inbound({ space: { ...spaceIdentity, phone: 'shared' } }))?.lineId, 'shared');
  const missing = normalizePhoton(inbound({ space: undefined, timestamp: undefined }));
  assert.ok(missing && !('chatId' in missing) && !('lineId' in missing) && !('providerTimestamp' in missing));
  assert.equal(normalizePhoton(inbound({ timestamp: new Date(NaN) }))?.providerTimestamp, undefined);
});

test('new DM acceptance returns resolved native identities without inventing a line from the recipient', async () => {
  const { adapter, counts, space } = transport();
  // Pinned SDK sends normally return their space; the resolved space remains
  // usable metadata when a legacy test double returns only a message ID.
  space.send = async () => { counts.plain++; return { id: 'accepted-DM' }; };
  const result = await adapter.sendMessage(phone, 'Alert');
  assert.deepEqual(result, { status: 'provider_accepted', messageId: 'accepted-DM', chatId, lineId,
    detail: 'Cloud accepted a message; recipient delivery is not established' });
  assert.equal(counts.dm, 1); assert.equal(counts.bound, 0);
});

test('persisted source IDs resolve and send a native reply without requiring an in-memory observation', async () => {
  const { adapter, counts } = transport(inbound({ sender: { id: phone.slice(1) } }));
  const result = await adapter.sendMessage(phone, 'Recorded allergy context', () => true, replyOptions);
  assert.equal(result.status, 'provider_accepted'); assert.equal(result.messageId, 'native-reply');
  assert.equal(result.chatId, chatId); assert.equal(result.lineId, lineId);
  assert.deepEqual(counts, { dm: 0, plain: 0, lookup: 1, reply: 1, bound: 1 });
});

test('bound DM status sends retain exact channel and line without an arbitrary new DM', async () => {
  const { adapter, counts } = transport();
  assert.equal((await adapter.sendMessage(phone, 'Status', () => true, { chatId, lineId })).status, 'provider_accepted');
  assert.deepEqual(counts, { dm: 0, plain: 1, lookup: 0, reply: 0, bound: 1 });
});

test('incomplete, different-peer or group reply identities fail before SDK initialization', async () => {
  for (const options of [
    { replyToMessageId: 'incoming-question' }, { chatId }, { lineId },
    { ...replyOptions, chatId: 'any;+;incident-group' },
    { ...replyOptions, chatId: 'any;-;+15550000000' },
    { ...replyOptions, lineId: ' ' }, { ...replyOptions, replyToMessageId: '' },
  ] satisfies PhotonSendOptions[]) {
    let initialized = 0;
    const adapter = createPhotonAdapter({ projectId: 'offline', projectSecret: 'offline',
      factory: async () => { initialized++; throw new Error('must not initialize'); } });
    assert.equal((await adapter.sendMessage(phone, 'Reply', () => true, options)).status, 'failed');
    assert.equal(initialized, 0);
  }
});

test('unresolved or contradictory native source identities never submit or silently fall back', async () => {
  for (const target of [
    undefined, inbound({ id: 'different-message' }), inbound({ direction: 'outbound' }),
    inbound({ platform: 'other' }), inbound({ sender: undefined }),
    inbound({ sender: { id: 'wearer@example.com' } }),
    inbound({ sender: { id: '+15550000000' } }), inbound({ sender: { id: phone, kind: 'agent' } }),
    inbound({ space: undefined }), inbound({ space: { ...spaceIdentity, id: 'different-chat' } }),
    inbound({ space: { ...spaceIdentity, phone: 'different-line' } }),
    inbound({ space: { ...spaceIdentity, type: 'group' } }),
  ]) {
    const { adapter, counts, space } = transport(target);
    if (!target) space.getMessage = async () => undefined;
    assert.equal((await adapter.sendMessage(phone, 'Recorded allergy context', () => true, replyOptions)).status, 'failed');
    assert.equal(counts.dm + counts.plain + counts.reply, 0);
  }
  for (const missing of ['openSpace', 'getMessage', 'reply', 'wrong-space', 'wrong-line'] as const) {
    const { adapter, counts, client, space } = transport();
    if (missing === 'openSpace') client.openSpace = undefined;
    else if (missing === 'getMessage') space.getMessage = undefined;
    else if (missing === 'wrong-space') space.id = 'different-chat';
    else if (missing === 'wrong-line') space.phone = 'different-line';
    else space.getMessage = async () => inbound();
    assert.equal((await adapter.sendMessage(phone, 'Recorded allergy context', () => true, replyOptions)).status, 'failed');
    assert.equal(counts.dm + counts.plain + counts.reply, 0);
  }
});

test('authorization is rechecked after reply target lookup and before native submission', async () => {
  const pending = Promise.withResolvers<PhotonMessage>();
  const entered = Promise.withResolvers<void>();
  const { adapter, space, counts } = transport();
  space.getMessage = async () => { entered.resolve(); return pending.promise; };
  let allowed = true;
  const sending = adapter.sendMessage(phone, 'Recorded allergy context', () => allowed, replyOptions);
  await entered.promise; allowed = false;
  pending.resolve(inbound({ reply: async () => { counts.reply++; return { id: 'must-not-send' }; } }));
  assert.equal((await sending).status, 'cancelled');
  assert.equal(counts.reply + counts.dm + counts.plain, 0);
});

test('reply lookup failure is pre-submit failed; submitted errors/missing IDs/timeouts remain unknown', async () => {
  for (const stage of ['lookup-error', 'lookup-timeout', 'reply-error', 'reply-timeout', 'reply-empty'] as const) {
    const { adapter, space, counts } = transport();
    if (stage.startsWith('lookup')) space.getMessage = async () => {
      if (stage === 'lookup-error') throw new Error('lookup failed');
      return new Promise(() => {});
    };
    else space.getMessage = async () => inbound({ reply: async () => {
      counts.reply++;
      if (stage === 'reply-error') throw new Error('submitted reply failed');
      if (stage === 'reply-timeout') return new Promise(() => {});
      return undefined;
    } });
    assert.equal((await adapter.sendMessage(phone, 'Reply', () => true, replyOptions)).status,
      stage.startsWith('lookup') ? 'failed' : 'unknown');
    assert.equal(counts.dm + counts.plain, 0);
    assert.equal(counts.reply, stage.startsWith('lookup') ? 0 : 1);
  }
});

test('submitted reply with contradictory returned channel is unknown and preserves actual facts', async () => {
  const { adapter, counts } = transport(inbound({ reply: async () => {
    counts.reply++; return { id: 'unexpected-result', space: { id: 'different-chat', phone: 'different-line' } };
  } }));
  const result = await adapter.sendMessage(phone, 'Reply', () => true, replyOptions);
  assert.equal(result.status, 'unknown'); assert.equal(result.messageId, 'unexpected-result');
  assert.equal(result.chatId, 'different-chat'); assert.equal(result.lineId, 'different-line');
  assert.equal(counts.reply, 1); assert.equal(counts.dm + counts.plain, 0);
});
