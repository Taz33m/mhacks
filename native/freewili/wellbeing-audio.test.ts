import test from 'node:test';
import assert from 'node:assert/strict';
import { pcm16Wav } from './audio.ts';
import { decodeStockWellbeingUtterance, matchingStockWellbeing, recognizeCurrentWellbeing } from './wellbeing-audio.ts';
import { WiliDeviceProtocol, WiliNdjson, validDevicePacket, validHostPacket } from './protocol.ts';
import type { WiliIncidentContext, WiliWellbeingContext } from './protocol.ts';

const wellbeing: WiliWellbeingContext = { type: 'wellbeing.context', sessionId: 'boot-1', conversationId: 'conversation-1', enabled: true, statusText: 'How are you feeling?' };
const incident = (phase: string | null): WiliIncidentContext => ({ type: 'incident.context', sessionId: 'boot-1',
  incidentId: phase ? 'incident-1' : null, checkinId: phase ? 'checkin-1' : null, phase, checkinDeadline: null, serverTime: 1000 });
const utterance = (durationMs = 100) => ({ type: 'stock.wellbeing-utterance', source: 'body-wili', sessionId: 'boot-1',
  eventId: 'audio-1', conversationId: 'conversation-1', format: 'wav', sampleRate: 8000,
  audioBase64: pcm16Wav(Buffer.alloc(16 * durationMs, 1), 8000).toString('base64'), durationMs, receivedAtMs: 2000 });
const hello = (microphone = true) => ({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId: 'boot-1',
  deviceModel: 'freewili-og', fullScaleG: 2, transport: 'stock-sdk',
  capabilities: { accelerometer: true, buttons: true, microphone, speaker: true } });

test('wellbeing wire packets have exact bounded identities and microphone capability/dedupe', () => {
  const reply = { type: 'wellbeing.reply', source: 'body-wili', sessionId: 'boot-1', eventId: 'reply-1',
    conversationId: 'conversation-1', transcript: 'I am okay.\nI had breakfast.' };
  const audio = { type: 'wellbeing.audio', source: 'body-wili', sessionId: 'boot-1', eventId: 'stage-1', conversationId: 'conversation-1', stage: 'recording' };
  assert.equal(validHostPacket(wellbeing), true); assert.equal(validDevicePacket(reply), true); assert.equal(validDevicePacket(audio), true);
  for (const packet of [{ ...wellbeing, enabled: 'true' }, { ...wellbeing, statusText: 'x'.repeat(301) },
    { ...wellbeing, conversationId: '../unsafe' }, { ...wellbeing, statusText: 'bad\0' }, { ...wellbeing, extra: true }])
    assert.equal(validHostPacket(packet), false);
  for (const packet of [{ ...reply, transcript: ' ' }, { ...reply, transcript: 'x'.repeat(501) }, { ...reply, transcript: '\0' },
    { ...reply, source: 'waist-airpod' }, { ...reply, incidentId: 'incident-1' }, { ...audio, stage: 'sent' }])
    assert.equal(validDevicePacket(packet), false);
  const protocol = new WiliDeviceProtocol(); protocol.accept(hello()); protocol.accept(reply); protocol.accept(audio);
  assert.throws(() => protocol.accept(reply), /Repeated WILi event ID/);
  assert.throws(() => protocol.accept({ ...audio, eventId: 'stage-2', sessionId: 'stale-session' }));
  const unavailable = new WiliDeviceProtocol(); unavailable.accept(hello(false));
  assert.throws(() => unavailable.accept(reply), /microphone/i); assert.throws(() => unavailable.accept(audio), /microphone/i);
});

test('wellbeing is available only for current enabled boot/conversation outside an active incident', () => {
  assert.equal(matchingStockWellbeing(wellbeing, null, utterance()), true);
  for (const phase of [null, 'RESOLVED', 'CANCELLED_FALSE_ALARM']) assert.equal(matchingStockWellbeing(wellbeing, incident(phase), utterance()), true);
  for (const phase of ['DETECTED', 'CONFIRMING', 'HELP_REQUESTED', 'ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE'])
    assert.equal(matchingStockWellbeing(wellbeing, incident(phase), utterance()), false);
  for (const context of [null, { ...wellbeing, enabled: false }, { ...wellbeing, sessionId: 'boot-2' }, { ...wellbeing, conversationId: 'conversation-2' }])
    assert.equal(matchingStockWellbeing(context, null, utterance()), false);
});

test('15s worker envelope fits its deliberate local bound and rejects malformed or fabricated duration', () => {
  const packet = utterance(15000), encoded = Buffer.from(JSON.stringify(packet) + '\n');
  assert.ok(encoded.length < 400000); assert.ok(encoded.length > 140000);
  const decoder = new WiliNdjson(400000);
  assert.deepEqual(decoder.push(encoded.subarray(0, 16384)), []);
  assert.deepEqual(decoder.push(encoded.subarray(16384)), [packet]); decoder.finish();
  const decoded = decodeStockWellbeingUtterance(packet); assert.equal(decoded.wav.length, 240044); decoded.wav.fill(0);
  for (const invalid of [{ ...packet, durationMs: 15001 }, { ...packet, durationMs: NaN }, { ...packet, durationMs: 100 },
    { ...packet, receivedAtMs: Infinity }, { ...packet, audioBase64: 'A'.repeat(320104) }, { ...packet, audioBase64: '????' },
    { ...packet, audioBase64: Buffer.from('not WAV').toString('base64') }, { ...packet, extra: true }, { ...packet, sessionId: '../bad' }])
    assert.throws(() => decodeStockWellbeingUtterance(invalid));
});

test('recognition checks identity before and after actual asynchronous work and wipes raw audio', async () => {
  const packet = utterance();
  for (const change of ['none', 'disabled', 'conversation', 'session', 'incident', 'aborted']) {
    let currentWellbeing: WiliWellbeingContext | null = wellbeing, currentIncident: WiliIncidentContext | null = null;
    let captured: Buffer | null = null, started = 0;
    const abort = new AbortController();
    const result = await recognizeCurrentWellbeing(packet, () => ({ wellbeing: currentWellbeing, incident: currentIncident }), {
      signal: abort.signal, onStart: () => { started++; }, recognize: async (wav, options) => {
        captured = wav; assert.equal(options.maxDurationMs, 15000);
        if (change === 'disabled') currentWellbeing = { ...wellbeing, enabled: false };
        if (change === 'conversation') currentWellbeing = { ...wellbeing, conversationId: 'conversation-2' };
        if (change === 'session') currentWellbeing = { ...wellbeing, sessionId: 'boot-2' };
        if (change === 'incident') currentIncident = incident('CONFIRMING');
        if (change === 'aborted') abort.abort();
        return { status: 'transcribed', transcript: 'I had breakfast.', source: 'freewili-og-microphone', engine: 'whisper.cpp' };
      },
    });
    assert.equal(started, 1); assert.equal(result?.status ?? null, change === 'none' ? 'transcribed' : null);
    assert.ok(captured); assert.ok((captured as Buffer).every(byte => byte === 0));
  }
  let calls = 0;
  const result = await recognizeCurrentWellbeing(packet, () => ({ wellbeing: { ...wellbeing, enabled: false }, incident: null }), {
    recognize: async () => { calls++; return { status: 'unavailable', detail: 'unused' }; },
  });
  assert.equal(result, null); assert.equal(calls, 0);
});
