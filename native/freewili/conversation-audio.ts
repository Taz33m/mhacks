import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertPreparedAudioToOgWav, readMonoPcm16Wav } from './audio.ts';
import { elevenLabsSpeech, stockVoiceSelection, stockVoiceSpeed } from './prepare-stock-audio.ts';
import { validConversationSpeak } from './protocol.ts';
import type { WiliConversationSpeak, WiliIncidentContext, WiliVoicePlayback } from './protocol.ts';

export interface ConversationAsset { filename: string; dispose: () => Promise<void> }
export interface ConversationAudioOptions {
  env?: NodeJS.ProcessEnv; fetch?: typeof fetch; signal?: AbortSignal;
  convert?: (encoded: Buffer) => Promise<Buffer>;
}

/** Full verbatim relay, using the same voice/settings and canonical board conversion as phase clips. */
export async function prepareConversationAudio(packet: WiliConversationSpeak, directory: string,
  options: ConversationAudioOptions = {}): Promise<ConversationAsset> {
  if (!validConversationSpeak(packet)) throw new Error('Invalid responder speech.');
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env, key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error('ElevenLabs responder speech is unavailable.');
  const selection = stockVoiceSelection(env), speed = stockVoiceSpeed(env);
  const encoded = await elevenLabsSpeech(`${packet.speakerName} says: ${packet.text}`, key, selection, speed,
    options.fetch ?? fetch, options.signal);
  let wav: Buffer | undefined;
  try {
    options.signal?.throwIfAborted();
    wav = await (options.convert ?? convertPreparedAudioToOgWav)(encoded);
    options.signal?.throwIfAborted();
    const parsed = readMonoPcm16Wav(wav);
    if (parsed.sampleRate !== 8000 || wav.length !== 44 + parsed.pcm.length || wav.toString('ascii', 36, 40) !== 'data')
      throw new Error('Responder speech needs canonical 8 kHz PCM16 WAV.');
    // WAV validation rejects clips over 15 seconds. Never truncate a responder's words.
    const filename = `${randomBytes(4).toString('hex').toUpperCase()}.WAV`, path = join(directory, filename);
    await writeFile(path, wav, { mode: 0o600, flag: 'wx' });
    if (options.signal?.aborted) { await rm(path, { force: true }); options.signal.throwIfAborted(); }
    return { filename, dispose: () => rm(path, { force: true }) };
  } finally { encoded.fill(0); wav?.fill(0); }
}

const activeContext = (context: WiliIncidentContext | null, packet: WiliConversationSpeak) => context !== null
  && context.sessionId === packet.sessionId && context.incidentId === packet.incidentId
  && context.phase !== null && !['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(context.phase);

/** Bounded foreground queue. A dispatched clip waits for the serial worker's correlated completion. */
export class ConversationAudioQueue {
  private context: WiliIncidentContext | null = null;
  private pending: WiliConversationSpeak[] = [];
  private seen = new Set<string>();
  private current: { packet: WiliConversationSpeak; abort: AbortController; asset?: ConversationAsset; dispatched: boolean } | null = null;
  private stopped = false;
  private preparation: Promise<void> = Promise.resolve();
  private readonly options: {
    prepare: (packet: WiliConversationSpeak, signal: AbortSignal) => Promise<ConversationAsset>;
    dispatch: (packet: WiliConversationSpeak, filename: string) => void;
    status: (packet: WiliVoicePlayback) => void;
  };
  constructor(options: ConversationAudioQueue['options']) { this.options = options; }
  private emit(packet: WiliConversationSpeak, status: WiliVoicePlayback['status']): void {
    this.options.status({ type: 'voice.playback', source: 'body-wili', sessionId: packet.sessionId,
      eventId: packet.eventId, incidentId: packet.incidentId, status });
  }
  updateContext(context: WiliIncidentContext): void {
    this.context = context;
    this.pending = this.pending.filter(packet => {
      if (activeContext(context, packet)) return true;
      this.emit(packet, 'failed'); return false;
    });
    if (this.current && !this.current.dispatched && !activeContext(context, this.current.packet)) this.current.abort.abort();
  }
  enqueue(packet: WiliConversationSpeak): void {
    if (!validConversationSpeak(packet)) throw new Error('Invalid responder speech.');
    if (this.stopped || this.seen.has(packet.eventId)) return;
    this.seen.add(packet.eventId);
    while (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    this.emit(packet, 'queued');
    if (!activeContext(this.context, packet) || this.pending.length >= 8) { this.emit(packet, 'failed'); return; }
    this.pending.push(packet); this.pump();
  }
  private pump(): void {
    if (this.current || this.stopped) return;
    const packet = this.pending.shift();
    if (!packet) return;
    const job = { packet, abort: new AbortController(), asset: undefined as ConversationAsset | undefined, dispatched: false };
    this.current = job;
    this.preparation = (async () => {
      try {
        job.asset = await this.options.prepare(packet, job.abort.signal);
        if (job.abort.signal.aborted || this.stopped || !activeContext(this.context, packet)) throw new Error('Stale speech.');
        job.dispatched = true;
        this.options.dispatch(packet, job.asset.filename);
      } catch {
        if (!this.stopped) this.emit(packet, 'failed');
        await job.asset?.dispose().catch(() => {});
        if (this.current === job) this.current = null;
        this.pump();
      }
    })();
  }
  playback(packet: WiliVoicePlayback): void {
    const job = this.current;
    if (!job?.dispatched || (['eventId', 'incidentId', 'sessionId'] as const).some(key =>
      packet[key] !== job.packet[key]) || packet.status === 'queued')
      throw new Error('Uncorrelated serial playback status.');
    this.options.status(packet);
    if (packet.status === 'spoken' || packet.status === 'failed') {
      this.current = null;
      void job.asset?.dispose().catch(() => {}).finally(() => this.pump());
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.pending = [];
    this.current?.abort.abort();
    await this.preparation;
    await this.current?.asset?.dispose().catch(() => {}); this.current = null;
  }
}
