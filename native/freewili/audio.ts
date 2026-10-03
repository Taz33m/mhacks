import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Official stock OG SDK: examples/record_audio.py, framing.py, types.AudioData.
// This helper does not open a port, enable a microphone, or authorize an incident.
export const OG_AUDIO_SAMPLE_RATE = 8000;
export const MAX_UTTERANCE_MS = 6000;
const MAX_FRAME_SAMPLES = 1024;
const MAX_ASSET_MS = 15000;
const MAX_ENCODED_BYTES = 5 * 1024 * 1024;

export const OG_VOICE_TEXT = {
  checkin: 'I detected a possible fall. Do you need help? Say I need help, or press the cancel button if you do not need help.',
  confirmationRequired: 'Glad you are okay. Press the cancel button if you do not need help.',
  helpRequested: 'Help has been requested. We are waiting for a responder to accept.',
  acknowledged: 'A responder has accepted your request. They have not reported leaving yet.',
  enRoute: 'Your responder reports they are on the way.',
  onScene: 'Your responder reports they have arrived.',
} as const;

export interface OgAudioFrame {
  sequence: number;
  /** Original provider value. It is not an aligned host clock or a freshness claim. */
  timestampNs: string;
  samples: number[];
}

/** Complete stock frame only, after the caller's existing serial framer. */
export function parseOgAudioFrame(raw: string): OgAudioFrame | null {
  if (!raw.trimStart().startsWith('[*audio ')) return null;
  if (Buffer.byteLength(raw) > 16384) throw new Error('OG audio frame exceeds the bound.');
  const match = /^\[\*audio ([0-9a-fA-F]{1,16}) (\d+) ((?:-?\d+\s+)*-?\d+) 1\]$/.exec(raw.trim());
  if (!match) throw new Error('Malformed or unsuccessful OG audio event.');
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) throw new Error('Invalid OG audio sequence.');
  const samples = match[3]!.trim().split(/\s+/).map(Number);
  validSamples(samples, MAX_FRAME_SAMPLES);
  return { sequence, timestampNs: BigInt(`0x${match[1]}`).toString(), samples };
}

function validSamples(samples: readonly number[], bound: number): void {
  if (!samples.length || samples.length > bound || samples.some(sample => !Number.isInteger(sample) || sample < -32768 || sample > 32767))
    throw new Error('Expected bounded signed 16-bit PCM samples.');
}

export function pcm16Wav(pcm: Buffer, sampleRate: 8000 | 16000): Buffer {
  if ((sampleRate !== 8000 && sampleRate !== 16000) || !pcm.length || pcm.length % 2 || pcm.length > sampleRate * 2 * MAX_ASSET_MS / 1000)
    throw new Error('Expected a short mono signed 16-bit PCM clip.');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

/** Validate real WAV chunks; metadata chunks emitted by afconvert are allowed. */
export function readMonoPcm16Wav(wav: Buffer): { sampleRate: 8000 | 16000; pcm: Buffer; durationMs: number } {
  if (wav.length < 44 || wav.length > MAX_ENCODED_BYTES || wav.toString('ascii', 0, 4) !== 'RIFF'
    || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length)
    throw new Error('Invalid bounded RIFF/WAVE clip.');
  let sampleRate: 8000 | 16000 | undefined, pcm: Buffer | undefined;
  for (let cursor = 12; cursor < wav.length;) {
    if (cursor + 8 > wav.length) throw new Error('Truncated WAV chunk.');
    const id = wav.toString('ascii', cursor, cursor + 4), size = wav.readUInt32LE(cursor + 4), start = cursor + 8;
    const end = start + size;
    if (end > wav.length || end + size % 2 > wav.length) throw new Error('Truncated WAV chunk.');
    if (id === 'fmt ') {
      if (sampleRate || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16)
        throw new Error('Expected mono PCM16 WAV.');
      const rate = wav.readUInt32LE(start + 4);
      if ((rate !== 8000 && rate !== 16000) || wav.readUInt32LE(start + 8) !== rate * 2)
        throw new Error('Expected 8kHz or 16kHz PCM16 WAV.');
      sampleRate = rate;
    } else if (id === 'data') {
      if (pcm || !size || size % 2) throw new Error('Invalid PCM data chunk.');
      pcm = wav.subarray(start, end);
    }
    cursor = end + size % 2;
  }
  if (!sampleRate || !pcm || pcm.length > sampleRate * 2 * MAX_ASSET_MS / 1000) throw new Error('Missing or oversized WAV audio.');
  return { sampleRate, pcm, durationMs: pcm.length / (sampleRate * 2) * 1000 };
}

/** One bounded utterance in RAM. Start only after prompt playback and SDK input flushing.
 * The caller must disable stock audio events at deadline/in finally, including failures.
 * Global frame sequences can skip because other stock event types share the counter.
 */
export class OgUtterance {
  readonly deadlineMs: number;
  private pcm: Buffer;
  private count = 0;
  private sequence = -1;
  private closed = false;
  private lastHostTime: number;
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now(), durationMs = MAX_UTTERANCE_MS) {
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_UTTERANCE_MS) throw new Error('Invalid utterance duration.');
    this.now = now; this.lastHostTime = now();
    if (!Number.isFinite(this.lastHostTime)) throw new Error('Invalid host clock.');
    this.deadlineMs = this.lastHostTime + durationMs;
    this.pcm = Buffer.alloc(Math.floor(OG_AUDIO_SAMPLE_RATE * durationMs / 1000) * 2);
  }
  append(frame: OgAudioFrame): boolean {
    if (this.closed) return false;
    const hostTime = this.now();
    if (!Number.isFinite(hostTime) || hostTime < this.lastHostTime) { this.abort(); throw new Error('Host clock moved backwards.'); }
    this.lastHostTime = hostTime;
    if (hostTime >= this.deadlineMs || this.count * 2 === this.pcm.length) return false;
    validSamples(frame.samples, MAX_FRAME_SAMPLES);
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) throw new Error('Invalid OG audio sequence.');
    if (frame.sequence <= this.sequence) return false;
    this.sequence = frame.sequence;
    const count = Math.min(frame.samples.length, this.pcm.length / 2 - this.count);
    for (let i = 0; i < count; i++) this.pcm.writeInt16LE(frame.samples[i]!, (this.count + i) * 2);
    this.count += count;
    return true;
  }
  finish(): { status: 'captured'; wav: Buffer; durationMs: number } | { status: 'unavailable'; reason: string } {
    if (this.closed) return { status: 'unavailable', reason: 'Utterance is already closed.' };
    const wav = this.count ? pcm16Wav(this.pcm.subarray(0, this.count * 2), OG_AUDIO_SAMPLE_RATE) : null;
    const durationMs = this.count / OG_AUDIO_SAMPLE_RATE * 1000;
    this.abort();
    return wav ? { status: 'captured', wav, durationMs } : { status: 'unavailable', reason: 'No microphone samples were received.' };
  }
  abort(): void { this.pcm.fill(0); this.pcm = Buffer.alloc(0); this.count = 0; this.closed = true; }
}

/** Whisper CLI expects 16kHz. Upsampling preserves duration, not new acoustic evidence. */
export function ogWavForWhisper(wav: Buffer): Buffer {
  const { sampleRate, pcm } = readMonoPcm16Wav(wav);
  if (sampleRate !== OG_AUDIO_SAMPLE_RATE || pcm.length > OG_AUDIO_SAMPLE_RATE * 2 * MAX_UTTERANCE_MS / 1000)
    throw new Error('Expected a bounded OG microphone utterance.');
  const result = Buffer.alloc(pcm.length * 2), count = pcm.length / 2;
  for (let i = 0; i < count; i++) {
    const current = pcm.readInt16LE(i * 2), next = pcm.readInt16LE(Math.min(i + 1, count - 1) * 2);
    result.writeInt16LE(current, i * 4); result.writeInt16LE(Math.round((current + next) / 2), i * 4 + 2);
  }
  return pcm16Wav(result, 16000);
}

/** Prepared speech asset conversion only. No playback, generation or microphone access.
 * Uses macOS Core Audio because the existing ffmpeg executable is incompatible here.
 */
export async function convertPreparedAudioToOgWav(encoded: Buffer): Promise<Buffer> {
  if (!encoded.length || encoded.length > MAX_ENCODED_BYTES) throw new Error('Invalid prepared audio size.');
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-og-asset-'));
  try {
    const input = join(directory, 'input.audio'), output = join(directory, 'output.wav');
    await writeFile(input, encoded, { mode: 0o600 });
    try {
      await promisify(execFile)('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@8000', '-c', '1', input, output], { timeout: 8000, maxBuffer: 4096 });
    } catch { throw new Error('Core Audio could not convert the prepared speech asset.'); }
    if ((await stat(output)).size > MAX_ENCODED_BYTES) throw new Error('Converted asset exceeds the byte bound.');
    const converted = await readFile(output), parsed = readMonoPcm16Wav(converted);
    if (parsed.sampleRate !== OG_AUDIO_SAMPLE_RATE) throw new Error('Converted asset has the wrong sample rate.');
    // Core Audio inserts an FLLR alignment chunk. Give the stock board a
    // canonical 44-byte PCM header, without relying on its metadata parser.
    return pcm16Wav(parsed.pcm, OG_AUDIO_SAMPLE_RATE);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
