import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { pcm16Wav } from './audio.ts';
import { ConversationAudioQueue, prepareConversationAudio } from './conversation-audio.ts';
import { WiliDeviceProtocol, validHostPacket, validDevicePacket } from './protocol.ts';
import type { ConversationAsset } from './conversation-audio.ts';
import type { WiliConversationSpeak, WiliIncidentContext, WiliVoicePlayback } from './protocol.ts';

const packet = (eventId = 'responder-1'): WiliConversationSpeak => ({ type: 'conversation.speak', sessionId: 'stock-boot',
  eventId, incidentId: 'LF-TEST', speakerName: 'Maya', text: "Stay seated.\n\tI’m coming now.\r\nCan you reach your water?" });
const context = (phase = 'HELP_REQUESTED', incidentId: string | null = 'LF-TEST'): WiliIncidentContext => ({
  type: 'incident.context', sessionId: 'stock-boot', incidentId, checkinId: incidentId ? 'checkin-1' : null,
  phase: incidentId ? phase : null, checkinDeadline: null, serverTime: 1 });
const status = (p: WiliConversationSpeak, state: WiliVoicePlayback['status']): WiliVoicePlayback => ({
  type: 'voice.playback', source: 'body-wili', sessionId: p.sessionId, eventId: p.eventId, incidentId: p.incidentId, status: state });

test('responder speech preserves multiline text and uses configured ElevenLabs delivery with private canonical WAV', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-offline-conversation-'));
  try {
    const p = packet(), calls: { url: string; body: unknown }[] = [];
    const asset = await prepareConversationAudio(p, directory, {
      env: { ELEVENLABS_API_KEY: 'offline-key', ELEVENLABS_VOICE_ID: 'configuredVoice', ELEVENLABS_MODEL_ID: 'configured_model', ELEVENLABS_SPEED: '.9' },
      fetch: (async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
        assert.equal(options?.redirect, 'error'); assert.ok(options?.signal);
        return new Response(Buffer.from('ID3offline-audio'), { headers: { 'content-type': 'audio/mpeg' } });
      }) as typeof fetch,
      convert: async () => pcm16Wav(Buffer.alloc(1600), 8000),
    });
    assert.match(asset.filename, /^[A-F0-9]{8}\.WAV$/);
    assert.match(calls[0]!.url, /configuredVoice\?output_format=mp3_44100_128$/);
    assert.deepEqual(calls[0]!.body, { text: `Maya says: ${p.text}`, model_id: 'configured_model', voice_settings: { speed: .9 } });
    assert.equal((await stat(join(directory, asset.filename))).mode & 0o077, 0);
    assert.equal((await readFile(join(directory, asset.filename))).toString('ascii', 36, 40), 'data');
    await asset.dispose(); assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing credentials, provider failure, cancellation and oversized clips never fall back or leave files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-offline-conversation-'));
  try {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response('unavailable', { status: 503 }); }) as typeof fetch;
    await assert.rejects(prepareConversationAudio(packet(), directory, { env: {}, fetch: fetcher }), /unavailable/);
    assert.equal(calls, 0);
    await assert.rejects(prepareConversationAudio(packet(), directory, { env: { ELEVENLABS_API_KEY: 'offline' }, fetch: fetcher }), /generation failed/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(prepareConversationAudio(packet(), directory, { env: { ELEVENLABS_API_KEY: 'offline' }, fetch: fetcher, signal: aborted.signal }));
    assert.equal(calls, 1);
    const oversized = Buffer.concat([pcm16Wav(Buffer.alloc(240000), 8000), Buffer.alloc(2)]);
    oversized.writeUInt32LE(oversized.length - 8, 4); oversized.writeUInt32LE(240002, 40);
    await assert.rejects(prepareConversationAudio(packet(), directory, { env: { ELEVENLABS_API_KEY: 'offline' },
      fetch: (async () => new Response(Buffer.from('ID3offline-audio'), { headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch,
      convert: async () => oversized }), /oversized/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('strict wire validation allows only normal message separators and ordered correlated playback statuses', () => {
  assert.equal(validHostPacket(packet()), true);
  assert.equal(validHostPacket({ ...packet(), text: 'hello\u0000' }), false);
  assert.equal(validHostPacket({ ...packet(), speakerName: 'Maya\n' }), false);
  assert.equal(validHostPacket({ ...packet(), text: 'a'.repeat(501) }), false);
  assert.equal(validHostPacket({ ...packet(), arbitrary: true }), false);
  const protocol = new WiliDeviceProtocol();
  protocol.accept({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId: 'stock-boot', deviceModel: 'freewili-og',
    fullScaleG: 2, transport: 'stock-sdk', capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } });
  assert.throws(() => protocol.accept(status(packet(), 'playing')), /out of order/);
  protocol.accept(status(packet(), 'queued'));
  assert.throws(() => protocol.accept({ ...status(packet(), 'playing'), incidentId: 'wrong' }), /uncorrelated/);
  protocol.accept(status(packet(), 'playing')); protocol.accept(status(packet(), 'spoken'));
  assert.throws(() => protocol.accept(status(packet(), 'spoken')), /repeated/);
  assert.equal(validDevicePacket({ ...status(packet(), 'queued'), text: 'not a status field' }), false);
});

test('queue dedupes speech, serializes delivery, and discards terminal or replaced incident work', async () => {
  const statuses: WiliVoicePlayback[] = [], dispatches: string[] = [], disposed: string[] = [];
  const prepared: string[] = [];
  const queue = new ConversationAudioQueue({
    prepare: async p => { prepared.push(p.eventId); return { filename: '1234ABCD.WAV', dispose: async () => { disposed.push(p.eventId); } }; },
    dispatch: p => { dispatches.push(p.eventId); }, status: p => statuses.push(p),
  });
  queue.updateContext(context()); queue.enqueue(packet()); queue.enqueue(packet()); queue.enqueue(packet('second'));
  await setImmediate();
  assert.deepEqual(prepared, ['responder-1']); assert.deepEqual(dispatches, ['responder-1']);
  queue.playback(status(packet(), 'playing'));
  queue.updateContext(context('RESOLVED'));
  assert.ok(statuses.some(p => p.eventId === 'second' && p.status === 'failed'));
  assert.throws(() => queue.playback(status(packet('wrong'), 'spoken')), /Uncorrelated/);
  queue.playback(status(packet(), 'failed')); await setImmediate();
  assert.deepEqual(prepared, ['responder-1']); assert.deepEqual(disposed, ['responder-1']);
  queue.updateContext(context('HELP_REQUESTED', 'LF-REPLACED'));
  queue.enqueue(packet('stale')); assert.equal(statuses.at(-1)?.status, 'failed');
  await queue.stop();
});

test('context change aborts in-flight synthesis before dispatch and cleans its late result', async () => {
  let finish!: (asset: ConversationAsset) => void, signal: AbortSignal | undefined;
  const statuses: WiliVoicePlayback[] = [], dispatches: string[] = [], disposed: string[] = [];
  const queue = new ConversationAudioQueue({
    prepare: (_p, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); },
    dispatch: p => { dispatches.push(p.eventId); }, status: p => statuses.push(p),
  });
  queue.updateContext(context()); queue.enqueue(packet());
  queue.updateContext({ ...context(), sessionId: 'new-boot' }); assert.equal(signal?.aborted, true);
  finish({ filename: '1234ABCD.WAV', dispose: async () => { disposed.push('cleaned'); } });
  await setImmediate(); assert.deepEqual(dispatches, []); assert.deepEqual(disposed, ['cleaned']);
  assert.deepEqual(statuses.map(p => p.status), ['queued', 'failed']); await queue.stop();
});
