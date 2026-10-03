import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Action, ActionType, Evidence, Incident, Phase, Responder, TimelineEvent } from './contracts.ts';

export const terminal = (phase: Phase) => phase === 'RESOLVED' || phase === 'CANCELLED_FALSE_ALARM';
type StoredIncident = Incident & { contacted: string[]; declined: string[] };
export interface Policy { checkinMs: number; acceptMs: number; progressMs: number }
export class PolicyError extends Error {}

export class Controller {
  readonly db: DatabaseSync;
  readonly responders: Responder[];
  readonly policy: Policy;
  private readonly now: () => number;

  constructor(path: string, responders: Responder[], now = Date.now,
    policy: Policy = { checkinMs: 20_000, acceptMs: 60_000, progressMs: 120_000 }) {
    if (responders.some(r => !r.id || !r.name) || new Set(responders.map(r => r.id)).size !== responders.length)
      throw new Error('Responder IDs must be unique and named.');
    this.responders = responders; this.now = now; this.policy = policy;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, phase TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active ON incidents((1)) WHERE phase NOT IN ('RESOLVED','CANCELLED_FALSE_ALARM');
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL, next_at REAL NOT NULL, provider_message_id TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound (id TEXT PRIMARY KEY);
    `);
    for (const row of this.db.prepare("SELECT body FROM actions WHERE status='attempting'").all()) {
      const a = JSON.parse(String(row.body)) as Action;
      a.status = 'unknown'; a.providerResult = 'Previous worker stopped during send; reconcile before retrying.';
      this.saveAction(a);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  active(): StoredIncident | null {
    const row = this.db.prepare("SELECT body FROM incidents WHERE phase NOT IN ('RESOLVED','CANCELLED_FALSE_ALARM') LIMIT 1").get();
    return row ? JSON.parse(String(row.body)) as StoredIncident : null;
  }
  latest(): StoredIncident | null {
    return this.active() ?? (() => {
      const row = this.db.prepare('SELECT body FROM incidents ORDER BY rowid DESC LIMIT 1').get();
      return row ? JSON.parse(String(row.body)) as StoredIncident : null;
    })();
  }
  private current(id: string): StoredIncident {
    const i = this.active();
    if (!i || i.id !== id) throw new PolicyError('Incident is stale or already closed.');
    return i;
  }
  private responder(id: string): Responder {
    const r = this.responders.find(r => r.id === id);
    if (!r) throw new PolicyError('Responder is not approved.');
    return r;
  }
  private save(i: StoredIncident): void {
    this.db.prepare('INSERT INTO incidents(id,phase,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,body=excluded.body')
      .run(i.id, i.phase, JSON.stringify(i));
  }
  private event(i: Incident, type: string, actor: string, detail: string): void {
    const e: TimelineEvent = { id: randomUUID(), incidentId: i.id, type, actor, detail, at: this.now() };
    this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(e.id, i.id, JSON.stringify(e));
  }
  private phase(i: StoredIncident, phase: Phase, actor: string, detail: string): void {
    i.phase = phase; i.version++; i.updatedAt = this.now(); this.save(i); this.event(i, phase, actor, detail);
  }
  private enqueue(i: StoredIncident, type: ActionType, recipientId: string | null, text: string): void {
    const a: Action = { id: randomUUID(), incidentId: i.id, type, recipientId, text,
      status: 'queued', attempts: 0, providerMessageId: null, providerResult: null,
      nextAttemptAt: this.now(), createdAt: this.now() };
    const key = `${i.id}:${i.version}:${type}:${recipientId ?? 'subject'}`;
    this.db.prepare('INSERT OR IGNORE INTO actions VALUES(?,?,?,?,?,?,?)')
      .run(a.id, i.id, key, a.status, a.nextAttemptAt, null, JSON.stringify(a));
  }
  private notify(i: StoredIncident, text: string): void {
    for (const id of i.contacted) this.enqueue(i, 'status', id, text);
  }
  private stopPending(i: Incident): void {
    for (const a of this.actions(i.id).filter(a => a.status === 'queued' || a.status === 'failed')) {
      a.status = 'cancelled'; a.providerResult = 'Action no longer permitted by current incident state.'; this.saveAction(a);
    }
  }
  private requestHelp(i: StoredIncident, why: string): void {
    i.ownerId = null; i.progressDeadline = this.now() + this.policy.acceptMs;
    this.phase(i, 'HELP_REQUESTED', 'policy', why);
    const eligible = this.responders.filter(r => !i.contacted.includes(r.id) && !i.declined.includes(r.id)).slice(0, 2);
    for (const r of eligible) {
      i.contacted.push(r.id);
      this.enqueue(i, 'alert', r.id, `LIFELINE ${i.id}: Possible incident. ${i.evidence.summary}\n${i.handoff}\nReact 👍 to this alert to accept, or reply ON IT ${i.id}.`);
    }
    this.save(i);
    if (!eligible.length) this.event(i, 'UNASSIGNED', 'policy', 'No additional approved responder is available; incident remains unresolved.');
  }

  trigger(evidence: Evidence): Incident {
    return this.transaction(() => {
      const existing = this.active();
      if (existing) {
        if (evidence.kind === 'manual' && existing.phase === 'CONFIRMING') this.requestHelp(existing, 'Subject explicitly requested help.');
        return existing;
      }
      const t = this.now();
      const i: StoredIncident = {
        id: `LF-${randomUUID().slice(0, 8).toUpperCase()}`, phase: 'DETECTED', version: 1,
        createdAt: t, updatedAt: t, evidence, checkinId: randomUUID(), checkinDeadline: t + this.policy.checkinMs,
        progressDeadline: null, ownerId: null, handoff: 'Synthetic health context pending. Unknowns remain unknown.',
        outcome: null, resolutionActor: null, contacted: [], declined: []
      };
      this.save(i); this.event(i, 'DETECTED', 'sensor-or-operator', evidence.summary);
      this.phase(i, 'CONFIRMING', 'policy', 'Current check-in opened. Explicit cancellation is required.');
      this.enqueue(i, 'checkin', null, 'I detected a possible fall. Do you need help? Tap I do not need help to cancel this check-in.');
      if (evidence.kind === 'manual') this.requestHelp(i, 'Explicit manual help request.');
      return i;
    });
  }
  cancel(id: string, checkinId: string): void {
    this.transaction(() => {
      const i = this.current(id);
      if (i.checkinId !== checkinId || i.phase !== 'CONFIRMING')
        throw new PolicyError('Cancellation must target the current unresolved check-in. After escalation, responder outcome is required.');
      i.progressDeadline = null; this.phase(i, 'CANCELLED_FALSE_ALARM', 'subject-control', 'Subject explicitly cancelled the current check-in.'); this.stopPending(i);
    });
  }
  accept(id: string, responderId: string, inboundId?: string): void {
    this.transaction(() => {
      const i = this.current(id); const r = this.responder(responderId);
      if (inboundId && this.db.prepare('SELECT id FROM inbound WHERE id=?').get(inboundId)) return;
      if (i.ownerId === responderId) return;
      if (i.phase !== 'HELP_REQUESTED' || i.ownerId || i.declined.includes(responderId))
        throw new PolicyError('Incident has an owner or is not accepting responders.');
      if (!i.contacted.includes(responderId)) throw new PolicyError('Responder has not been contacted for this incident.');
      if (inboundId) this.db.prepare('INSERT INTO inbound VALUES(?)').run(inboundId);
      i.ownerId = responderId; i.progressDeadline = this.now() + this.policy.progressMs;
      this.phase(i, 'ACKNOWLEDGED', responderId, `${r.name} accepted responsibility; departure is not yet confirmed.`);
      this.stopPending(i);
      this.notify(i, `${r.name} accepted ${i.id}. Waiting for departure confirmation. Keep available for updates.`);
    });
  }
  progress(id: string, responderId: string, stage: 'depart' | 'arrive'): void {
    this.transaction(() => {
      const i = this.current(id); const r = this.responder(responderId);
      if (i.ownerId !== r.id) throw new PolicyError('Only the assigned owner can update progress.');
      const allowed = stage === 'depart' ? ['ACKNOWLEDGED'] : ['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE'];
      if (!allowed.includes(i.phase)) throw new PolicyError('Progress update is not valid for this phase.');
      i.progressDeadline = this.now() + this.policy.progressMs;
      this.phase(i, stage === 'depart' ? 'RESPONDER_EN_ROUTE' : 'ON_SCENE', r.id, stage === 'depart' ? 'Owner explicitly reported departure.' : 'Owner explicitly reported arrival.');
      this.notify(i, `${r.name} ${stage === 'depart' ? 'is on the way' : 'reported arrival'} for ${i.id}.`);
    });
  }
  decline(id: string, responderId: string): void {
    this.transaction(() => {
      const i = this.current(id); this.responder(responderId);
      if (!i.contacted.includes(responderId)) throw new PolicyError('Responder was not contacted.');
      if (!i.declined.includes(responderId)) i.declined.push(responderId);
      this.event(i, 'DECLINED', responderId, 'Responder explicitly declined.');
      if (i.ownerId === responderId) {
        this.stopPending(i); this.requestHelp(i, 'Previous owner declined; responsibility is unassigned.');
        for (const r of this.responders.filter(r => i.contacted.includes(r.id) && !i.declined.includes(r.id)))
          this.enqueue(i, 'alert', r.id, `${i.id}: Previous owner is unavailable. React 👍 to accept responsibility.\n${i.handoff}`);
      } else this.save(i);
    });
  }
  resolve(id: string, responderId: string, outcome: string): void {
    this.transaction(() => {
      const i = this.current(id); this.responder(responderId);
      if (i.ownerId !== responderId || i.phase !== 'ON_SCENE') throw new PolicyError('Only the on-scene owner can resolve the incident.');
      if (typeof outcome !== 'string' || outcome.trim().length < 5 || outcome.length > 2000) throw new PolicyError('A concrete outcome is required (5–2000 characters).');
      i.outcome = outcome.trim(); i.resolutionActor = responderId; i.progressDeadline = null;
      this.phase(i, 'RESOLVED', responderId, i.outcome); this.stopPending(i);
      this.notify(i, `${i.id} closed by the on-scene owner. Outcome: ${i.outcome}`);
    });
  }
  tick(): void {
    this.transaction(() => {
      const i = this.active(); if (!i) return;
      if (i.phase === 'CONFIRMING' && this.now() >= i.checkinDeadline) { this.requestHelp(i, 'Check-in deadline expired without explicit cancellation.'); return; }
      if (i.progressDeadline === null || this.now() < i.progressDeadline) return;
      if (i.phase === 'HELP_REQUESTED') this.requestHelp(i, 'Acceptance deadline expired; trying next eligible contacts.');
      else if (i.ownerId) {
        const prior = i.ownerId; i.declined.push(prior); this.stopPending(i);
        this.requestHelp(i, 'Owner progress deadline expired; responsibility must be accepted again.');
        for (const r of this.responders.filter(r => i.contacted.includes(r.id) && !i.declined.includes(r.id)))
          this.enqueue(i, 'alert', r.id, `${i.id}: Previous owner missed the progress deadline. React 👍 if you can take responsibility.\n${i.handoff}`);
      }
    });
  }
  setHandoff(id: string, handoff: string): void {
    this.transaction(() => {
      const i = this.current(id); i.handoff = handoff; i.updatedAt = this.now(); this.save(i);
      for (const a of this.actions(id).filter(a => a.type === 'alert' && a.status === 'queued')) {
        a.text = `LIFELINE ${i.id}: ${i.evidence.summary}\n${handoff}\nReact 👍 to accept responsibility, or reply ON IT ${i.id}.`; this.saveAction(a);
      }
      const alreadyAttempted = new Set(this.actions(id).filter(a => a.type === 'alert'
        && ['attempting', 'provider_accepted', 'unknown'].includes(a.status)).map(a => a.recipientId));
      for (const recipient of alreadyAttempted) if (recipient)
        this.enqueue(i, 'handoff', recipient, `${i.id}: Updated synthetic health context.\n${handoff}`);
    });
  }
  reset(): void {
    this.transaction(() => {
      const i = this.active(); if (!i) return;
      i.outcome = 'Development reset; not a safety determination.'; i.resolutionActor = 'development-operator';
      i.progressDeadline = null; this.phase(i, 'CANCELLED_FALSE_ALARM', 'development-operator', i.outcome); this.stopPending(i);
    });
  }
  events(id: string): TimelineEvent[] {
    return this.db.prepare('SELECT body FROM events WHERE incident_id=? ORDER BY rowid').all(id).map(row => JSON.parse(String(row.body)) as TimelineEvent);
  }
  actions(id: string): Action[] {
    return this.db.prepare('SELECT body FROM actions WHERE incident_id=? ORDER BY rowid').all(id).map(row => JSON.parse(String(row.body)) as Action);
  }
  private saveAction(a: Action): void {
    this.db.prepare('UPDATE actions SET status=?,next_at=?,provider_message_id=?,body=? WHERE id=?')
      .run(a.status, a.nextAttemptAt, a.providerMessageId, JSON.stringify(a), a.id);
  }
  claimAction(): Action | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT body FROM actions WHERE status IN ('queued','failed') AND next_at<=? ORDER BY rowid").all(this.now())
        .find(row => { const a = JSON.parse(String(row.body)) as Action; return a.type !== 'checkin' && a.attempts < 3; });
      if (!row) return null;
      const a = JSON.parse(String(row.body)) as Action;
      a.status = 'attempting'; a.attempts++; this.saveAction(a); return a;
    });
  }
  finishAction(id: string, status: 'provider_accepted' | 'failed' | 'unknown', detail: string, messageId?: string): void {
    const row = this.db.prepare('SELECT body FROM actions WHERE id=?').get(id); if (!row) return;
    const a = JSON.parse(String(row.body)) as Action;
    a.status = status; a.providerResult = detail; a.providerMessageId = messageId ?? null;
    a.nextAttemptAt = this.now() + Math.min(60_000, 5000 * 2 ** a.attempts); this.saveAction(a);
  }
  incidentForMessage(messageId: string, responderId: string): Incident | null {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row) return null;
    const a = JSON.parse(String(row.body)) as Action; const i = this.active();
    return i && a.incidentId === i.id && a.recipientId === responderId && a.type === 'alert' ? i : null;
  }
  seenInbound(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM inbound WHERE id=?').get(id)); }
  rememberInbound(id: string): void { this.db.prepare('INSERT OR IGNORE INTO inbound VALUES(?)').run(id); }
  close(): void { this.db.close(); }
}
