import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { ogWavForWhisper, readMonoPcm16Wav } from './audio.ts';

export type OgTranscription =
  | { status: 'transcribed'; transcript: string; source: 'freewili-og-microphone'; engine: 'whisper.cpp' }
  | { status: 'unavailable'; detail: string };
export interface OgTranscriptionOptions {
  modelPath?: string;
  signal?: AbortSignal;
  cliPath?: string;
  /** Offline process injection; production uses the bounded local CLI below. */
  run?: (cli: string, args: string[], signal?: AbortSignal) => Promise<void>;
}

/** Bounded local STT only. The caller authenticates/correlates this utterance and
 * classifies the returned transcript; recognition has no state-changing authority.
 * Raw WAV and CLI transcript files are private, transient, and removed in finally.
 */
export async function transcribeOgUtterance(wav: Buffer, options: OgTranscriptionOptions = {}): Promise<OgTranscription> {
  const unavailable = (detail: string): OgTranscription => ({ status: 'unavailable', detail });
  if (options.signal?.aborted) return unavailable('Microphone recognition was cancelled.');
  let input: Buffer;
  try {
    input = ogWavForWhisper(wav);
    if (readMonoPcm16Wav(input).pcm.every(byte => byte === 0)) return unavailable('The microphone utterance contained only zero samples.');
  } catch { return unavailable('Expected a valid bounded OG microphone WAV.'); }
  const model = options.modelPath ?? process.env.LIFELINE_WHISPER_MODEL;
  const cli = options.cliPath ?? process.env.WHISPER_CLI ?? '/opt/homebrew/bin/whisper-cli';
  if (!model || !isAbsolute(model) || !isAbsolute(cli)) return unavailable('Configure an absolute local Whisper model and CLI path.');
  try {
    const modelStat = await stat(model);
    if (!modelStat.isFile() || modelStat.size < 1_000_000 || modelStat.size > 512_000_000)
      return unavailable('A trained local speech model is unavailable.');
  } catch { return unavailable('A trained local speech model is unavailable.'); }
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-og-utterance-'));
  try {
    const audio = join(directory, 'utterance.wav'), output = join(directory, 'transcript');
    await writeFile(audio, input, { mode: 0o600 });
    const args = ['-m', model, '-f', audio, '-otxt', '-of', output, '-nt', '-np', '-ng', '-l', 'en', '-t', '4'];
    if (options.signal?.aborted) return unavailable('Microphone recognition was cancelled.');
    if (options.run) await options.run(cli, args, options.signal);
    else await promisify(execFile)(cli, args, { signal: options.signal, timeout: 20_000, maxBuffer: 65_536 });
    if (options.signal?.aborted) return unavailable('Microphone recognition was cancelled.');
    const outputFile = output + '.txt';
    if ((await stat(outputFile)).size > 4096) return unavailable('Recognition output exceeded the transcript bound.');
    const transcript = (await readFile(outputFile, 'utf8')).trim().replace(/\s+/g, ' ');
    if (!transcript || /^\[(?:blank_audio|silence|music|noise)\]$/i.test(transcript)) return unavailable('No speech was recognized.');
    if (transcript.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(transcript))
      return unavailable('Recognition output was not a valid bounded transcript.');
    return { status: 'transcribed', transcript, source: 'freewili-og-microphone', engine: 'whisper.cpp' };
  } catch {
    return unavailable(options.signal?.aborted ? 'Microphone recognition was cancelled.' : 'Local microphone recognition failed or timed out.');
  } finally {
    input.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
}
