import { readMonoPcm16Wav } from './audio.ts';
import { transcribeOgUtterance } from './audio-transcription.ts';
import type { OgTranscription, OgTranscriptionOptions } from './audio-transcription.ts';
import type { WiliIncidentContext, WiliWellbeingContext } from './protocol.ts';
import { wiliId } from '../../src/freewili.ts';

export interface StockWellbeingUtterance {
  type: 'stock.wellbeing-utterance'; source: 'body-wili'; sessionId: string; eventId: string;
  conversationId: string; format: 'wav'; sampleRate: 8000; audioBase64: string;
  durationMs: number; receivedAtMs: number;
}

/** A wellbeing message has no incident or safety authority. */
export function matchingStockWellbeing(wellbeing: WiliWellbeingContext | null, incident: WiliIncidentContext | null,
  packet: { sessionId?: unknown; conversationId?: unknown }): boolean {
  return wellbeing !== null && wellbeing.enabled && wellbeing.sessionId === packet.sessionId
    && wellbeing.conversationId === packet.conversationId
    && (!incident || incident.phase === null || ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(incident.phase));
}

/** Local worker pipe only; raw audio never goes to the backend or a cloud API. */
export function decodeStockWellbeingUtterance(value: unknown): { packet: StockWellbeingUtterance; wav: Buffer } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid wellbeing microphone packet.');
  const p = value as Record<string, unknown>;
  const fields = ['type', 'source', 'sessionId', 'eventId', 'conversationId', 'format', 'sampleRate', 'audioBase64', 'durationMs', 'receivedAtMs'];
  if (Object.keys(p).length !== fields.length || Object.keys(p).some(key => !fields.includes(key))
    || p.type !== 'stock.wellbeing-utterance' || p.source !== 'body-wili'
    || !wiliId(p.sessionId) || !wiliId(p.eventId) || !wiliId(p.conversationId)
    || p.format !== 'wav' || p.sampleRate !== 8000 || typeof p.audioBase64 !== 'string'
    || p.audioBase64.length === 0 || p.audioBase64.length > 320_100 || p.audioBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.audioBase64)
    || typeof p.durationMs !== 'number' || !Number.isFinite(p.durationMs) || p.durationMs <= 0 || p.durationMs > 15_000
    || typeof p.receivedAtMs !== 'number' || !Number.isFinite(p.receivedAtMs) || p.receivedAtMs < 0 || p.receivedAtMs > Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid bounded wellbeing microphone packet.');
  const wav = Buffer.from(p.audioBase64, 'base64');
  try {
    const parsed = readMonoPcm16Wav(wav);
    if (wav.toString('base64') !== p.audioBase64 || parsed.sampleRate !== 8000 || parsed.durationMs > 15_000
      || Math.abs(parsed.durationMs - p.durationMs) > .001) throw new Error('Invalid wellbeing microphone duration.');
    return { packet: p as unknown as StockWellbeingUtterance, wav };
  } catch (error) { wav.fill(0); throw error; }
}

export async function recognizeCurrentWellbeing(value: unknown,
  current: () => { wellbeing: WiliWellbeingContext | null; incident: WiliIncidentContext | null },
  options: { signal?: AbortSignal; onStart?: (packet: StockWellbeingUtterance) => void;
    recognize?: (wav: Buffer, options: OgTranscriptionOptions) => Promise<OgTranscription> } = {}): Promise<OgTranscription | null> {
  const { packet, wav } = decodeStockWellbeingUtterance(value);
  const matches = () => {
    const state = current(); return !options.signal?.aborted && matchingStockWellbeing(state.wellbeing, state.incident, packet);
  };
  try {
    if (!matches()) return null;
    options.onStart?.(packet);
    const result = await (options.recognize ?? transcribeOgUtterance)(wav, { signal: options.signal, maxDurationMs: 15000 });
    return matches() ? result : null;
  } finally { wav.fill(0); }
}
