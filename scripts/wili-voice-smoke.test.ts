import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import { handleResponderRelay } from '../src/responder-relay.ts';
import { parseVoiceSmokeArgs, recordSmokeOutbox, verifySmokeWearerReply } from './wili-voice-smoke.ts';
import { matchingStockCheckin, stockContextToDeliver } from '../native/freewili/stock-bridge.ts';
import type { WiliIncidentContext } from '../native/freewili/protocol.ts';

test('asset setup cannot replay an expired check-in, while latest help context remains deliverable', () => {
  const checking: WiliIncidentContext = { type: 'incident.context', sessionId: 'offline-boot', incidentId: 'LF-OFFLINE',
    checkinId: 'offline-checkin', phase: 'CONFIRMING', checkinDeadline: 21000, serverTime: 1000,
    ownerName: null, statusText: 'Offline startup timing fixture', voiceAsset: 'CHECKIN' };
  assert.equal(stockContextToDeliver(checking, false, 1000), null);
  assert.equal(stockContextToDeliver(checking, true, 21000), null);
  const latest: WiliIncidentContext = { ...checking, phase: 'HELP_REQUESTED', serverTime: 21000, voiceAsset: 'HELP' };
  assert.equal(stockContextToDeliver(latest, false, 22000), null);
  assert.equal(stockContextToDeliver(latest, true, 22000), latest);
  assert.equal(checking.checkinDeadline, 21000);
});

test('spoken safe acknowledgement requires current identity and original unexpired deadline', () => {
  const checking: WiliIncidentContext = { type: 'incident.context', sessionId: 'offline-boot', incidentId: 'LF-OFFLINE',
    checkinId: 'offline-checkin', phase: 'CONFIRMING', checkinDeadline: 21000, serverTime: 1000,
    ownerName: null, statusText: 'Offline deadline fixture', voiceAsset: 'CHECKIN' };
  assert.equal(matchingStockCheckin(checking, checking, 20999), true);
  assert.equal(matchingStockCheckin(checking, checking, 21000), false);
  assert.equal(matchingStockCheckin(checking, { incidentId: checking.incidentId, checkinId: 'old-checkin' }, 2000), false);
  assert.equal(matchingStockCheckin({ ...checking, phase: 'HELP_REQUESTED' }, checking, 2000), false);
});

test('physical voice smoke requires explicit port, finite bounds and explicit safe output device', () => {
  const options = parseVoiceSmokeArgs(['--port', '/dev/cu.synthetic-test', '--audio-device', '117', '--timeout-ms', '60000']);
  assert.equal(options.port, '/dev/cu.synthetic-test'); assert.equal(options.audioDevice, '117'); assert.equal(options.timeoutMs, 60000);
  assert.equal(parseVoiceSmokeArgs(['--port', '/dev/cu.synthetic-test']).audioDevice, 'MacBook Pro Speakers');
  assert.equal(parseVoiceSmokeArgs(['--port', '/dev/cu.synthetic-test']).checkinMs, 20000);
  assert.equal(parseVoiceSmokeArgs(['--port', '/dev/cu.synthetic-test', '--checkin-ms', '45000']).checkinMs, 45000);
  for (const args of [[], ['--port', 'auto'], ['--port', '/dev/cu.synthetic-test', '--timeout-ms', 'Infinity'],
    ['--port', '/dev/cu.synthetic-test', '--timeout-ms', '1000'], ['--port', '/dev/cu.synthetic-test', '--backend', 'http://production'],
    ['--port', '/dev/cu.synthetic-test', '--audio-device', '117\n'], ['--port', '/dev/cu.synthetic-test', '--checkin-ms', '5000'],
    ['--port', '/dev/cu.synthetic-test', '--port', '/dev/cu.other']])
    assert.throws(() => parseVoiceSmokeArgs(args));
});

test('recording transport captures exact quote and supplies isolated authorization without establishing responder ownership', () => {
  const responder = { id: 'smoke-responder', name: 'Smoke responder', phone: '+12025550101' };
  const controller = new Controller(':memory:', [responder], () => 1000);
  const records: Parameters<typeof recordSmokeOutbox>[1] = [];
  try {
    const incident = controller.trigger({ kind: 'synthetic', summary: 'Offline harness guard fixture, no physical voice or STT claimed.' });
    recordSmokeOutbox(controller, records);
    const transcript = "My ankle hurts. I can't stand up.";
    const decision = controller.recordCheckinReply({ incidentId: incident.id, checkinId: incident.checkinId,
      transcript, source: 'freewili-local-speech' });
    recordSmokeOutbox(controller, records);
    const quote = verifySmokeWearerReply(transcript, decision, records);
    assert.equal(quote.action.type, 'wearer_relay'); assert.match(quote.messageId, /^smoke-recorded-/);
    assert.equal(controller.actions(incident.id).find(a => a.id === quote.action.id)?.providerChatId, 'isolated-smoke-chat');
    assert.equal(handleResponderRelay({ messageId: 'synthetic-responder-fixture', sender: responder.phone,
      kind: 'text', text: 'Synthetic smoke-test reply: stay seated. I am coming now.', targetMessageId: quote.messageId,
      chatId: quote.chatId, lineId: quote.lineId }, controller), true);
    assert.equal(controller.active()?.ownerId, null);
    assert.equal(controller.claimResponderSpeech('offline-worker-boot')?.speakerName, 'Smoke responder');
    assert.equal(handleResponderRelay({ messageId: 'wrong-channel-fixture', sender: responder.phone,
      kind: 'text', text: 'Stay seated.', targetMessageId: quote.messageId, chatId: 'wrong-chat', lineId: quote.lineId }, controller), false);
  } finally { controller.close(); }
});

test('smoke guard fails ambiguous, wrong acoustic statement and absent exact quote instead of declaring a pass', () => {
  assert.throws(() => verifySmokeWearerReply('My ankle hurts.', 'unresolved', []), /did not request help/);
  assert.throws(() => verifySmokeWearerReply("I can't get up.", 'help_requested', []), /ankle statement/);
  assert.throws(() => verifySmokeWearerReply("My ankle hurts. I can't stand up.", 'help_requested', []), /quote/);
});
