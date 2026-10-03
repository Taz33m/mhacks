import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Action, ActionType, CheckinDecision, CheckinReply, Evidence, HealthContext, Incident, Phase, ProviderInbound, Responder, TimelineEvent } from './contracts.ts';
import { classifyCheckinReply } from './checkin.ts';

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
      CREATE TABLE IF NOT EXISTS clinical_context (incident_id TEXT PRIMARY KEY, body TEXT NOT NULL);
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
  incident(id: string): Incident | null {
    const row = this.db.prepare('SELECT body FROM incidents WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as Incident : null;
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
  private enqueue(i: StoredIncident, type: ActionType, recipientId: string | null, text: string, dedupeKey?: string): Action | null {
    const a: Action = { id: randomUUID(), incidentId: i.id, type, recipientId, text,
      status: 'queued', attempts: 0, providerMessageId: null, providerResult: null,
      nextAttemptAt: this.now(), createdAt: this.now() };
    const key = dedupeKey ?? `${i.id}:${i.version}:${type}:${recipientId ?? 'subject'}`;
    const inserted = this.db.prepare('INSERT OR IGNORE INTO actions VALUES(?,?,?,?,?,?,?)')
      .run(a.id, i.id, key, a.status, a.nextAttemptAt, null, JSON.stringify(a)).changes === 1;
    return inserted ? a : null;
  }
  private notify(i: StoredIncident, text: string): void {
    for (const id of i.contacted) this.enqueue(i, 'status', id, text);
    this.enqueue(i, 'wearer_status', null, text.split('\n')[0]);
  }
  private report(i: Incident, event?: ProviderInbound): void {
    if (!event) return;
    this.rememberInbound(event.messageId);
    this.event(i, 'RESPONDER_REPORT', 'photon-imessage', JSON.stringify({
      inboundId: event.messageId, transcript: event.text ?? null, reaction: event.reaction ?? null,
      providerTimestamp: event.providerTimestamp ?? null, phase: i.phase,
    }));
  }
  private stopPending(i: Incident, types?: ActionType[]): void {
    for (const a of this.actions(i.id).filter(a => (a.status === 'queued' || a.status === 'failed') && (!types || types.includes(a.type)))) {
      a.status = 'cancelled'; a.providerResult = 'Action no longer permitted by current incident state.'; this.saveAction(a);
    }
  }
  private requestHelp(i: StoredIncident, why: string): void {
    this.stopPending(i, ['checkin', 'wearer_checkin', 'wearer_ack']);
    i.ownerId = null; i.progressDeadline = this.now() + this.policy.acceptMs;
    this.phase(i, 'HELP_REQUESTED', 'policy', why);
    const eligible = this.responders.filter(r => !i.contacted.includes(r.id) && !i.declined.includes(r.id)).slice(0, 2);
    // Once the approved list is exhausted, wait for a reply without producing
    // a new wearer message on every acceptance timeout.
    if (!eligible.length) i.progressDeadline = null;
    for (const r of eligible) {
      i.contacted.push(r.id);
      this.enqueue(i, 'alert', r.id, this.alertText(i));
    }
    this.save(i);
    this.enqueue(i, 'wearer_status', null, `${i.id}: Help requested. No responder has accepted yet. ${eligible.length ? 'Approved contacts are being notified.' : 'No additional approved contact is available.'}`,
      `${i.id}:${i.version}:wearer_status:help`);
    if (!eligible.length) this.event(i, 'UNASSIGNED', 'policy', 'No additional approved responder is available; incident remains unresolved.');
  }
  private alertText(i: Incident): string {
    const evidence = i.handoffGeneration ? '' : `${i.evidence.summary}\n`;
    return `LIFELINE ${i.id}: Possible incident.\n${evidence}${i.handoff}\nReact 👍 to this alert to accept responsibility, or reply ON IT ${i.id}. If unavailable, reply DECLINE ${i.id}.`;
  }

  trigger(evidence: Evidence): Incident {
    return this.transaction(() => this.triggerInternal(evidence));
  }
  private triggerInternal(evidence: Evidence): Incident {
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
      this.enqueue(i, 'checkin', null, "I detected a possible fall. Do you need help? You can say I need help, or tap I don't need help to cancel.");
      this.enqueue(i, 'wearer_checkin', null, `LIFELINE ${i.id}: I detected a possible fall. Are you okay?\nReply I NEED HELP ${i.id} to request help. If you are okay, tap I don't need help in LIFELINE before the check-in ends.`);
      if (evidence.kind === 'manual') this.requestHelp(i, 'Explicit manual help request.');
      return i;
  }
  cancel(id: string, checkinId: string): void {
    this.transaction(() => {
      const i = this.current(id);
      if (i.checkinId !== checkinId || i.phase !== 'CONFIRMING' || this.now() >= i.checkinDeadline)
        throw new PolicyError('Cancellation must target the current unresolved check-in. After escalation, responder outcome is required.');
      i.progressDeadline = null; this.phase(i, 'CANCELLED_FALSE_ALARM', 'subject-control', 'Subject explicitly cancelled the current check-in.'); this.stopPending(i);
      this.enqueue(i, 'wearer_status', null, `${i.id}: You explicitly cancelled this check-in. No further check-in alerts will be sent.`);
    });
  }
  recordCheckinReply(reply: CheckinReply): CheckinDecision {
    if (!['ios-on-device-speech', 'freewili-local-speech'].includes(reply.source)) throw new PolicyError('A final device transcript of 1–500 characters is required.');
    return this.applyCheckinReply(reply, reply.source)!;
  }
  recordWearerCheckinReply(reply: Omit<CheckinReply, 'source'>, inboundId: string, event?: ProviderInbound): CheckinDecision | null {
    if (typeof inboundId !== 'string' || !inboundId.trim() || inboundId.length > 500) throw new PolicyError('A provider message ID is required.');
    return this.applyCheckinReply(reply, 'photon-imessage', inboundId, event);
  }
  private applyCheckinReply(reply: Omit<CheckinReply, 'source'>, source: 'ios-on-device-speech' | 'freewili-local-speech' | 'photon-imessage', inboundId?: string, event?: ProviderInbound): CheckinDecision | null {
    return this.transaction(() => {
      if (inboundId && this.seenInbound(inboundId)) return null;
      const i = this.current(reply.incidentId);
      if (i.phase !== 'CONFIRMING' || i.checkinId !== reply.checkinId || this.now() >= i.checkinDeadline)
        throw new PolicyError('Reply must target the current check-in before its deadline.');
      if (typeof reply.transcript !== 'string'
        || !reply.transcript.trim() || reply.transcript.length > 500)
        throw new PolicyError('A check-in reply of 1–500 characters is required.');
      const transcript = reply.transcript.trim();
      const decision = classifyCheckinReply(transcript);
      this.event(i, 'CHECKIN_REPLY', source, JSON.stringify({ transcript, decision }));
      if (decision === 'help_requested') this.requestHelp(i, source === 'photon-imessage'
        ? 'Wearer requested help in the current Photon iMessage check-in.' : 'Subject requested help in the current spoken check-in.');
      if (source === 'photon-imessage' && inboundId && decision === 'confirmation_required') {
        const inserted = this.enqueue(i, 'wearer_ack', null,
          "Glad you're okay. To close this check-in, tap 'I DON'T NEED HELP' on your phone.",
          `${i.id}:${i.version}:wearer_ack:${JSON.stringify([i.checkinId, inboundId])}`);
        if (!inserted) throw new Error('Wearer acknowledgement was not persisted; inbound ID remains unprocessed.');
        if (event?.chatId && event.lineId) {
          inserted.replyToMessageId = inboundId; inserted.replyChatId = event.chatId; inserted.replyLineId = event.lineId;
          this.saveAction(inserted);
        }
      }
      if (inboundId) this.rememberInbound(inboundId);
      return decision;
    });
  }
  accept(id: string, responderId: string, inboundId?: string, event?: ProviderInbound): void {
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
      this.notify(i, `${r.name} accepted ${i.id}. Departure has not been confirmed.\nAssigned responder ${r.name}: reply DEPART ${i.id} when leaving, ARRIVED ${i.id} when on scene, or DECLINE ${i.id} if unavailable. Other contacts: keep available for updates.`);
      this.addNaturalGuidance(i, r.id, 'Reply directly to this message with “leaving”, “arrived”, or “I can’t help”. You can also ask about the recorded health information.');
      this.report(i, event);
    });
  }
  private addNaturalGuidance(i: Incident, ownerId: string, text: string): void {
    const a = this.actions(i.id).findLast(a => a.type === 'status' && a.recipientId === ownerId && a.status === 'queued');
    if (a) { a.text += `\n${text}`; this.saveAction(a); }
  }
  progress(id: string, responderId: string, stage: 'depart' | 'arrive', event?: ProviderInbound): void {
    this.transaction(() => {
      if (event && this.seenInbound(event.messageId)) return;
      const i = this.current(id); const r = this.responder(responderId);
      if (i.ownerId !== r.id) throw new PolicyError('Only the assigned owner can update progress.');
      const allowed = stage === 'depart' ? ['ACKNOWLEDGED'] : ['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE'];
      if (!allowed.includes(i.phase)) throw new PolicyError('Progress update is not valid for this phase.');
      i.progressDeadline = this.now() + this.policy.progressMs;
      this.phase(i, stage === 'depart' ? 'RESPONDER_EN_ROUTE' : 'ON_SCENE', r.id, stage === 'depart' ? 'Owner explicitly reported departure.' : 'Owner explicitly reported arrival.');
      this.notify(i, stage === 'depart'
        ? `${r.name} reported departure for ${i.id}.\nAssigned responder ${r.name}: reply ARRIVED ${i.id} when on scene, or DECLINE ${i.id} if unavailable. Other contacts: keep available for updates.`
        : `${r.name} reported arrival for ${i.id}. An outcome has not been recorded.\nAssigned responder ${r.name}: reply RESOLVED ${i.id} <concrete outcome>, replacing <concrete outcome> with what you observed and what help was provided. If unable to continue, reply DECLINE ${i.id}.`);
      this.addNaturalGuidance(i, r.id, stage === 'depart'
        ? 'Reply directly with “arrived” when you are with the wearer.'
        : 'Reply directly with “resolved: ” followed by what you observed and what help was provided.');
      this.report(i, event);
    });
  }
  decline(id: string, responderId: string, event?: ProviderInbound): void {
    this.transaction(() => {
      if (event && this.seenInbound(event.messageId)) return;
      const i = this.current(id); this.responder(responderId);
      if (!i.contacted.includes(responderId)) throw new PolicyError('Responder was not contacted.');
      if (!i.declined.includes(responderId)) i.declined.push(responderId);
      this.event(i, 'DECLINED', responderId, 'Responder explicitly declined.');
      if (i.ownerId === responderId) {
        this.stopPending(i); this.requestHelp(i, 'Previous owner declined; responsibility is unassigned.');
        for (const r of this.responders.filter(r => i.contacted.includes(r.id) && !i.declined.includes(r.id)))
          this.enqueue(i, 'alert', r.id, `${i.id}: Previous owner is unavailable.\n${i.handoff}\nReact 👍 to this alert to accept responsibility, or reply ON IT ${i.id}. If unavailable, reply DECLINE ${i.id}.`);
      } else this.save(i);
      this.report(i, event);
    });
  }
  resolve(id: string, responderId: string, outcome: string, event?: ProviderInbound): void {
    this.transaction(() => {
      if (event && this.seenInbound(event.messageId)) return;
      const i = this.current(id); this.responder(responderId);
      if (i.ownerId !== responderId || i.phase !== 'ON_SCENE') throw new PolicyError('Only the on-scene owner can resolve the incident.');
      if (typeof outcome !== 'string' || outcome.trim().length < 5 || outcome.length > 2000) throw new PolicyError('A concrete outcome is required (5–2000 characters).');
      i.outcome = outcome.trim(); i.resolutionActor = responderId; i.progressDeadline = null;
      this.phase(i, 'RESOLVED', responderId, i.outcome); this.stopPending(i);
      this.notify(i, `${i.id} closed by the on-scene owner. Outcome: ${i.outcome}`);
      this.report(i, event);
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
          this.enqueue(i, 'alert', r.id, `${i.id}: Previous owner missed the progress deadline.\n${i.handoff}\nReact 👍 to this alert to accept responsibility, or reply ON IT ${i.id}. If unavailable, reply DECLINE ${i.id}.`);
      }
    });
  }
  setHandoff(id: string, handoff: string, provenance?: { generation: 'ai' | 'degraded'; healthRevision?: string }): void {
    this.transaction(() => {
      const i = this.current(id);
      if (provenance?.healthRevision && provenance.healthRevision !== i.healthRevision)
        throw new PolicyError('Handoff revision must match the incident clinical snapshot.');
      i.handoff = handoff; i.handoffGeneration = provenance?.generation; i.updatedAt = this.now(); this.save(i);
      if (provenance) this.event(i, 'HANDOFF_PREPARED', 'context-composer', JSON.stringify({
        generation: provenance.generation, clinicalRevision: provenance.healthRevision ?? null,
      }));
      for (const a of this.actions(id).filter(a => a.type === 'alert' && a.status === 'queued')) {
        a.text = this.alertText(i); this.saveAction(a);
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
  boardButton(action: 'help' | 'cancel', incidentId: string | null, checkinId: string | null, eventId: string): Incident | null {
    return this.transaction(() => {
      const inboundId = `freewili:${eventId}`;
      if (this.seenInbound(inboundId)) return null;
      const active = this.active();
      if (active && (active.id !== incidentId || active.checkinId !== checkinId))
        throw new PolicyError('Board control must target the current incident and check-in.');
      if (!active && (incidentId !== null || checkinId !== null || action !== 'help'))
        throw new PolicyError('Board control is stale.');
      if (action === 'help') {
        const i = this.triggerInternal({ kind: 'manual', summary: 'Wearer explicitly pressed the FREE-WILi help button.' });
        this.rememberInbound(inboundId); this.event(i, 'DEVICE_BUTTON', 'freewili-button', 'Explicit help request.');
        return i;
      }
      if (!active || active.phase !== 'CONFIRMING' || this.now() >= active.checkinDeadline)
        throw new PolicyError('Board cancellation requires the current check-in before escalation.');
      active.progressDeadline = null;
      this.phase(active, 'CANCELLED_FALSE_ALARM', 'freewili-button', 'Wearer explicitly cancelled using the board button.');
      this.stopPending(active); this.rememberInbound(inboundId);
      this.enqueue(active, 'wearer_status', null, `${active.id}: You explicitly cancelled this check-in on FREE-WILi.`);
      return active;
    });
  }
  actions(id: string): Action[] {
    return this.db.prepare('SELECT body FROM actions WHERE incident_id=? ORDER BY rowid').all(id).map(row => JSON.parse(String(row.body)) as Action);
  }
  healthContext(id: string): HealthContext | null {
    const row = this.db.prepare('SELECT body FROM clinical_context WHERE incident_id=?').get(id);
    return row ? JSON.parse(String(row.body)) as HealthContext : null;
  }
  bindHealthContext(id: string, health: HealthContext): HealthContext {
    return this.transaction(() => {
      const existing = this.healthContext(id); if (existing) return existing;
      const row = this.db.prepare('SELECT body FROM incidents WHERE id=?').get(id);
      if (!row) throw new PolicyError('Unknown incident.');
      const i = JSON.parse(String(row.body)) as StoredIncident;
      // This prototype persists synthetic revisions only; live authorization has a separate lifecycle.
      if (health.patientRecord && (!health.patientRecord.synthetic || health.patientRecord.environment !== 'demo'))
        throw new PolicyError('Only synthetic clinical revisions are supported.');
      this.db.prepare('INSERT INTO clinical_context VALUES(?,?)').run(id, JSON.stringify(health));
      i.healthRevision = health.patientRecord?.revision; this.save(i);
      this.event(i, 'HEALTH_CONTEXT_BOUND', 'finchnode', JSON.stringify({
        revision: i.healthRevision ?? null, retrievedAt: health.retrievedAt,
        available: health.available, recordIds: health.recordIds,
      }));
      return health;
    });
  }
  /** Phone approval alone is insufficient: this chat and line must have an accepted current-incident send. */
  matchesConversation(event: ProviderInbound, recipientId: string | null): boolean {
    const i = this.active();
    if (!i || !event.chatId || !event.lineId) return false;
    return this.actions(i.id).some(a => a.recipientId === recipientId && a.status === 'provider_accepted'
      && Boolean(a.providerMessageId) && a.providerChatId === event.chatId && a.providerLineId === event.lineId
      && (recipientId === null ? ['wearer_checkin', 'wearer_ack', 'wearer_status'].includes(a.type)
        : ['alert', 'status', 'handoff', 'answer'].includes(a.type)));
  }
  messageMatchesConversation(messageId: string, event: ProviderInbound): boolean {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row || !event.chatId || !event.lineId) return false;
    const a = JSON.parse(String(row.body)) as Action;
    return a.providerChatId === event.chatId && a.providerLineId === event.lineId;
  }
  queueAnswer(id: string, version: number, responderId: string, inboundId: string, text: string,
    audit?: { question: string; generation?: 'ai' | 'degraded' | 'policy_refusal'; event?: ProviderInbound }): boolean {
    return this.transaction(() => {
      if (this.seenInbound(inboundId)) return false;
      const i = this.current(id); this.responder(responderId);
      if (i.version !== version || !i.contacted.includes(responderId) || i.declined.includes(responderId))
        throw new PolicyError('Answer must target the current incident version and an eligible contacted responder.');
      if (typeof inboundId !== 'string' || !inboundId.trim() || inboundId.length > 500)
        throw new PolicyError('A provider message ID is required.');
      if (typeof text !== 'string' || !text.trim() || text.length > 6000)
        throw new PolicyError('An answer of 1–6000 characters is required.');
      if (audit && (typeof audit.question !== 'string' || !audit.question.trim() || audit.question.length > 2000))
        throw new PolicyError('A responder question of 1–2000 characters is required.');
      const inserted = this.enqueue(i, 'answer', responderId, text,
        `${i.id}:${i.version}:answer:${JSON.stringify([responderId, inboundId])}`);
      if (!inserted) throw new Error('Responder answer was not persisted; inbound ID remains unprocessed.');
      if (audit?.event?.chatId && audit.event.lineId) {
        inserted.replyToMessageId = inboundId; inserted.replyChatId = audit.event.chatId; inserted.replyLineId = audit.event.lineId;
        this.saveAction(inserted);
      }
      this.rememberInbound(inboundId);
      this.event(i, 'ANSWER_QUEUED', responderId, audit ? JSON.stringify({
        question: audit.question, inboundId, actionId: inserted.id,
        source: 'photon-imessage', generation: audit.generation ?? null,
        healthRevision: i.healthRevision ?? null,
      }) : 'Responder answer queued; delivery is not yet established.');
      return true;
    });
  }
  private saveAction(a: Action): void {
    this.db.prepare('UPDATE actions SET status=?,next_at=?,provider_message_id=?,body=? WHERE id=?')
      .run(a.status, a.nextAttemptAt, a.providerMessageId, JSON.stringify(a), a.id);
  }
  actionPermitted(a: Action): boolean {
    const row = this.db.prepare('SELECT body FROM incidents WHERE id=?').get(a.incidentId);
    if (!row) return false;
    const i = JSON.parse(String(row.body)) as StoredIncident;
    if (a.type === 'wearer_checkin' || a.type === 'wearer_ack') return i.phase === 'CONFIRMING' && this.now() < i.checkinDeadline;
    if (a.type === 'wearer_status') {
      if (this.latest()?.id !== i.id) return false;
      const row = this.db.prepare('SELECT dedupe_key FROM actions WHERE id=?').get(a.id);
      return row !== undefined && Number(String(row.dedupe_key).split(':')[1]) === i.version;
    }
    if (!a.recipientId || !this.responders.some(r => r.id === a.recipientId) || !i.contacted.includes(a.recipientId)) return false;
    if (a.type === 'alert') return i.phase === 'HELP_REQUESTED' && !i.ownerId && !i.declined.includes(a.recipientId);
    if (a.type === 'handoff') return !terminal(i.phase) && !i.declined.includes(a.recipientId);
    if (a.type === 'status' || a.type === 'answer') {
      const action = this.db.prepare('SELECT dedupe_key FROM actions WHERE id=?').get(a.id);
      return action !== undefined && Number(String(action.dedupe_key).split(':')[1]) === i.version
        && (a.type !== 'answer' || (!terminal(i.phase) && !i.declined.includes(a.recipientId)));
    }
    return false;
  }
  claimAction(channel: 'any' | 'wearer' | 'responders' = 'any'): Action | null {
    return this.transaction(() => {
      for (const row of this.db.prepare("SELECT body FROM actions WHERE status IN ('queued','failed') AND next_at<=? ORDER BY rowid").all(this.now())) {
        const a = JSON.parse(String(row.body)) as Action;
        if (a.type === 'checkin' || a.attempts >= 3) continue;
        if (channel === 'wearer' && !['wearer_checkin', 'wearer_ack', 'wearer_status'].includes(a.type)) continue;
        if (channel === 'responders' && ['wearer_checkin', 'wearer_ack', 'wearer_status'].includes(a.type)) continue;
        if (!this.actionPermitted(a)) {
          a.status = 'cancelled'; a.providerResult = 'Incident authorization ended; message was not submitted.'; this.saveAction(a); continue;
        }
        a.status = 'attempting'; a.attempts++; this.saveAction(a); return a;
      }
      return null;
    });
  }
  finishAction(id: string, status: 'provider_accepted' | 'failed' | 'unknown' | 'cancelled', detail: string, messageId?: string, conversation?: { chatId?: string; lineId?: string }): void {
    const row = this.db.prepare('SELECT body FROM actions WHERE id=?').get(id); if (!row) return;
    const a = JSON.parse(String(row.body)) as Action;
    a.status = status; a.providerResult = detail; a.providerMessageId = messageId ?? null;
    if (status === 'provider_accepted' && conversation?.chatId && conversation.lineId) {
      a.providerChatId = conversation.chatId; a.providerLineId = conversation.lineId;
    }
    a.nextAttemptAt = this.now() + Math.min(60_000, 5000 * 2 ** a.attempts); this.saveAction(a);
  }
  incidentForMessage(messageId: string, responderId: string): Incident | null {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row) return null;
    const a = JSON.parse(String(row.body)) as Action; const i = this.active();
    return i && a.incidentId === i.id && a.recipientId === responderId && a.type === 'alert' ? i : null;
  }
  responderIncidentForMessage(messageId: string, responderId: string): Incident | null {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row) return null;
    const a = JSON.parse(String(row.body)) as Action; const i = this.active();
    return i && a.incidentId === i.id && a.recipientId === responderId
      && ['alert', 'status', 'handoff', 'answer'].includes(a.type) ? i : null;
  }
  wearerIncidentForMessage(messageId: string): Incident | null {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row) return null;
    const a = JSON.parse(String(row.body)) as Action; const i = this.active();
    return i && i.phase === 'CONFIRMING' && this.now() < i.checkinDeadline
      && a.incidentId === i.id && a.recipientId === null && ['wearer_checkin', 'wearer_ack'].includes(a.type) ? i : null;
  }
  seenInbound(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM inbound WHERE id=?').get(id)); }
  rememberInbound(id: string): void { this.db.prepare('INSERT OR IGNORE INTO inbound VALUES(?)').run(id); }
  close(): void { this.db.close(); }
}
