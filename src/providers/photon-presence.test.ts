import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotonAdapter } from './photon.ts';
import type { PhotonClient, PhotonMessage, PhotonSpace } from './photon.ts';

const phone = '+15551234567';
const chatId = `any;-;${phone}`;
const lineId = '+15557654321';
const spaceIdentity = { id: chatId, phone: lineId, type: 'dm' };
const replyOptions = { replyToMessageId: 'incoming-question', chatId, lineId };
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(options: { typingMs?: number; startTyping?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const target: PhotonMessage = { id: replyOptions.replyToMessageId, platform: 'imessage', direction: 'inbound',
    sender: { id: phone }, space: spaceIdentity, content: { type: 'text', text: 'What allergies are recorded?' },
    read: async () => { log.push('read'); },
    reply: async () => { log.push('reply'); return { id: 'native-reply', space: spaceIdentity }; } };
  const space: PhotonSpace = { ...spaceIdentity,
    getMessage: async () => target,
    send: async () => { log.push('send'); return { id: 'plain-send', space: spaceIdentity }; },
    startTyping: options.startTyping ?? (async () => { log.push('typing:start'); }),
    stopTyping: async () => { log.push('typing:stop'); } };
  const client: PhotonClient = { messages: (async function* () {})(), stop: async () => {},
    openDm: async () => space, openSpace: async () => space };
  const adapter = createPhotonAdapter({ projectId: 'offline', projectSecret: 'offline', timeoutMs: 200,
    typingMs: options.typingMs ?? 20, factory: async () => client });
  return { adapter, log };
}

test('conversational replies mark the question read and show typing before answering', async () => {
  const { adapter, log } = setup();
  const result = await adapter.sendMessage(phone, 'Recorded allergy context', undefined, replyOptions);
  await settle();
  assert.equal(result.status, 'provider_accepted');
  assert.ok(log.indexOf('read') >= 0 && log.indexOf('read') < log.indexOf('reply'));
  assert.ok(log.indexOf('typing:start') >= 0 && log.indexOf('typing:start') < log.indexOf('reply'));
  assert.ok(log.indexOf('typing:stop') > log.indexOf('reply'));
});

test('alerts and check-ins send immediately with no presence signals', async () => {
  const { adapter, log } = setup();
  const result = await adapter.sendMessage(phone, 'LIFELINE alert');
  await settle();
  assert.equal(result.status, 'provider_accepted');
  assert.deepEqual(log, ['send']);
});

test('a failing typing indicator never blocks the reply', async () => {
  const { adapter, log } = setup({ startTyping: async () => { throw new Error('unsupported on this service'); } });
  const result = await adapter.sendMessage(phone, 'Recorded allergy context', undefined, replyOptions);
  await settle();
  assert.equal(result.status, 'provider_accepted');
  assert.ok(log.includes('reply'));
  assert.ok(!log.includes('typing:stop'));
});

test('authorization ending during the typing pause cancels the reply and clears typing', async () => {
  let allowed = true;
  const holder: { log?: string[] } = {};
  const { adapter, log } = setup({ typingMs: 20, startTyping: async () => { holder.log!.push('typing:start'); allowed = false; } });
  holder.log = log;
  const result = await adapter.sendMessage(phone, 'Recorded allergy context', () => allowed, replyOptions);
  await settle();
  assert.equal(result.status, 'cancelled');
  assert.ok(!log.includes('reply'));
  assert.ok(log.includes('typing:stop'));
});

test('typingMs 0 disables read receipts and typing entirely', async () => {
  const { adapter, log } = setup({ typingMs: 0 });
  const result = await adapter.sendMessage(phone, 'Recorded allergy context', undefined, replyOptions);
  await settle();
  assert.equal(result.status, 'provider_accepted');
  assert.deepEqual(log, ['reply']);
});

test('the listener marks inbound texts read on arrival, but not reactions', async () => {
  const reads: string[] = [];
  const message = (id: string, content: unknown): PhotonMessage => ({ id, platform: 'imessage', direction: 'inbound',
    sender: { id: phone }, space: spaceIdentity, content, read: async () => { reads.push(id); } });
  const client: PhotonClient = {
    messages: (async function* () {
      yield [undefined, message('text-1', { type: 'text', text: 'my ankle hurts' })] as const;
      yield [undefined, message('like-1', { type: 'reaction', emoji: '👍', target: { id: 'alert' } })] as const;
    })(),
    openDm: async () => undefined, stop: async () => {},
  };
  const adapter = createPhotonAdapter({ projectId: 'mock', projectSecret: 'mock', typingMs: 20, factory: async () => client });
  const events: string[] = [];
  const stop = await adapter.startPhotonListener(async event => { events.push(event.messageId); });
  await settle(); await settle();
  assert.deepEqual(events, ['text-1', 'like-1']);
  assert.deepEqual(reads, ['text-1']);
  await stop();
});
