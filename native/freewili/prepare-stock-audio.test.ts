import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcm16Wav, readMonoPcm16Wav } from './audio.ts';
import { DEFAULT_ELEVENLABS_MODEL_ID, DEFAULT_ELEVENLABS_VOICE_ID, prepareStockAudio, readStockVoiceManifest, STOCK_VOICE_PROMPTS, stockVoiceSelection } from './prepare-stock-audio.ts';
import type { StockVoiceAsset, StockVoiceName } from './prepare-stock-audio.ts';

const names = Object.keys(STOCK_VOICE_PROMPTS);
const env = { ELEVENLABS_API_KEY: 'offline-test-key' };
const mp3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00offline-fixture');
const wav = pcm16Wav(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]), 8000);
const convert = async (encoded: Buffer) => { assert.deepEqual(encoded, mp3); return wav; };
const localOptions = { env, provider: 'local' as const, localSpeech: async () => wav, convert: async (audio: Buffer) => audio };
function speechResponse() { return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }); }
async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lifeline-preparer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'assets');
}
async function files(directory: string): Promise<Buffer[]> {
  return Promise.all(['manifest.json', ...names.map(name => `${name}.WAV`)].map(name => readFile(join(directory, name))));
}

test('stock voice defaults and explicit overrides are shared without API credentials', () => {
  assert.deepEqual(stockVoiceSelection({}), { voiceId: DEFAULT_ELEVENLABS_VOICE_ID, modelId: DEFAULT_ELEVENLABS_MODEL_ID });
  assert.deepEqual(stockVoiceSelection({ ELEVENLABS_VOICE_ID: ' custom_voice ', ELEVENLABS_MODEL_ID: ' eleven_flash_v2_5 ' }),
    { voiceId: 'custom_voice', modelId: 'eleven_flash_v2_5' });
  assert.throws(() => stockVoiceSelection({ ELEVENLABS_VOICE_ID: '../unsafe' }), /configuration/);
});

test('seven offline ElevenLabs requests produce verified canonical assets and a complete cache skips all requests', async t => {
  const directory = await temporary(t), requested: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`);
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('xi-api-key'), env.ELEVENLABS_API_KEY);
    assert.equal(headers.get('accept'), 'audio/mpeg');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model_id, DEFAULT_ELEVENLABS_MODEL_ID); requested.push(body.text);
    return speechResponse();
  };
  const result = await prepareStockAudio(directory, { provider: 'elevenlabs', env, fetch: fetcher, convert });
  assert.equal(result.cached, false); assert.deepEqual(requested, Object.values(STOCK_VOICE_PROMPTS));
  const manifest = await readStockVoiceManifest(directory);
  assert.deepEqual(manifest, result.manifest); assert.equal(manifest!.provider, 'elevenlabs');
  assert.equal(manifest!.source, 'ElevenLabs'); assert.equal(manifest!.schemaVersion, 2);
  assert.equal(JSON.stringify(manifest).includes(env.ELEVENLABS_API_KEY), false);
  for (const name of names) {
    const audio = await readFile(join(directory, `${name}.WAV`));
    assert.equal(audio.length, 44 + readMonoPcm16Wav(audio).pcm.length);
    const asset: StockVoiceAsset = manifest!.assets[name as StockVoiceName];
    assert.equal(asset.sha256, createHash('sha256').update(audio).digest('hex'));
    assert.equal(asset.bytes, audio.length); assert.equal(asset.durationMs, 0.5);
  }
  const reused = await prepareStockAudio(directory, { provider: 'elevenlabs', env: {}, fetch: async () => { throw new Error('Must not send.'); } });
  assert.equal(reused.cached, true); assert.deepEqual(reused.manifest, manifest);
});

test('explicit local fallback has separate truthful provenance even with an ElevenLabs key present', async t => {
  const directory = await temporary(t); let generated = 0;
  const result = await prepareStockAudio(directory, { ...localOptions, localSpeech: async text => {
    generated++; assert.ok(Object.values(STOCK_VOICE_PROMPTS).includes(text as typeof STOCK_VOICE_PROMPTS.CHECKIN)); return wav;
  }, fetch: async () => { throw new Error('Local mode must not send.'); } });
  assert.equal(generated, 7); assert.equal(result.manifest.provider, 'local');
  assert.equal(result.manifest.source, 'macOS local speech'); assert.equal(result.manifest.voiceId, 'Samantha');
  assert.match(result.manifest.prompts.ACCEPTED, /not reported leaving/);
  assert.equal((await prepareStockAudio(directory, { provider: 'local', localSpeech: async () => { throw new Error('Must use cache.'); } })).cached, true);
});

test('partial provider failure preserves the complete prior set; retry reuses only verified completed clips', async t => {
  const directory = await temporary(t);
  await prepareStockAudio(directory, localOptions); const before = await files(directory);
  let requests = 0;
  await assert.rejects(prepareStockAudio(directory, { provider: 'elevenlabs', env, convert, fetch: async () => {
    requests++; return requests === 3 ? new Response('private upstream error', { status: 503 }) : speechResponse();
  } }), /existing voice assets were preserved/);
  assert.equal(requests, 3); assert.deepEqual(await files(directory), before);
  assert.equal((await readStockVoiceManifest(directory))!.provider, 'local');
  requests = 0;
  const complete = await prepareStockAudio(directory, { provider: 'elevenlabs', env, convert, fetch: async () => { requests++; return speechResponse(); } });
  assert.equal(requests, 5); assert.equal(complete.manifest.provider, 'elevenlabs');
  assert.deepEqual(await readdir(join(directory, '..')), ['assets', 'assets.cache']);
});

test('voice/model changes invalidate paid-input cache; returning to the previous selection reuses its complete artifacts', async t => {
  const directory = await temporary(t); let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return speechResponse(); };
  const original = await prepareStockAudio(directory, { provider: 'elevenlabs', env, fetch: fetcher, convert });
  assert.equal(requests, 7);
  const changed = await prepareStockAudio(directory, { provider: 'elevenlabs', env: { ...env, ELEVENLABS_VOICE_ID: 'other_voice', ELEVENLABS_MODEL_ID: 'other_model' }, fetch: fetcher, convert });
  assert.equal(requests, 14); assert.notEqual(changed.manifest.assets.CHECKIN.cacheKey, original.manifest.assets.CHECKIN.cacheKey);
  await prepareStockAudio(directory, { provider: 'elevenlabs', env, fetch: fetcher, convert });
  assert.equal(requests, 14);
});

test('a corrupt or missing active clip cannot be treated as a complete cache, even when its private artifact can repair it offline', async t => {
  const directory = await temporary(t);
  await prepareStockAudio(directory, localOptions);
  const corrupt = Buffer.from(wav); corrupt[44] ^= 1;
  await writeFile(join(directory, 'CHECKIN.WAV'), corrupt);
  await rm(join(directory, 'ARRIVED.WAV'));
  assert.equal(await readStockVoiceManifest(directory), null);
  const repaired = await prepareStockAudio(directory, { provider: 'local', localSpeech: async () => { throw new Error('Verified private clips should repair offline.'); } });
  assert.equal(repaired.cached, false); assert.deepEqual(await readFile(join(directory, 'CHECKIN.WAV')), wav);
  assert.deepEqual(await readStockVoiceManifest(directory), repaired.manifest);
  const changed = structuredClone(repaired.manifest); changed.prompts.CHECKIN = 'A different prompt.';
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(changed));
  assert.equal(await readStockVoiceManifest(directory), null);
});

test('missing credentials and malformed/oversized provider audio never replace prior assets or claim ElevenLabs success', async t => {
  const directory = await temporary(t);
  await prepareStockAudio(directory, localOptions); const before = await files(directory);
  await assert.rejects(prepareStockAudio(directory, { provider: 'elevenlabs', env: {}, fetch: async () => { throw new Error('Must not send without a key.'); } }), /ELEVENLABS_API_KEY/);
  const responses = [
    () => new Response('upstream error', { status: 401, headers: { 'content-type': 'audio/mpeg' } }),
    () => new Response('not audio', { headers: { 'content-type': 'application/json' } }),
    () => new Response('not mp3', { headers: { 'content-type': 'audio/mpeg' } }),
    () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(6 * 1024 * 1024) } }),
    () => new Response(Buffer.alloc(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'audio/mpeg' } }),
  ];
  for (const response of responses) {
    let conversions = 0;
    await assert.rejects(prepareStockAudio(directory, { provider: 'elevenlabs', env, fetch: async () => response(), convert: async () => { conversions++; return wav; } }), /speech generation failed/);
    assert.equal(conversions, 0); assert.deepEqual(await files(directory), before);
  }
  await assert.rejects(prepareStockAudio(directory, { provider: 'elevenlabs', env, fetch: async () => speechResponse(), convert: async () => pcm16Wav(Buffer.from([1, 0]), 16000) }), /canonical 8 kHz/);
  assert.deepEqual(await files(directory), before);
});
