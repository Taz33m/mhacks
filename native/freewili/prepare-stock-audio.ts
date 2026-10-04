import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { convertPreparedAudioToOgWav, readMonoPcm16Wav } from './audio.ts';

// Defaults from the official Create speech example. Account access is still required.
export const DEFAULT_ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';
export const DEFAULT_STOCK_ELEVENLABS_SPEED = 0.85;
export const STOCK_AUDIO_PREPARER_VERSION = 'og-canonical-pcm16-v3';
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const LOCAL_RATE = 160;
const defaultAudioDirectory = () => resolve(process.env.LIFELINE_WILI_AUDIO_DIR?.trim() || 'output/freewili-audio');
export const STOCK_VOICE_PROMPTS = {
  // Spoken to the patient only: calm, short, no backend narration. Names match the demo persona.
  CHECKIN: 'Morgan, do you need help?',
  HELP: 'I’m getting help for you now. Try to stay still.',
  ACCEPTED: 'Alexander has answered. I’m here with you.',
  ENROUTE: 'Alexander is on his way.',
  ARRIVED: 'Alexander is here.',
  RESOLVED: 'Take care, Morgan.',
  OKAY: 'Okay. If you don’t need help, press the green button.',
} as const;
export type StockVoiceName = keyof typeof STOCK_VOICE_PROMPTS;
export type StockVoiceProvider = 'local' | 'elevenlabs';
export interface StockVoiceAsset { cacheKey: string; sha256: string; bytes: number; durationMs: number }
export interface StockVoiceManifest {
  schemaVersion: 2;
  provider: StockVoiceProvider;
  source: 'ElevenLabs' | 'macOS local speech';
  voiceId: string;
  modelId: string;
  /** Board-only ElevenLabs delivery setting; local speech remains 160 words/minute. */
  speed: number | null;
  preparerVersion: string;
  generatedAt: string;
  sampleRate: 8000;
  channels: 1;
  encoding: 'PCM16';
  prompts: Record<StockVoiceName, string>;
  assets: Record<StockVoiceName, StockVoiceAsset>;
}
export function stockVoiceSelection(env: NodeJS.ProcessEnv = process.env): { voiceId: string; modelId: string } {
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_ELEVENLABS_MODEL_ID;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(voiceId) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(modelId))
    throw new Error('Invalid ElevenLabs voice or model configuration.');
  return { voiceId, modelId };
}
export function stockVoiceSpeed(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.ELEVENLABS_SPEED?.trim();
  const speed = value ? Number(value) : DEFAULT_STOCK_ELEVENLABS_SPEED;
  if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.2)
    throw new Error('ELEVENLABS_SPEED must be between 0.7 and 1.2. Existing assets were preserved.');
  return speed;
}
const names = Object.keys(STOCK_VOICE_PROMPTS) as StockVoiceName[];
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function cacheKey(provider: StockVoiceProvider, voiceId: string, modelId: string, text: string, speed: number | null): string {
  return sha256(JSON.stringify([STOCK_AUDIO_PREPARER_VERSION, provider, voiceId, modelId, text,
    provider === 'local' ? LOCAL_RATE : 'mp3_44100_128', speed, 8000, 1, 'PCM16']));
}
function assetMetadata(wav: Buffer, key: string): StockVoiceAsset {
  const parsed = readMonoPcm16Wav(wav);
  if (parsed.sampleRate !== 8000 || wav.length !== 44 + parsed.pcm.length || wav.toString('ascii', 36, 40) !== 'data')
    throw new Error('Expected canonical 8 kHz mono PCM16 WILi audio.');
  return { cacheKey: key, sha256: sha256(wav), bytes: wav.length, durationMs: parsed.durationMs };
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  if ((await stat(path)).size > limit) throw new Error('Cached audio exceeds its size bound.');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Cached audio exceeds its size bound.');
  return bytes;
}
async function verifiedAsset(path: string, expected: StockVoiceAsset, key: string): Promise<Buffer | null> {
  try {
    const wav = await boundedFile(path, MAX_AUDIO_BYTES), actual = assetMetadata(wav, key);
    return expected.cacheKey === key && expected.sha256 === actual.sha256 && expected.bytes === actual.bytes
      && expected.durationMs === actual.durationMs ? wav : null;
  } catch { return null; }
}
/** Disk generation evidence only; this cannot verify a board upload or audible playback. */
export async function readStockVoiceManifest(directory = defaultAudioDirectory()): Promise<StockVoiceManifest | null> {
  try {
    const m = JSON.parse((await boundedFile(join(directory, 'manifest.json'), 64 * 1024)).toString()) as StockVoiceManifest;
    if (m.schemaVersion !== 2 || !['local', 'elevenlabs'].includes(m.provider)
      || m.source !== (m.provider === 'local' ? 'macOS local speech' : 'ElevenLabs')
      || typeof m.voiceId !== 'string' || typeof m.modelId !== 'string'
      || m.preparerVersion !== STOCK_AUDIO_PREPARER_VERSION || typeof m.generatedAt !== 'string' || !Number.isFinite(Date.parse(m.generatedAt))
      || m.sampleRate !== 8000 || m.channels !== 1 || m.encoding !== 'PCM16'
      || Object.keys(m.prompts).length !== names.length || Object.keys(m.assets).length !== names.length) return null;
    if (m.provider === 'local' && (m.voiceId !== 'Samantha' || m.modelId !== 'macOS-say' || m.speed !== null)) return null;
    if (m.provider === 'elevenlabs') {
      const selection = stockVoiceSelection({ ELEVENLABS_VOICE_ID: m.voiceId, ELEVENLABS_MODEL_ID: m.modelId });
      if (selection.voiceId !== m.voiceId || selection.modelId !== m.modelId
        || typeof m.speed !== 'number' || !Number.isFinite(m.speed) || m.speed < 0.7 || m.speed > 1.2) return null;
    }
    for (const name of names) {
      if (m.prompts[name] !== STOCK_VOICE_PROMPTS[name]) return null;
      const key = cacheKey(m.provider, m.voiceId, m.modelId, m.prompts[name], m.speed);
      if (!await verifiedAsset(join(directory, `${name}.WAV`), m.assets[name], key)) return null;
    }
    return m;
  } catch { return null; }
}

async function localSpeech(text: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-local-voice-'));
  try {
    const path = join(directory, 'speech.aiff');
    await promisify(execFile)('/usr/bin/say', ['-v', 'Samantha', '-r', String(LOCAL_RATE), '-o', path, text], { timeout: 15_000, maxBuffer: 4096 });
    return await boundedFile(path, MAX_AUDIO_BYTES);
  } catch { throw new Error('macOS local speech generation failed.'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
export async function elevenLabsSpeech(text: string, apiKey: string, selection: { voiceId: string; modelId: string }, speed: number,
  fetcher: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  try {
    const response = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(selection.voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: selection.modelId, voice_settings: { speed } }),
    });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'audio/mpeg'
      || !response.body || Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES)
      throw new Error('Invalid speech response.');
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_AUDIO_BYTES) { await reader.cancel(); throw new Error('Speech response exceeds its bound.'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const audio = Buffer.concat(chunks);
    if (!((audio.length >= 10 && audio.toString('ascii', 0, 3) === 'ID3')
      || (audio.length >= 4 && audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0))) throw new Error('Invalid MPEG speech response.');
    return audio;
  } catch { throw new Error('ElevenLabs speech generation failed; existing voice assets were preserved. Retry or explicitly select the local provider.'); }
}
export interface PrepareStockAudioOptions {
  provider?: StockVoiceProvider;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  convert?: (audio: Buffer) => Promise<Buffer>;
  localSpeech?: (text: string) => Promise<Buffer>;
}
/** Prepare all seven clips before replacing the active set. No port access or playback. */
export async function prepareStockAudio(directory = defaultAudioDirectory(), options: PrepareStockAudioOptions = {}): Promise<{ manifest: StockVoiceManifest; cached: boolean }> {
  directory = resolve(directory);
  const provider = options.provider ?? 'local', env = options.env ?? process.env;
  if (provider !== 'local' && provider !== 'elevenlabs') throw new Error('Unknown stock voice provider.');
  const selection = provider === 'elevenlabs' ? stockVoiceSelection(env) : { voiceId: 'Samantha', modelId: 'macOS-say' };
  const speed = provider === 'elevenlabs' ? stockVoiceSpeed(env) : null;
  const current = await readStockVoiceManifest(directory);
  if (current?.provider === provider && current.voiceId === selection.voiceId && current.modelId === selection.modelId && current.speed === speed)
    return { manifest: current, cached: true };
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (provider === 'elevenlabs' && !apiKey) throw new Error('ELEVENLABS_API_KEY is required to generate ElevenLabs stock voice assets. Existing assets were preserved.');
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const cache = `${directory}.cache`;
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(`${directory}.stage-`), backup = `${directory}.previous-${randomUUID()}`;
  const assets = {} as StockVoiceManifest['assets'];
  try {
    for (const name of names) {
      const text = STOCK_VOICE_PROMPTS[name], key = cacheKey(provider, selection.voiceId, selection.modelId, text, speed);
      const cachePath = join(cache, `${key}.WAV`), metadataPath = join(cache, `${key}.json`);
      let wav: Buffer | null = null;
      try {
        const metadata = JSON.parse((await boundedFile(metadataPath, 4096)).toString()) as StockVoiceAsset;
        wav = await verifiedAsset(cachePath, metadata, key);
      } catch { /* A missing or invalid artifact must be generated, not trusted. */ }
      if (!wav) {
        const encoded = provider === 'elevenlabs'
          ? await elevenLabsSpeech(text, apiKey!, selection, speed!, options.fetch ?? fetch)
          : await (options.localSpeech ?? localSpeech)(text);
        wav = await (options.convert ?? convertPreparedAudioToOgWav)(encoded);
        assets[name] = assetMetadata(wav, key);
        await writeFile(cachePath, wav, { mode: 0o600 });
        await writeFile(metadataPath, JSON.stringify(assets[name]), { mode: 0o600 });
      } else assets[name] = assetMetadata(wav, key);
      await writeFile(join(stage, `${name}.WAV`), wav, { mode: 0o600 });
    }
    const manifest: StockVoiceManifest = {
      schemaVersion: 2, provider, source: provider === 'elevenlabs' ? 'ElevenLabs' : 'macOS local speech', ...selection, speed,
      preparerVersion: STOCK_AUDIO_PREPARER_VERSION, generatedAt: new Date().toISOString(),
      sampleRate: 8000, channels: 1, encoding: 'PCM16', prompts: { ...STOCK_VOICE_PROMPTS }, assets,
    };
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    let movedOld = false;
    try { await rename(directory, backup); movedOld = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(stage, directory); }
    catch (error) { if (movedOld) await rename(backup, directory); throw error; }
    if (movedOld) await rm(backup, { recursive: true, force: true });
    return { manifest, cached: false };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--provider' || !['local', 'elevenlabs'].includes(args[1]!)))
      throw new Error('Usage: prepare-stock-audio.ts [--provider local|elevenlabs]');
    const result = await prepareStockAudio(undefined, { provider: args[1] as StockVoiceProvider | undefined });
    console.log(`${result.cached ? 'Reused verified' : 'Prepared'} seven canonical 8 kHz WILi voice assets using ${result.manifest.source}. Board upload and playback remain separate.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Stock voice preparation failed.');
    process.exitCode = 1;
  }
}
