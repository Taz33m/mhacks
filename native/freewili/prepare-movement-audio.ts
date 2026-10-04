import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { elevenLabsSpeech, stockVoiceSelection, stockVoiceSpeed } from './prepare-stock-audio.ts';
import { convertPreparedAudioToOgWav, readMonoPcm16Wav } from './audio.ts';

export const MOVEMENT_PROMPT = 'I noticed unusual movement. Do you need help?';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Optional eighth prompt; does not invalidate or replace the seven working fall-loop clips. */
export async function prepareMovementAudio(directory = resolve(process.env.LIFELINE_WILI_AUDIO_DIR || 'output/freewili-audio'),
  env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const selection = stockVoiceSelection(env), speed = stockVoiceSpeed(env);
  try {
    const bytes = await readFile(join(directory, 'MOVEMENT.WAV'));
    const meta = JSON.parse(await readFile(join(directory, 'movement.json'), 'utf8'));
    if (meta.text === MOVEMENT_PROMPT && meta.voiceId === selection.voiceId && meta.modelId === selection.modelId
      && meta.speed === speed && meta.sha256 === hash(bytes)) return;
  } catch { /* Generate only this new prompt. */ }
  if (!env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs credentials are required for the optional movement prompt.');
  const encoded = await elevenLabsSpeech(MOVEMENT_PROMPT, env.ELEVENLABS_API_KEY, selection, speed, fetch);
  const wav = await convertPreparedAudioToOgWav(encoded), parsed = readMonoPcm16Wav(wav);
  if (parsed.sampleRate !== 8000 || parsed.durationMs <= 0 || parsed.durationMs > 15_000) throw new Error('Invalid movement prompt.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'MOVEMENT.WAV'), wav, { mode: 0o600 });
  await writeFile(join(directory, 'movement.json'), JSON.stringify({ text: MOVEMENT_PROMPT, ...selection,
    speed, sha256: hash(wav), durationMs: parsed.durationMs }), { mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareMovementAudio(); console.log('Movement prompt prepared quietly. No device playback or transfer.');
}
