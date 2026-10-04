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

test('native sender service is preserved across texts, replies and reactions without altering conversation identities', () => {
  for (const service of ['iMessage', 'SMS', 'RCS', 'unknown'] as const) {
    for (const content of [
      { type: 'text', text: 'arrived' },
      { type: 'reply', target: { id: 'original-alert' }, content: { type: 'text', text: 'arrived' } },
      { type: 'reaction', target: { id: 'original-alert' }, emoji: '👍' },
    ]) {
      const event = normalizePhoton(inbound({ sender: { id: phone, service }, content }));
      assert.ok(event);
      assert.equal(event.service, service);
      assert.equal(event.sender, phone);
      assert.equal(event.chatId, chatId);
      assert.equal(event.lineId, lineId);
      assert.equal(event.providerTimestamp, 1700000000123);
      assert.equal(event.targetMessageId, content.type === 'text' ? undefined : 'original-alert');
      assert.equal(event.kind, content.type === 'reaction' ? 'reaction' : 'text');
    }
  }
});

test('absent or invalid native service is omitted rather than inferred from the Photon platform', () => {
  const legacy = normalizePhoton(inbound());
  assert.ok(legacy && !('service' in legacy));
  for (const service of [null, 1, {}, 'imessage', 'sms', ' RCS', 'private untrusted value']) {
    const event = normalizePhoton(inbound({ sender: { id: phone, service } }));
    assert.deepEqual(event, legacy);
  }
  assert.equal(normalizePhoton(inbound({ platform: 'other', sender: { id: phone, service: 'RCS' } })), null);
  assert.equal(normalizePhoton(inbound({ sender: { id: phone, kind: 'agent', service: 'iMessage' } })), null);
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

test('submitted service authorization errors remain unknown with safe method/code diagnostics and no private payload', async () => {
  const { adapter, counts, space } = transport();
  const privateValue = 'private-secret-value';
  space.send = async () => {
    counts.plain++;
    throw Object.assign(new Error(`Target not allowed for this project: ${phone} ${privateValue}`), {
      name: 'AuthenticationError', code: 'internalError', grpcCode: 7, retryable: false,
      source: 'spectrum-imessage', context: { phone, token: privateValue }, requestId: privateValue,
    });
  };
  const result = await adapter.sendMessage(phone, 'Alert');
  assert.equal(result.status, 'unknown'); assert.equal(counts.plain, 1);
  assert.match(result.detail, /space\.send/); assert.match(result.detail, /AuthenticationError/);
  assert.match(result.detail, /internalError/); assert.match(result.detail, /gRPC 7 PERMISSION_DENIED/);
  assert.match(result.detail, /Target not allowed for this project/); assert.match(result.detail, /registered Photon project Users/);
  assert.equal(result.detail.includes(phone), false); assert.equal(result.detail.includes(privateValue), false);
  assert.equal(result.messageId, undefined);
});

test('arbitrary error fields are omitted and native reply failures still cannot fall back or retry', async () => {
  const privateValue = 'private-secret-value';
  const { adapter, counts } = transport(inbound({ reply: async () => {
    counts.reply++;
    throw Object.assign(new Error(`${phone} ${privateValue}`), {
      name: privateValue, code: privateValue, grpcCode: 12345678,
      source: privateValue, context: { recipient: phone }, requestId: privateValue,
    });
  } }));
  const result = await adapter.sendMessage(phone, 'Reply', () => true, replyOptions);
  assert.equal(result.status, 'unknown'); assert.equal(counts.reply, 1);
  assert.equal(counts.dm + counts.plain, 0); assert.match(result.detail, /message\.reply/);
  assert.equal(result.detail.includes(privateValue), false); assert.equal(result.detail.includes(phone), false);
  assert.equal(result.detail.includes('12345678'), false);
});

test('the actual generic rate-limit response is explained without claiming non-delivery or retrying it', async () => {
  const { adapter, counts, space } = transport();
  const privateValue = 'private-quota-payload';
  space.send = async () => {
    counts.plain++;
    throw Object.assign(new Error(`${phone} ${privateValue}`), {
      name: 'RateLimitError', code: 'internalError', grpcCode: 8, retryable: false,
      context: { recipient: phone, token: privateValue },
    });
  };
  const result = await adapter.sendMessage(phone, 'Alert');
  assert.equal(result.status, 'unknown'); assert.equal(result.messageId, undefined);
  assert.equal(counts.plain, 1); assert.equal(counts.reply, 0);
  assert.match(result.detail, /rate\/resource limit after submission; outcome unknown/);
  assert.match(result.detail, /Pace new messages and reconcile this attempt before retry/);
  assert.match(result.detail, /gRPC 8 RESOURCE_EXHAUSTED/);
  assert.match(adapter.status().detail, /rate\/resource limit/);
  assert.equal(result.detail.includes(phone), false); assert.equal(result.detail.includes(privateValue), false);
});

test('native reply RESOURCE_EXHAUSTED preserves unknown outcome and never falls back to a DM', async () => {
  const { adapter, counts } = transport(inbound({ reply: async () => {
    counts.reply++;
    throw Object.assign(new Error('Opaque service payload'), { name: 'IMessageError', code: 'internalError', grpcCode: 8 });
  } }));
  const result = await adapter.sendMessage(phone, 'Recorded allergy context', () => true, replyOptions);
  assert.equal(result.status, 'unknown'); assert.equal(counts.reply, 1);
  assert.equal(counts.dm + counts.plain, 0); assert.match(result.detail, /rate\/resource limit/);
  assert.match(result.detail, /message\.reply/); assert.equal(result.detail.includes('Opaque service payload'), false);
});

test('observed contact warm-up error exposes only its bounded counters and inbound requirement while preserving UNKNOWN', async () => {
  const { adapter, counts, space } = transport();
  const privateValue = 'private-recipient-token';
  space.send = async () => {
    counts.plain++;
    throw Object.assign(new Error('[upstream] New contact has sent 2 of 3 messages; replies are limited to 10 until they respond'), {
      name: 'RateLimitError', code: 'internalError', grpcCode: 8, retryable: false,
      context: { recipient: phone, token: privateValue }, requestId: privateValue,
    });
  };
  const result = await adapter.sendMessage(phone, 'New labelled test');
  assert.equal(result.status, 'unknown'); assert.equal(result.messageId, undefined);
  assert.equal(counts.plain, 1); assert.equal(counts.reply, 0);
  assert.match(result.detail, /contact warm-up restriction after submission; outcome unknown/);
  assert.match(result.detail, /Contact messages 2\/3; reply allowance 10/);
  assert.match(result.detail, /A new inbound reply is required; reconcile this attempt before retry/);
  assert.match(result.detail, /space\.send.*gRPC 8 RESOURCE_EXHAUSTED/);
  assert.equal(adapter.status().detail, result.detail);
  assert.ok(!result.detail.includes('Pace new messages'));
  assert.ok(!result.detail.includes(phone) && !result.detail.includes(privateValue) && !result.detail.includes('[upstream]'));
});

test('arbitrary or malformed warm-up-like payloads remain redacted generic errors with no new retry or fallback', async () => {
  for (const message of [
    `[upstream] New contact has sent 2 of 3 messages; replies are limited to 10 until they respond ${phone} private-secret`,
    'New contact has sent 2 of 3 messages; replies are limited to 10 until they respond',
    '[upstream] New contact has sent 15551234567 of 3 messages; replies are limited to 10 until they respond',
    '[upstream] New contact has sent 2 of 0 messages; replies are limited to 10 until they respond',
    '[upstream] New contact has sent 2 of 3 messages; replies are limited to 15551234567 until they respond',
  ]) {
    const { adapter, counts } = transport(inbound({ reply: async () => {
      counts.reply++;
      throw Object.assign(new Error(message), { name: 'RateLimitError', code: 'internalError', grpcCode: 8, retryable: false });
    } }));
    const result = await adapter.sendMessage(phone, 'Reply', () => true, replyOptions);
    assert.equal(result.status, 'unknown'); assert.equal(counts.reply, 1);
    assert.equal(counts.dm + counts.plain, 0);
    assert.match(result.detail, /rate\/resource limit/); assert.match(result.detail, /message\.reply/);
    assert.ok(!result.detail.includes('Contact messages') && !result.detail.includes('private-secret') && !result.detail.includes(phone));
  }
});
