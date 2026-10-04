import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Incident, ProviderResult } from './contracts.ts';

export interface LocationGrant {
  id: string; role: 'wearer' | 'responder'; name: string; issuedAt: number; expiresAt: number;
  incidentId?: string; responderId?: string;
}
export interface LocationInput {
  latitude: number; longitude: number; accuracy: number; timestamp: number; sequence: number; mode?: 'walking' | 'driving';
}
export interface NativeLocationSubject {
  role: 'wearer' | 'responder'; name: string; incidentId?: string; responderId?: string;
}
export interface NativeLocationPoint {
  latitude: number; longitude: number; accuracy: number | null; timestamp: number; receivedAt: number;
  sourceSequence: number; expiresAt?: number; source: 'photon-find-my';
}
export interface LocationPointView {
  latitude: number; longitude: number; accuracy: number | null; timestamp: number; receivedAt: number;
  ageMs: number; fresh: boolean; name: string; source: 'browser-geolocation' | 'photon-find-my';
}
export interface LocationInviteStatus {
  status: 'queued' | 'attempting' | ProviderResult['status']; detail: string;
}
export interface LocationView {
  configured: boolean; wearer: LocationPointView | null; responder: LocationPointView | null;
  eta: null | { seconds: number; distanceMeters: number; method: 'straight-line-walking-estimate'; updatedAt: number };
  detail: string; invite?: LocationInviteStatus | null;
}
type StoredGrant = LocationGrant & { sequence: number; revoked: boolean };
type StoredPosition = LocationInput & { receivedAt: number; source: 'browser-geolocation' };
type StoredNativePosition = { subject: NativeLocationSubject; point: NativeLocationPoint };
type StoredInvite = { id: string; text: string; status: LocationInviteStatus['status']; attempts: number; createdAt: number; result?: ProviderResult };
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const terminal = (active: Incident | null): boolean => !active || ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(active.phase);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fields = new Set(['latitude', 'longitude', 'accuracy', 'timestamp', 'sequence', 'mode']);
const nativeFields = new Set(['latitude', 'longitude', 'accuracy', 'timestamp', 'receivedAt', 'sourceSequence', 'expiresAt', 'source']);
const HOURS_2 = 2 * 60 * 60 * 1000;

/** Browser consent and trusted native measurements are independent of incident transitions. */
export class Location {
  private readonly db: DatabaseSync;
  private readonly wearerName: string;
  private readonly now: () => number;

  constructor(dbPath: string, options: { wearerName: string }, now = Date.now) {
    this.wearerName = options.wearerName.trim();
    if (!validId(this.wearerName) || this.wearerName.length > 100) throw new Error('Invalid wearer location name.');
    this.now = now;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS location_grants (id TEXT PRIMARY KEY, issue_key TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS location_positions (grant_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS location_native_positions (subject_key TEXT PRIMARY KEY, expires_at REAL NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS location_native_cursors (subject_key TEXT PRIMARY KEY, timestamp REAL NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS location_invites (id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);`);
    this.transaction(() => {
      for (const invite of this.invites().filter(invite => invite.status === 'attempting')) {
        invite.status = 'unknown'; invite.result = { status: 'unknown', detail: 'Worker stopped during submission; no automatic retry.' };
        this.saveInvite(invite);
      }
    });
  }
  private time(): number {
    const at = this.now(); if (!finite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - HOURS_2) throw new Error('Invalid location clock.'); return at;
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  issue(input: { key: string; role: 'wearer' | 'responder'; incidentId?: string; responderId?: string; name: string }): string {
    if (!validId(input.key) || !['wearer', 'responder'].includes(input.role) || !validId(input.name) || input.name.length > 100
      || (input.incidentId !== undefined && !validId(input.incidentId)) || (input.responderId !== undefined && !validId(input.responderId))
      || (input.role === 'responder' && (!input.incidentId || !input.responderId))) throw new Error('Invalid location grant.');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT token,body FROM location_grants WHERE issue_key=?').get(input.key);
      if (existing) {
        const grant = JSON.parse(String(existing.body)) as StoredGrant;
        if (grant.role !== input.role || grant.incidentId !== input.incidentId || grant.responderId !== input.responderId || grant.name !== input.name)
          throw new Error('Location issue key already belongs to another grant.');
        return String(existing.token);
      }
      const at = this.time(), token = randomBytes(32).toString('hex');
      const grant: StoredGrant = { id: randomUUID(), role: input.role, name: input.name, issuedAt: at, expiresAt: at + HOURS_2,
        sequence: -1, revoked: false, ...(input.incidentId ? { incidentId: input.incidentId } : {}), ...(input.responderId ? { responderId: input.responderId } : {}) };
      this.db.prepare('INSERT INTO location_grants VALUES (?,?,?,?)').run(grant.id, input.key, token, JSON.stringify(grant));
      return token;
    });
  }
  private grant(token: string, active: Incident | null): StoredGrant | null {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = this.db.prepare('SELECT body FROM location_grants WHERE token=?').get(token);
    if (!row) return null;
    const grant = JSON.parse(String(row.body)) as StoredGrant;
    if (grant.revoked || this.time() >= grant.expiresAt) return null;
    if (grant.role === 'responder' && (terminal(active) || grant.incidentId !== active!.id
      || (active!.ownerId !== null && active!.ownerId !== grant.responderId))) return null;
    return grant;
  }
  authorize(token: string, active: Incident | null): LocationGrant | null {
    const grant = this.grant(token, active); if (!grant) return null;
    const { sequence, revoked, ...visible } = grant; return visible;
  }
  update(token: string, input: LocationInput, active: Incident | null): boolean {
    const at = this.time();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key))
      || !finite(input.latitude) || input.latitude < -90 || input.latitude > 90
      || !finite(input.longitude) || input.longitude < -180 || input.longitude > 180
      || !finite(input.accuracy) || input.accuracy < 0 || input.accuracy > 1000
      || !finite(input.timestamp) || input.timestamp < 0 || at - input.timestamp > 120_000 || input.timestamp - at > 10_000
      || !Number.isSafeInteger(input.sequence) || input.sequence < 0 || (input.mode !== undefined && !['walking', 'driving'].includes(input.mode))) return false;
    return this.transaction(() => {
      const grant = this.grant(token, active); if (!grant || input.sequence <= grant.sequence) return false;
      grant.sequence = input.sequence;
      this.db.prepare('UPDATE location_grants SET body=? WHERE id=?').run(JSON.stringify(grant), grant.id);
      const position: StoredPosition = { ...input, receivedAt: at, source: 'browser-geolocation' };
      // A new row order breaks same-millisecond ties across separate grants.
      this.db.prepare('INSERT OR REPLACE INTO location_positions VALUES (?,?)').run(grant.id, JSON.stringify(position));
      return true;
    });
  }
  stop(token: string, active: Incident | null): boolean {
    return this.transaction(() => {
      const current = this.grant(token, active); if (!current) return false;
      // Stop is a consent boundary for this wearer or incident responder, not a
      // reason to reveal an older position from another still-valid link.
      for (const row of this.db.prepare('SELECT body FROM location_grants').all()) {
        const grant = JSON.parse(String(row.body)) as StoredGrant;
        if (grant.role !== current.role || (current.role === 'responder'
          && (grant.incidentId !== current.incidentId || grant.responderId !== current.responderId))) continue;
        grant.revoked = true;
        this.db.prepare('UPDATE location_grants SET body=? WHERE id=?').run(JSON.stringify(grant), grant.id);
        this.db.prepare('DELETE FROM location_positions WHERE grant_id=?').run(grant.id);
      }
      return true;
    });
  }
  private nativeKey(subject: NativeLocationSubject): string | null {
    if (!subject || typeof subject !== 'object' || Array.isArray(subject) || !['wearer', 'responder'].includes(subject.role)
      || !validId(subject.name) || subject.name.length > 100
      || (subject.incidentId !== undefined && !validId(subject.incidentId))
      || (subject.responderId !== undefined && !validId(subject.responderId))
      || (subject.role === 'responder' && (!subject.incidentId || !subject.responderId))) return null;
    return JSON.stringify(subject.role === 'wearer' ? ['wearer'] : ['responder', subject.incidentId, subject.responderId]);
  }
  /** Only the internal, approved-subject Photon adapter may call this ingestion boundary. */
  recordNative(subject: NativeLocationSubject, point: NativeLocationPoint, active: Incident | null): boolean {
    const key = this.nativeKey(subject), at = this.time();
    if (!key || (subject.role === 'responder' && (terminal(active) || subject.incidentId !== active!.id
      || (active!.ownerId !== null && active!.ownerId !== subject.responderId)))
      || !point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some(field => !nativeFields.has(field))
      || point.source !== 'photon-find-my'
      || !finite(point.latitude) || point.latitude < -90 || point.latitude > 90
      || !finite(point.longitude) || point.longitude < -180 || point.longitude > 180
      || (point.accuracy !== null && (!finite(point.accuracy) || point.accuracy < 0 || point.accuracy > 1000))
      || !finite(point.timestamp) || point.timestamp < 0 || at - point.timestamp > HOURS_2 || point.timestamp - at > 10_000
      || !finite(point.receivedAt) || point.receivedAt < 0 || point.receivedAt - at > 10_000
      || !Number.isSafeInteger(point.sourceSequence) || point.sourceSequence < 0
      || (point.expiresAt !== undefined && (!finite(point.expiresAt) || point.expiresAt <= at))) return false;
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT timestamp,sequence FROM location_native_cursors WHERE subject_key=?').get(key);
      if (previous && (point.timestamp < Number(previous.timestamp)
        || (point.timestamp === Number(previous.timestamp) && point.sourceSequence <= Number(previous.sequence)))) return false;
      this.db.prepare('INSERT OR REPLACE INTO location_native_cursors VALUES (?,?,?)').run(key, point.timestamp, point.sourceSequence);
      const stored: StoredNativePosition = { subject: { ...subject }, point: { ...point } };
      // Provider expiry may shorten retention; cached receipt must never renew capture freshness.
      const expiresAt = Math.min(point.expiresAt ?? Infinity, point.timestamp + HOURS_2);
      this.db.prepare('INSERT OR REPLACE INTO location_native_positions VALUES (?,?,?)').run(key, expiresAt, JSON.stringify(stored));
      return true;
    });
  }
  clearNative(subject: NativeLocationSubject): void {
    const key = this.nativeKey(subject); if (!key) return;
    // Preserve the capture cursor so the same removed cached sample cannot reappear.
    this.db.prepare('DELETE FROM location_native_positions WHERE subject_key=?').run(key);
  }
  private cleanupPositions(at: number): void {
    // Limit cleanup work per view; grants, replay cursors and invitation evidence stay intact.
    this.db.prepare('DELETE FROM location_native_positions WHERE subject_key IN (SELECT subject_key FROM location_native_positions WHERE expires_at<=? LIMIT 100)').run(at);
    this.db.prepare(`DELETE FROM location_positions WHERE grant_id IN (
      SELECT p.grant_id FROM location_positions p JOIN location_grants g ON g.id=p.grant_id
      WHERE json_extract(g.body,'$.revoked')=1 OR json_extract(g.body,'$.expiresAt')<=? LIMIT 100)`).run(at);
  }
  private position(role: 'wearer' | 'responder', active: Incident | null): { point: LocationPointView; mode: LocationInput['mode'] } | null {
    const at = this.time();
    const rows = this.db.prepare('SELECT g.body AS grant,p.body AS position,p.rowid AS position_order FROM location_positions p JOIN location_grants g ON g.id=p.grant_id').all();
    const browser = rows.flatMap(row => {
      const grant = JSON.parse(String(row.grant)) as StoredGrant, position = JSON.parse(String(row.position)) as StoredPosition;
      if (grant.role !== role || grant.revoked || at >= grant.expiresAt || (role === 'responder'
        && (terminal(active) || !active!.ownerId || grant.incidentId !== active!.id || grant.responderId !== active!.ownerId))) return [];
      return [{ position, name: role === 'wearer' ? this.wearerName : grant.name, mode: position.mode, order: Number(row.position_order) }];
    });
    const native = this.db.prepare('SELECT body,expires_at,rowid AS position_order FROM location_native_positions').all().flatMap(row => {
      const { subject, point } = JSON.parse(String(row.body)) as StoredNativePosition;
      if (subject.role !== role || at >= Number(row.expires_at) || (role === 'responder'
        && (terminal(active) || !active!.ownerId || subject.incidentId !== active!.id || subject.responderId !== active!.ownerId))) return [];
      return [{ position: point, name: subject.name, mode: undefined, order: Number(row.position_order) }];
    });
    const eligible = [...browser, ...native].sort((a, b) => b.position.timestamp - a.position.timestamp
      || b.position.receivedAt - a.position.receivedAt || b.order - a.order);
    const latest = eligible[0]; if (!latest) return null;
    const { position } = latest, ageMs = Math.max(0, at - position.timestamp);
    return { point: { latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy,
      timestamp: position.timestamp, receivedAt: position.receivedAt, ageMs,
      fresh: ageMs <= 60_000 && at >= position.receivedAt && position.timestamp - at <= 10_000,
      name: latest.name, source: position.source }, mode: latest.mode };
  }
  view(active: Incident | null): LocationView {
    this.cleanupPositions(this.time());
    const wearer = this.position('wearer', active), responder = this.position('responder', active);
    let eta: LocationView['eta'] = null;
    if (wearer?.point.fresh && responder?.point.fresh && wearer.point.accuracy !== null && responder.point.accuracy !== null
      && wearer.point.accuracy <= 100 && responder.point.accuracy <= 100
      && wearer.mode !== 'driving' && responder.mode !== 'driving') {
      const radians = (value: number) => value * Math.PI / 180;
      const a = wearer.point, b = responder.point, deltaLat = radians(a.latitude - b.latitude), deltaLon = radians(a.longitude - b.longitude);
      const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(deltaLon / 2) ** 2;
      const distanceMeters = 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
      eta = { seconds: Math.ceil(distanceMeters / 1.2), distanceMeters, method: 'straight-line-walking-estimate',
        updatedAt: Math.max(a.receivedAt, b.receivedAt) };
    }
    const detail = !wearer ? 'Wearer location is not shared.' : !wearer.point.fresh ? 'Wearer location is stale; no approach estimate.'
      : !responder ? 'Wearer location shared; no accepted owner location is available.'
        : !eta ? 'Location accuracy, freshness or travel mode prevents a walking estimate.'
          : 'Straight-line walking estimate at 1.2 m/s; not a road route or confirmed arrival.';
    return { configured: true, wearer: wearer?.point ?? null, responder: responder?.point ?? null, eta, detail, invite: this.inviteStatus() };
  }
  private invites(): StoredInvite[] {
    return this.db.prepare('SELECT body FROM location_invites ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as StoredInvite);
  }
  private saveInvite(invite: StoredInvite): void {
    this.db.prepare('UPDATE location_invites SET status=?,body=? WHERE id=?').run(invite.status, JSON.stringify(invite), invite.id);
  }
  queueInvite(text: string): boolean {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return false;
    return this.transaction(() => {
      if (this.invites().some(invite => ['queued', 'attempting'].includes(invite.status))) return false;
      const invite: StoredInvite = { id: randomUUID(), text: text.trim(), status: 'queued', attempts: 0, createdAt: this.time() };
      return this.db.prepare('INSERT OR IGNORE INTO location_invites VALUES (?,?,?,?)')
        .run(invite.id, createHash('sha256').update(invite.text).digest('hex'), invite.status, JSON.stringify(invite)).changes === 1;
    });
  }
  claimInvite(): { id: string; text: string } | null {
    return this.transaction(() => {
      const invite = this.invites().find(invite => invite.status === 'queued'); if (!invite) return null;
      invite.status = 'attempting'; invite.attempts++; this.saveInvite(invite); return { id: invite.id, text: invite.text };
    });
  }
  finishInvite(id: string, result: ProviderResult): void {
    this.transaction(() => {
      const invite = this.invites().find(invite => invite.id === id); if (!invite || invite.status !== 'attempting') return;
      invite.status = result.status === 'provider_accepted' && !validId(result.messageId) ? 'unknown' : result.status;
      invite.result = { ...result, status: invite.status }; this.saveInvite(invite);
    });
  }
  inviteStatus(): LocationInviteStatus | null {
    const invite = this.invites().at(-1); if (!invite) return null;
    const descriptions: Record<LocationInviteStatus['status'], string> = {
      queued: 'Location invitation queued.', attempting: 'Submitting location invitation.',
      provider_accepted: 'Provider accepted the location invitation; recipient delivery is unverified.',
      failed: 'Location invitation submission failed; no automatic retry.',
      unknown: 'Location invitation outcome is unknown; no automatic retry.', cancelled: 'Location invitation submission cancelled.',
    };
    return { status: invite.status, detail: descriptions[invite.status] };
  }
  close(): void { this.db.close(); }
}
