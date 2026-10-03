import { validBodyWiliSample, validWiliPong, wiliId } from '../../src/freewili.ts';
import type { BodyWiliSample, WiliClockPing, WiliClockPong } from '../../src/freewili.ts';

export const MAX_LINE_BYTES = 4096;
export interface WiliHello {
  type: 'device.hello'; protocolVersion: 1; source: 'body-wili'; sessionId: string;
  deviceModel: 'freewili-og' | 'freewili-2'; fullScaleG: 2 | 4 | 8 | 16;
  capabilities: { accelerometer: true; speaker: boolean; microphone: boolean; buttons: boolean };
}
export interface WiliButton {
  type: 'button.press'; source: 'body-wili'; sessionId: string; eventId: string; action: 'help' | 'cancel';
  incidentId: string | null; checkinId: string | null;
}
export interface WiliAudioAck {
  type: 'audio.ack'; source: 'body-wili'; sessionId: string; eventId: string; commandId: string;
  incidentId: string; checkinId: string; status: 'started' | 'finished' | 'stopped' | 'failed';
}
export interface WiliStatus {
  type: 'device.status'; source: 'body-wili'; sessionId: string;
  status: 'sensor-error' | 'sample-unavailable' | 'audio-error';
}
export interface WiliIncidentContext {
  type: 'incident.context'; sessionId: string; incidentId: string | null; checkinId: string | null;
  phase: string | null; checkinDeadline: number | null; serverTime: number;
}
export interface WiliAudioCommand {
  type: 'audio.command'; sessionId: string; commandId: string; incidentId: string; checkinId: string;
  action: 'play' | 'stop'; asset: 'fall-checkin' | 'safe-confirmation';
}
export type WiliDevicePacket = WiliHello | BodyWiliSample | WiliClockPong | WiliButton | WiliAudioAck | WiliStatus;
export type WiliHostPacket = WiliClockPing | WiliIncidentContext | WiliAudioCommand;
const object = (p: unknown): p is Record<string, unknown> => p !== null && typeof p === 'object' && !Array.isArray(p);
const finite = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= Number.MAX_SAFE_INTEGER;
const nullableId = (p: unknown) => p === null || wiliId(p);
const keys = (p: Record<string, unknown>, allowed: string[]) => Object.keys(p).every(key => allowed.includes(key));
const phase = (p: unknown) => p === null || (typeof p === 'string' && ['DETECTED', 'CONFIRMING', 'HELP_REQUESTED', 'ACKNOWLEDGED',
  'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(p));

export function validWiliHello(p: unknown): p is WiliHello {
  if (!object(p) || !object(p.capabilities)) return false;
  const capabilities = p.capabilities;
  return keys(p, ['type', 'protocolVersion', 'source', 'sessionId', 'deviceModel', 'fullScaleG', 'capabilities'])
    && p.type === 'device.hello' && p.protocolVersion === 1 && p.source === 'body-wili' && wiliId(p.sessionId)
    && typeof p.deviceModel === 'string' && ['freewili-og', 'freewili-2'].includes(p.deviceModel)
    && typeof p.fullScaleG === 'number' && [2, 4, 8, 16].includes(p.fullScaleG)
    && keys(capabilities, ['accelerometer', 'speaker', 'microphone', 'buttons'])
    && capabilities.accelerometer === true && ['speaker', 'microphone', 'buttons'].every(key => typeof capabilities[key] === 'boolean');
}
export function validDevicePacket(p: unknown): p is WiliDevicePacket {
  if (!object(p)) return false;
  if (p.type === 'device.hello') return validWiliHello(p);
  if (p.type === 'accel.sample') return validBodyWiliSample(p);
  if (p.type === 'clock.pong') return validWiliPong(p)
    && keys(p, ['type', 'id', 'sessionId', 'deviceReceivedMs', 'deviceSentMs']);
  if (p.source !== 'body-wili' || !wiliId(p.sessionId)) return false;
  if (p.type === 'button.press') {
    return keys(p, ['type', 'source', 'sessionId', 'eventId', 'action', 'incidentId', 'checkinId'])
      && wiliId(p.eventId) && typeof p.action === 'string' && ['help', 'cancel'].includes(p.action)
      && nullableId(p.incidentId) && nullableId(p.checkinId) && (p.incidentId === null) === (p.checkinId === null)
      && (p.action !== 'cancel' || (wiliId(p.incidentId) && wiliId(p.checkinId)));
  }
  if (p.type === 'audio.ack') {
    return keys(p, ['type', 'source', 'sessionId', 'eventId', 'commandId', 'incidentId', 'checkinId', 'status'])
      && wiliId(p.eventId) && wiliId(p.commandId) && wiliId(p.incidentId) && wiliId(p.checkinId)
      && typeof p.status === 'string' && ['started', 'finished', 'stopped', 'failed'].includes(p.status);
  }
  return p.type === 'device.status' && keys(p, ['type', 'source', 'sessionId', 'status'])
    && typeof p.status === 'string' && ['sensor-error', 'sample-unavailable', 'audio-error'].includes(p.status);
}
export function validHostPacket(p: unknown): p is WiliHostPacket {
  if (!object(p)) return false;
  if (p.type === 'clock.ping') return keys(p, ['type', 'id', 'serverSentMs']) && wiliId(p.id) && finite(p.serverSentMs);
  if (!wiliId(p.sessionId)) return false;
  if (p.type === 'incident.context') {
    return keys(p, ['type', 'sessionId', 'incidentId', 'checkinId', 'phase', 'checkinDeadline', 'serverTime'])
      && nullableId(p.incidentId) && nullableId(p.checkinId) && (p.incidentId === null) === (p.checkinId === null)
      && phase(p.phase) && (p.incidentId === null) === (p.phase === null)
      && (p.checkinDeadline === null || finite(p.checkinDeadline)) && finite(p.serverTime);
  }
  return p.type === 'audio.command' && keys(p, ['type', 'sessionId', 'commandId', 'incidentId', 'checkinId', 'action', 'asset'])
    && wiliId(p.commandId) && wiliId(p.incidentId) && wiliId(p.checkinId)
    && typeof p.action === 'string' && ['play', 'stop'].includes(p.action)
    && typeof p.asset === 'string' && ['fall-checkin', 'safe-confirmation'].includes(p.asset);
}

/** Byte bound applies before UTF-8/JSON parsing; split UTF-8 characters remain intact. */
export class WiliNdjson {
  private pending = Buffer.alloc(0);
  push(bytes: Buffer): unknown[] {
    const packets: unknown[] = [];
    let cursor = 0;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(10, cursor);
      const end = newline < 0 ? bytes.length : newline;
      if (this.pending.length + end - cursor > MAX_LINE_BYTES) throw new Error('WILi serial line exceeds 4096 bytes.');
      this.pending = Buffer.concat([this.pending, bytes.subarray(cursor, end)]);
      if (newline < 0) break;
      if (this.pending.length) {
        try { packets.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.pending))); }
        catch { throw new Error('Invalid WILi UTF-8/JSON packet.'); }
      }
      this.pending = Buffer.alloc(0); cursor = newline + 1;
    }
    return packets;
  }
  finish(): void { if (this.pending.length) throw new Error('Incomplete WILi NDJSON line.'); }
}

/** One physical boot/session per connection. Policy authorization stays in the server. */
export class WiliDeviceProtocol {
  hello: WiliHello | null = null;
  private sequence = -1;
  private sensorTime = -1;
  private events = new Set<string>();
  accept(p: unknown): WiliDevicePacket {
    if (!validDevicePacket(p)) throw new Error('Malformed WILi device packet.');
    if (p.type === 'device.hello') {
      if (this.hello && JSON.stringify(this.hello) !== JSON.stringify(p))
        throw new Error('WILi identity changed; reconnect with a new bridge session.');
      this.hello = { ...p, capabilities: { ...p.capabilities } }; return p;
    }
    if (!this.hello || p.sessionId !== this.hello.sessionId) throw new Error('WILi packet has no matching hello/session.');
    if (p.type === 'accel.sample') {
      if (p.fullScaleG !== this.hello.fullScaleG || p.sequence <= this.sequence || p.sensorTime <= this.sensorTime)
        throw new Error('WILi sample is repeated, out of order, or changed range.');
      this.sequence = p.sequence; this.sensorTime = p.sensorTime;
    }
    if (p.type === 'button.press' || p.type === 'audio.ack') {
      if (this.events.has(p.eventId)) throw new Error('Repeated WILi event ID.');
      this.events.add(p.eventId);
      while (this.events.size > 128) this.events.delete(this.events.values().next().value!);
      if (p.type === 'button.press' && !this.hello.capabilities.buttons) throw new Error('WILi buttons were not advertised.');
      if (p.type === 'audio.ack' && !this.hello.capabilities.speaker) throw new Error('WILi speaker was not advertised.');
    }
    return p;
  }
}
