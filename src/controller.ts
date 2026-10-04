import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Action, ActionType, CheckinDecision, CheckinReply, ConversationMessage, DispatchMode, Evidence, HealthContext, Incident, Phase, ProviderInbound, Responder, TimelineEvent } from './contracts.ts';
import { classifyCheckinReply } from './checkin.ts';
import { phoneIdentity } from './identity.ts';
import type { EventWindow } from './event-window.ts';

export const terminal = (phase: Phase) => phase === 'RESOLVED' || phase === 'CANCELLED_FALSE_ALARM';
type StoredIncident = Incident & { contacted: string[]; declined: string[] };
type StoredConversation = ConversationMessage & { responderId?: string; deviceSessionId?: string; providerTimestamp?: number };
export interface Policy { checkinMs: number; acceptMs: number; progressMs: number }
export class PolicyError extends Error {}
export interface ResponderQuestionPreparation {
  inboundId: string; incidentId: string; incidentVersion: number; responderId: string;
  question: string; event: ProviderInbound; incident: Incident;
  status: 'queued' | 'preparing' | 'answer_queued' | 'discarded' | 'failed';
  attempts: number; nextAttemptAt: number; createdAt: number; updatedAt: number;
  claimId?: string; detail: string | null; answerActionId?: string;
  generation?: 'ai' | 'degraded' | 'policy_refusal';
}

/** A care-team message is spoken to the patient only when it addresses them: it opens with their name
 * ("Morgan, …" / "Morgan Rivera: …") or is a direct contact check ("Can you hear me?"). Everything else stays in chat. */
export function addressedToPatient(text: string, patientName: string): boolean {
  const opening = text.trim().toLowerCase();
  if (/^(?:(?:can|could) you (?:still )?hear me|are you (?:there|ok|okay|alright|all right)|did you hear me)\b/.test(opening)) return true;
  const full = patientName.trim().toLowerCase().replace(/\s+/g, ' ');
  const names = [...new Set([full, full.split(' ')[0]])].filter(Boolean)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return names.length > 0 && new RegExp(`^(?:${names.join('|')})\\s*[,:!—–-]\\s*\\S`).test(opening);
}

export class Controller {
  readonly db: DatabaseSync;
  readonly responders: Responder[];
  readonly policy: Policy;
  readonly wearerName: string;
  readonly dispatchMode: DispatchMode;
  private readonly now: () => number;

  constructor(path: string, responders: Responder[], now = Date.now,
    policy: Policy = { checkinMs: 20_000, acceptMs: 60_000, progressMs: 120_000 }, options: { wearerName?: string; dispatchMode?: DispatchMode } = {}) {
    if (responders.some(r => !r.id || !r.name) || new Set(responders.map(r => r.id)).size !== responders.length)
      throw new Error('Responder IDs must be unique and named.');
    this.responders = responders; this.now = now; this.policy = policy;
    this.dispatchMode = options.dispatchMode ?? 'live';
    if (!['live', 'simulated'].includes(this.dispatchMode)) throw new PolicyError('Unknown dispatch mode.');
    if (this.dispatchMode === 'simulated' && (!responders.length || responders.some(r => r.simulated !== true || r.phone !== null)))
      throw new PolicyError('Simulated dispatch requires explicitly simulated responders without phone numbers.');
    if (this.dispatchMode === 'live' && responders.some(r => r.simulated))
      throw new PolicyError('Simulated responders cannot be used in live dispatch.');
    this.wearerName = options.wearerName?.trim().slice(0, 100) || 'Wearer';
    if (/[\u0000-\u001f\u007f]/.test(this.wearerName)) throw new PolicyError('Wearer name cannot contain control characters.');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, phase TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active ON incidents((1)) WHERE phase NOT IN ('RESOLVED','CANCELLED_FALSE_ALARM');
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL, next_at REAL NOT NULL, provider_message_id TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS clinical_context (incident_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS responder_questions (inbound_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL,
        status TEXT NOT NULL, next_at REAL NOT NULL, body TEXT NOT NULL);
    `);
    const existing = this.active();
    if (existing && (existing.dispatchMode ?? 'live') !== this.dispatchMode) {
      this.db.close();
      throw new PolicyError('Finish the active incident before changing dispatch mode.');
    }
    for (const row of this.db.prepare("SELECT body FROM actions WHERE status='attempting'").all()) {
      const a = JSON.parse(String(row.body)) as Action;
      const local = this.incident(a.incidentId)?.dispatchMode === 'simulated'
        && this.responders.some(r => r.id === a.recipientId && r.simulated && r.phone === null);
      a.status = local ? 'queued' : 'unknown';
      a.providerResult = local ? 'Interrupted local delivery recovered; no external message was submitted.'
        : 'Previous worker stopped during send; reconcile before retrying.';
      this.saveAction(a);
    }
    for (const row of this.db.prepare('SELECT body FROM conversation').all()) {
      const message = JSON.parse(String(row.body)) as StoredConversation;
      if (message.deviceSessionId && ['queued', 'playing'].includes(message.delivery)) {
        message.delivery = 'failed'; message.detail = 'Previous wearable connection ended before playback confirmation; not replayed automatically.';
        this.saveConversation(message);
      }
    }
    for (const row of this.db.prepare("SELECT body FROM responder_questions WHERE status='preparing'").all()) {
      const job = JSON.parse(String(row.body)) as ResponderQuestionPreparation;
      job.status = job.attempts < 3 ? 'queued' : 'failed'; delete job.claimId;
      job.nextAttemptAt = this.now(); job.updatedAt = this.now();
      job.detail = 'Preparation was interrupted before an answer was committed; no reply delivery is established.';
      this.saveResponderQuestion(job);
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
    if (terminal(phase)) {
      for (const message of this.storedConversation(i.id).filter(message => ['queued', 'playing'].includes(message.delivery))) {
        message.delivery = 'failed'; message.detail = 'Incident ended before playback completion was confirmed; queued speech will not be replayed.';
        this.saveConversation(message);
      }
    }
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
    // Care-team status only. The patient hears and reads short, separate lines.
    for (const id of i.contacted) this.enqueue(i, 'status', id, text);
  }
  private notifyOkay(i: StoredIncident, how: string): void {
    // Every fall reaches the care team, even when the wearer is fine: informational only, no action requested.
    if (this.dispatchMode !== 'live') return;
    const at = new Date(i.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    for (const r of this.responders) this.enqueue(i, 'status', r.id,
      `LIFELINE FYI: ${this.patientFirstName} had a possible fall at ${at} and said they're okay (${how}). No action needed; consider checking in later.`,
      `${i.id}:${i.version}:status:fyi-okay:${r.id}`);
  }
  private get patientFirstName(): string { return this.wearerName.trim().split(/\s+/)[0] || 'the patient'; }
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
      if (!types && a.type === 'wearer_relay' && !terminal(i.phase)) continue;
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
      this.queueWearerReports(i, r.id);
    }
    this.save(i);
    this.enqueue(i, 'wearer_status', null, eligible.length ? 'I’m getting help for you now. Try to stay still.' : 'I’m still trying to reach someone for you. Try to stay still.',
      `${i.id}:${i.version}:wearer_status:help`);
    if (!eligible.length) this.event(i, 'UNASSIGNED', 'policy', 'No additional approved responder is available; incident remains unresolved.');
  }
  private alertText(i: Incident): string {
    const evidence = i.handoffGeneration ? '' : `${i.evidence.summary}\n`;
    const report = this.storedConversation(i.id).findLast(message => message.speaker === 'wearer');
    // Urgent alerts can carry the exact report while the model refreshes the
    // clinical handoff. Do not wait for inference to disclose reported distress.
    const quote = report && !i.handoff.includes(`[conversation:${report.id}]`)
      ? `${report.speakerName}: “${report.text}”\n` : '';
    return `LIFELINE ${i.id}: Possible incident.\n${quote}${evidence}${i.handoff}\nReact 👍 to this alert to accept responsibility, or reply ON IT ${i.id}. If unavailable, reply DECLINE ${i.id}.`;
  }

  trigger(evidence: Evidence): Incident {
    return this.transaction(() => this.triggerInternal(evidence));
  }
  /** Persist the first distress quotation BEFORE escalation constructs the alert. */
  triggerReportedHelp(evidence: Evidence, transcript: string,
    source: 'freewili-local-speech' | 'photon-imessage', event?: ProviderInbound): Incident {
    return this.transaction(() => {
      if (this.active() || evidence.kind !== 'manual' || typeof transcript !== 'string'
        || !transcript.trim() || transcript.length > 500 || classifyCheckinReply(transcript) !== 'help_requested'
        || !['freewili-local-speech', 'photon-imessage'].includes(source)
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(transcript))
        throw new PolicyError('A current, explicit patient help report is required.');
      if (source === 'photon-imessage' && (!event?.messageId || !event.chatId || !event.lineId
        || this.seenInbound(event.messageId))) throw new PolicyError('A fresh bound patient message is required.');
      return this.triggerInternal(evidence, { transcript: transcript.trim(), source, event });
    });
  }
  private triggerInternal(evidence: Evidence, report?: { transcript: string;
    source: 'freewili-local-speech' | 'photon-imessage'; event?: ProviderInbound }): Incident {
      const existing = this.active();
      if (existing) {
        if (evidence.kind === 'manual' && existing.phase === 'CONFIRMING') this.requestHelp(existing, 'Subject explicitly requested help.');
        return existing;
      }
      const t = this.now();
      const i: StoredIncident = {
        id: `LF-${randomUUID().slice(0, 8).toUpperCase()}`, phase: 'DETECTED', version: 1,
        dispatchMode: this.dispatchMode,
        createdAt: t, updatedAt: t, evidence, checkinId: randomUUID(), checkinDeadline: t + this.policy.checkinMs,
        progressDeadline: null, ownerId: null, handoff: 'Health context pending.',
        outcome: null, resolutionActor: null, contacted: [], declined: []
      };
      this.save(i); this.event(i, 'DETECTED', 'sensor-or-operator', evidence.summary);
      if (i.dispatchMode === 'simulated') this.event(i, 'DISPATCH_MODE', 'simulated-dispatch',
        'Responder actions are handled by local dispatch.');
      this.phase(i, 'CONFIRMING', 'policy', 'Current check-in opened. Explicit cancellation is required.');
      const noticed = evidence.eventType === 'sustained-shaking' ? 'I noticed sustained unusual movement.'
        : evidence.eventType === 'possible-balance-loss' ? 'I noticed a possible loss of balance.'
        : evidence.eventType === 'reported-seizure' ? 'You reported a seizure. I am requesting help.' : 'I noticed a possible fall.';
      this.enqueue(i, 'checkin', null, `${noticed} Do you need help? You can say I need help, or press the green button on WILi if you don't need help.`);
      this.enqueue(i, 'wearer_checkin', null, `${this.patientFirstName}, ${noticed.startsWith('I ') ? noticed : noticed.charAt(0).toLowerCase() + noticed.slice(1)} Do you need help? Reply here, or press the green button on WILi if you’re fine.`);
      if (report) {
        this.event(i, 'CHECKIN_REPLY', report.source, JSON.stringify({ transcript: report.transcript, decision: 'help_requested' }));
        this.addConversation({ id: randomUUID(), incidentId: i.id, speaker: 'wearer', speakerName: this.wearerName,
          text: report.transcript, source: report.source, at: this.now(), delivery: 'recorded' });
        if (report.event) this.rememberInbound(report.event.messageId);
      }
      if (evidence.kind === 'manual') this.requestHelp(i, 'Explicit manual help request.');
      return i;
  }
  cancel(id: string, checkinId: string): void {
    this.transaction(() => {
      const i = this.current(id);
      if (i.checkinId !== checkinId || i.phase !== 'CONFIRMING' || this.now() >= i.checkinDeadline)
        throw new PolicyError('Cancellation must target the current unresolved check-in. After escalation, responder outcome is required.');
      i.progressDeadline = null; this.phase(i, 'CANCELLED_FALSE_ALARM', 'subject-control', 'Subject explicitly cancelled the current check-in.'); this.stopPending(i);
      this.enqueue(i, 'wearer_status', null, 'Okay, check-in closed. I’m here if you need me.');
      this.notifyOkay(i, 'cancelled the check-in');
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
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(transcript)) throw new PolicyError('A check-in reply cannot contain control characters.');
      const decision = classifyCheckinReply(transcript);
      const reportsRecovery = /\b(?:caught myself|didn['’]?t fall|did not fall)\b/i.test(transcript);
      const reportsFall = /\bi (?:fell|have fallen|just fell)\b/i.test(transcript);
      const interpretation = reportsRecovery && !reportsFall ? 'reported-recovery'
        : reportsFall && !reportsRecovery ? 'reported-fall' : 'unclassified';
      i.evidence.patientReport = { text: transcript, source, at: this.now(), interpretation };
      this.save(i);
      this.event(i, 'CHECKIN_REPLY', source, JSON.stringify({ transcript, decision }));
      this.addConversation({ id: randomUUID(), incidentId: i.id, speaker: 'wearer', speakerName: this.wearerName,
        text: transcript, source, at: this.now(), delivery: 'recorded' });
      if (decision === 'help_requested') this.requestHelp(i, source === 'photon-imessage'
        ? 'Patient requested help in the current iMessage check-in.' : 'Subject requested help in the current spoken check-in.');
      if (source === 'photon-imessage' && inboundId && decision === 'confirmation_required') {
        const inserted = this.enqueue(i, 'wearer_ack', null,
          "Glad you're okay. To close this check-in, press the green 'I DON'T NEED HELP' button on WILi.",
          `${i.id}:${i.version}:wearer_ack:${JSON.stringify([i.checkinId, inboundId])}`);
        if (!inserted) throw new Error('Patient acknowledgement was not persisted; inbound ID remains unprocessed.');
        if (event?.chatId && event.lineId) {
          inserted.replyToMessageId = inboundId; inserted.replyChatId = event.chatId; inserted.replyLineId = event.lineId;
          this.saveAction(inserted);
        }
      }
      if (inboundId) this.rememberInbound(inboundId);
      return decision;
    });
  }
  private responderSource(i: Incident, r: Responder, source: 'live' | 'simulated-dispatch'): string {
    if (source === 'simulated-dispatch') {
      if (this.dispatchMode !== 'simulated' || i.dispatchMode !== 'simulated' || !r.simulated || r.phone !== null)
        throw new PolicyError('Simulated reports require the current simulated incident and local responder.');
      return `simulated-dispatch:${r.id}`;
    }
    if (i.dispatchMode === 'simulated' || r.simulated)
      throw new PolicyError('Local responder progress is controlled by simulated dispatch.');
    return r.id;
  }
  private simulatedReport(i: Incident, r: Responder, text: string, delivery: 'queued' | 'recorded' = 'queued'): void {
    const relay = delivery === 'queued' && addressedToPatient(text, this.wearerName);
    const message: StoredConversation = { id: randomUUID(), incidentId: i.id, speaker: 'responder',
      speakerName: r.name, responderId: r.id, text, source: 'simulated-dispatch', at: this.now(), delivery: relay ? 'queued' : 'recorded' };
    this.addConversation(message);
    this.event(i, 'RESPONDER_REPORT', 'simulated-dispatch', JSON.stringify({
      conversationId: message.id, responderId: r.id, transcript: text, phase: i.phase, source: 'simulated-dispatch',
    }));
    // Keep each phase notice and its attributed reply in one genuine wearer send.
    const notice = relay ? this.actions(i.id).findLast(a => a.type === 'wearer_status'
      && a.status === 'queued' && this.actionPermitted(a)) : null;
    if (notice) {
      notice.text += `\n\n${r.name}: “${text}”`; this.saveAction(notice);
    }
  }
  /** Local human reports use the same ownership/phase rules, without impersonating native messages. */
  simulateResponder(id: string, responderId: string, stage: 'accept' | 'depart' | 'arrive' | 'resolve'): void {
    if (stage === 'accept') {
      if (!this.actions(id).some(a => a.type === 'alert' && a.recipientId === responderId && a.status === 'simulated'))
        throw new PolicyError('Simulated responder must first receive the incident alert.');
      this.accept(id, responderId, undefined, undefined, 'simulated-dispatch');
    }
    else if (stage === 'depart' || stage === 'arrive') this.progress(id, responderId, stage, undefined, 'simulated-dispatch');
    else if (stage === 'resolve') this.resolve(id, responderId,
      `${this.responder(responderId).name} reached the patient and stayed with them while arranging further assistance.`,
      undefined, 'simulated-dispatch');
    else throw new PolicyError('Unknown simulated responder stage.');
  }
  accept(id: string, responderId: string, inboundId?: string, event?: ProviderInbound, source: 'live' | 'simulated-dispatch' = 'live'): void {
    this.transaction(() => {
      const i = this.current(id); const r = this.responder(responderId);
      const actor = this.responderSource(i, r, source);
      if (source === 'simulated-dispatch' && (inboundId || event)) throw new PolicyError('Simulation cannot attach native provider evidence.');
      if (inboundId && this.db.prepare('SELECT id FROM inbound WHERE id=?').get(inboundId)) return;
      if (i.ownerId === responderId) return;
      // A contacted responder can still take responsibility after a missed deadline or an earlier decline.
      if (i.phase !== 'HELP_REQUESTED' || i.ownerId)
        throw new PolicyError('Incident has an owner or is not accepting responders.');
      if (!i.contacted.includes(responderId)) throw new PolicyError('Responder has not been contacted for this incident.');
      if (inboundId) this.db.prepare('INSERT INTO inbound VALUES(?)').run(inboundId);
      if (i.declined.includes(responderId)) i.declined.splice(i.declined.indexOf(responderId), 1);
      i.ownerId = responderId; i.progressDeadline = this.now() + this.policy.progressMs;
      this.phase(i, 'ACKNOWLEDGED', actor, `${r.name} accepted responsibility; departure is not yet confirmed.`);
      this.stopPending(i);
      this.notify(i, `${r.name} accepted ${i.id}. Departure has not been confirmed.\nAssigned responder ${r.name}: reply DEPART ${i.id} when leaving, ARRIVED ${i.id} when on scene, or DECLINE ${i.id} if unavailable. Other contacts: keep available for updates.`);
      this.enqueue(i, 'wearer_status', null, `${r.name} has answered your alert.`);
      this.addNaturalGuidance(i, r.id, `Reply directly to this message with “leaving”, “arrived”, or “I can’t help”. Start a message with “${this.patientFirstName},” and WILi will say it to ${this.patientFirstName}. You can also ask about the recorded health information.`);
      this.report(i, event);
      if (source === 'simulated-dispatch') this.simulatedReport(i, r, 'On it. Heading over now.');
    });
  }
  private addNaturalGuidance(i: Incident, ownerId: string, text: string): void {
    const a = this.actions(i.id).findLast(a => a.type === 'status' && a.recipientId === ownerId && a.status === 'queued');
    if (a) { a.text += `\n${text}`; this.saveAction(a); }
  }
  progress(id: string, responderId: string, stage: 'depart' | 'arrive', event?: ProviderInbound, source: 'live' | 'simulated-dispatch' = 'live'): void {
    this.transaction(() => {
      if (event && this.seenInbound(event.messageId)) return;
      const i = this.current(id); const r = this.responder(responderId);
      const actor = this.responderSource(i, r, source);
      if (source === 'simulated-dispatch' && event) throw new PolicyError('Simulation cannot attach native provider evidence.');
      if (i.ownerId !== r.id) throw new PolicyError('Only the assigned owner can update progress.');
      const allowed = stage === 'depart' ? ['ACKNOWLEDGED'] : ['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE'];
      if (!allowed.includes(i.phase)) throw new PolicyError('Progress update is not valid for this phase.');
      i.progressDeadline = this.now() + this.policy.progressMs;
      this.phase(i, stage === 'depart' ? 'RESPONDER_EN_ROUTE' : 'ON_SCENE', actor,
        `${stage === 'depart' ? 'Owner explicitly reported departure.' : 'Owner explicitly reported arrival.'}`);
      this.notify(i, stage === 'depart'
        ? `${r.name} reported departure for ${i.id}.\nAssigned responder ${r.name}: reply ARRIVED ${i.id} when on scene, or DECLINE ${i.id} if unavailable. Other contacts: keep available for updates.`
        : `${r.name} reported arrival for ${i.id}. An outcome has not been recorded.\nAssigned responder ${r.name}: reply RESOLVED ${i.id} <concrete outcome>, replacing <concrete outcome> with what you observed and what help was provided. If unable to continue, reply DECLINE ${i.id}.`);
      this.enqueue(i, 'wearer_status', null, stage === 'depart' ? `${r.name} is on the way.` : `${r.name} has arrived.`);
      this.addNaturalGuidance(i, r.id, stage === 'depart'
        ? 'Reply directly with “arrived” when you are with the patient.'
        : 'Reply directly with “resolved: ” followed by what you observed and what help was provided.');
      this.report(i, event);
      if (source === 'simulated-dispatch') this.simulatedReport(i, r, stage === 'depart'
        ? `${this.patientFirstName}, I’m coming downstairs now. Try not to move.` : 'I’m with them now.');
    });
  }
  decline(id: string, responderId: string, event?: ProviderInbound): void {
    this.transaction(() => {
      if (event && this.seenInbound(event.messageId)) return;
      const i = this.current(id); this.responder(responderId);
      if (i.dispatchMode === 'simulated') throw new PolicyError('Local responder progress is controlled by simulated dispatch.');
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
  resolve(id: string, responderId: string, outcome: string, event?: ProviderInbound, source: 'live' | 'simulated-dispatch' = 'live'): void {
    this.transaction(() => {
      if (event && this.seenInbound(event.messageId)) return;
      const i = this.current(id); const r = this.responder(responderId);
      const actor = this.responderSource(i, r, source);
      if (source === 'simulated-dispatch' && event) throw new PolicyError('Simulation cannot attach native provider evidence.');
      if (i.ownerId !== responderId || i.phase !== 'ON_SCENE') throw new PolicyError('Only the on-scene owner can resolve the incident.');
      if (typeof outcome !== 'string' || outcome.trim().length < 5 || outcome.length > 2000) throw new PolicyError('A concrete outcome is required (5–2000 characters).');
      i.outcome = outcome.trim(); i.resolutionActor = actor; i.progressDeadline = null;
      this.phase(i, 'RESOLVED', actor, i.outcome); this.stopPending(i);
      this.notify(i, `${i.id} closed by the on-scene owner. Outcome: ${i.outcome}`);
      this.report(i, event);
      if (source === 'simulated-dispatch') this.simulatedReport(i, r, i.outcome, 'recorded');
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
        && ['attempting', 'provider_accepted', 'simulated', 'unknown'].includes(a.status)).map(a => a.recipientId));
      const reportIds = this.storedConversation(i.id).filter(message => message.speaker === 'wearer').map(message => message.id);
      for (const recipient of alreadyAttempted) if (recipient) {
        const text = `${i.id}: Updated incident handoff.\n${handoff}`;
        const key = `${i.id}:${i.version}:handoff:${recipient}${reportIds.length ? `:${JSON.stringify(reportIds)}` : ''}`;
        const existing = this.db.prepare('SELECT body FROM actions WHERE dedupe_key=?').get(key);
        if (existing) {
          const action = JSON.parse(String(existing.body)) as Action;
          // Refresh an unsent composition; accepted/uncertain sends retain their
          // original evidence and are never silently resubmitted.
          if (['queued', 'failed'].includes(action.status)) { action.text = text; this.saveAction(action); }
          continue;
        }
        for (const action of this.actions(i.id).filter(a => a.type === 'handoff' && a.recipientId === recipient
          && ['queued', 'failed'].includes(a.status))) {
          action.status = 'cancelled'; action.providerResult = 'Superseded by a handoff containing newer patient reports.'; this.saveAction(action);
        }
        this.enqueue(i, 'handoff', recipient, text, key);
      }
    });
  }
  recordEventWindow(incidentId: string, window: EventWindow): void {
    this.transaction(() => {
      const i = this.current(incidentId);
      if (i.evidence.window) return;
      i.evidence.window = structuredClone(window); i.version++; i.updatedAt = this.now(); this.save(i);
      this.event(i, 'MOTION_WINDOW_CAPTURED', 'measured-sensors', window.summary);
    });
  }
  queueRehearsalAlert(id: string, responderId: string): void {
    this.transaction(() => {
      const i=this.current(id);
      if(i.phase==='CONFIRMING'||!i.contacted.includes(responderId)||i.declined.includes(responderId))
        throw new PolicyError('Responder has not been contacted for this incident.');
      this.event(i,'REHEARSAL_ROLE_SWITCH','development-operator',`Single-phone rehearsal acting as ${responderId}; not a second human participant.`);
      this.enqueue(i,i.ownerId?'handoff':'alert',responderId,this.alertText(i),`${i.id}:rehearsal-role:${randomUUID()}`);
    });
  }
  reset(): void {
    this.transaction(() => {
      const i = this.active(); if (!i) return;
      i.outcome = 'Reset by operator; not a safety determination.'; i.resolutionActor = 'development-operator';
      i.progressDeadline = null; this.phase(i, 'CANCELLED_FALSE_ALARM', 'development-operator', i.outcome); this.stopPending(i);
    });
  }
  events(id: string): TimelineEvent[] {
    return this.db.prepare('SELECT body FROM events WHERE incident_id=? ORDER BY rowid').all(id).map(row => JSON.parse(String(row.body)) as TimelineEvent);
  }
  private storedConversation(id: string): StoredConversation[] {
    return this.db.prepare('SELECT body FROM conversation WHERE incident_id=? ORDER BY rowid').all(id)
      .map(row => JSON.parse(String(row.body)) as StoredConversation);
  }
  conversation(id: string): ConversationMessage[] {
    return this.storedConversation(id).map(({ responderId, deviceSessionId, providerTimestamp, ...message }) => message);
  }
  private addConversation(message: StoredConversation): void {
    this.db.prepare('INSERT INTO conversation VALUES(?,?,?)').run(message.id, message.incidentId, JSON.stringify(message));
  }
  private saveConversation(message: StoredConversation): void {
    this.db.prepare('UPDATE conversation SET body=? WHERE id=?').run(JSON.stringify(message), message.id);
  }
  private queueWearerReports(i: StoredIncident, responderId: string): void {
    for (const message of this.storedConversation(i.id).filter(message => message.speaker === 'wearer'))
      this.enqueue(i, 'wearer_relay', responderId, `${message.speakerName}: “${message.text}”`,
        `${i.id}:wearer_relay:${message.id}:${responderId}`);
  }
  /** Continue the wearer's bound conversation after escalation; reports never resolve or change ownership. */
  recordWearerUpdate(event: ProviderInbound, approvedPhone: string): boolean {
    return this.transaction(() => {
      if (typeof approvedPhone !== 'string' || typeof event.sender !== 'string') return false;
      const i = this.active(), expected = phoneIdentity(approvedPhone);
      if (!i || i.phase === 'CONFIRMING' || !expected || phoneIdentity(event.sender) !== expected
        || event.removed || event.kind !== 'text' || typeof event.messageId !== 'string'
        || !event.messageId.trim() || event.messageId.length > 500 || this.seenInbound(event.messageId)
        || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 500
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(event.text)
        || !this.matchesConversation(event, null)) return false;
      if (event.targetMessageId !== undefined && (!event.targetMessageId
        || this.wearerConversationIncidentForMessage(event.targetMessageId)?.id !== i.id
        || !this.messageMatchesConversation(event.targetMessageId, event))) return false;
      const original = event.text.trim();
      const codes = original.match(/\bLF-[A-Z0-9-]+\b/gi) ?? [];
      if (codes.some(code => code !== i.id) || codes.length > 1) return false;
      const text = original.replace(new RegExp(`\\s+${i.id}$`), '').trim();
      if (!text) return false;
      const message: StoredConversation = { id: randomUUID(), incidentId: i.id, speaker: 'wearer',
        speakerName: this.wearerName, text, source: 'photon-imessage', at: this.now(), delivery: 'recorded',
        ...(event.providerTimestamp !== undefined ? { providerTimestamp: event.providerTimestamp } : {}) };
      this.addConversation(message); this.rememberInbound(event.messageId);
      this.event(i, 'WEARER_REPORT', 'photon-imessage', JSON.stringify({ conversationId: message.id,
        inboundId: event.messageId, transcript: text, providerTimestamp: event.providerTimestamp ?? null }));
      for (const responderId of i.contacted.filter(id => !i.declined.includes(id))) this.queueWearerReports(i, responderId);
      return true;
    });
  }
  recordResponderRelay(event: ProviderInbound, responderId: string): boolean {
    return this.transaction(() => {
      const i = this.active(), r = this.responders.find(r => r.id === responderId);
      if (!i || !r?.phone || phoneIdentity(event.sender) !== phoneIdentity(r.phone)
        || !i.contacted.includes(r.id) || i.declined.includes(r.id) || event.removed || event.kind !== 'text'
        || typeof event.messageId !== 'string' || !event.messageId.trim() || event.messageId.length > 500
        || this.seenInbound(event.messageId) || typeof event.text !== 'string' || !event.text.trim()
        || event.text.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(event.text)
        || !r.name.trim() || r.name.length > 100 || /[\u0000-\u001f\u007f]/.test(r.name)
        || !this.matchesConversation(event, r.id)) return false;
      const actions = this.actions(i.id).filter(a => a.recipientId === r.id && a.status === 'provider_accepted'
        && a.providerMessageId && a.providerChatId === event.chatId && a.providerLineId === event.lineId);
      if (event.targetMessageId !== undefined) {
        if (!actions.some(a => a.providerMessageId === event.targetMessageId
          && ['alert', 'status', 'handoff', 'answer', 'wearer_relay'].includes(a.type))) return false;
      } else if (!actions.some(a => a.type === 'alert')) return false;
      const message: StoredConversation = { id: randomUUID(), incidentId: i.id, speaker: 'responder',
        speakerName: r.name, responderId: r.id, text: event.text.trim(), source: 'photon-imessage', at: this.now(),
        delivery: addressedToPatient(event.text, this.wearerName) ? 'queued' : 'recorded', ...(event.providerTimestamp !== undefined ? { providerTimestamp: event.providerTimestamp } : {}) };
      this.addConversation(message); this.rememberInbound(event.messageId);
      this.event(i, 'CONVERSATION_MESSAGE', r.id, JSON.stringify({ conversationId: message.id,
        transcript: message.text, speaker: 'responder', source: message.source, providerTimestamp: event.providerTimestamp ?? null }));
      return true;
    });
  }
  claimResponderSpeech(sessionId: string): ConversationMessage | null {
    return this.transaction(() => {
      const i = this.active(); if (!i) return null;
      if (this.storedConversation(i.id).some(message => message.deviceSessionId && ['queued', 'playing'].includes(message.delivery))) return null;
      for (const message of this.storedConversation(i.id)) {
        if (message.speaker !== 'responder' || message.delivery !== 'queued' || message.deviceSessionId) continue;
        if (this.now() - message.at > 120_000 || !message.responderId || i.declined.includes(message.responderId)) {
          message.delivery = 'failed'; message.detail = 'Wearable reply expired or its sender is no longer eligible.';
          this.saveConversation(message); continue;
        }
        message.deviceSessionId = sessionId; this.saveConversation(message);
        const { responderId, deviceSessionId, providerTimestamp, ...visible } = message;
        return visible;
      }
      return null;
    });
  }
  recordResponderPlayback(id: string, incidentId: string, sessionId: string, status: 'queued' | 'playing' | 'spoken' | 'failed'): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT body FROM conversation WHERE id=?').get(id); if (!row) return false;
      const message = JSON.parse(String(row.body)) as StoredConversation;
      const i = this.active();
      if (!i || i.id !== incidentId || message.incidentId !== i.id || message.deviceSessionId !== sessionId
        || message.speaker !== 'responder' || !message.responderId || i.declined.includes(message.responderId)) return false;
      const allowed = status === 'queued' ? message.delivery === 'queued' : status === 'playing' ? message.delivery === 'queued'
        : status === 'spoken' ? message.delivery === 'playing' : ['queued', 'playing'].includes(message.delivery);
      if (!allowed) return false;
      if (status === 'queued') return true;
      message.delivery = status;
      message.detail = status === 'spoken' ? 'Wearable playback window completed; audibility was not independently confirmed.'
        : status === 'failed' ? 'Wearable synthesis or playback failed; reply text remains recorded.' : undefined;
      this.saveConversation(message);
      this.event(i, 'CONVERSATION_PLAYBACK', 'freewili', JSON.stringify({ conversationId: id, status }));
      return true;
    });
  }
  failResponderSpeechSession(sessionId: string): void {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT body FROM conversation').all()) {
        const message = JSON.parse(String(row.body)) as StoredConversation;
        if (message.deviceSessionId !== sessionId || !['queued', 'playing'].includes(message.delivery)) continue;
        message.delivery = 'failed'; message.detail = 'Wearable disconnected before playback confirmation; not replayed automatically.';
        this.saveConversation(message);
      }
    });
  }
  boardButton(action: 'help' | 'cancel' | 'rehearse', incidentId: string | null, checkinId: string | null, eventId: string): Incident | null {
    return this.transaction(() => {
      const inboundId = `freewili:${eventId}`;
      if (this.seenInbound(inboundId)) return null;
      const active = this.active();
      if (action === 'rehearse') {
        if (this.dispatchMode !== 'simulated' || active || incidentId !== null || checkinId !== null)
          throw new PolicyError('The rehearsal button requires idle simulated dispatch.');
        const i = this.triggerInternal({ kind: 'synthetic',
          summary: 'Check-in started from the wearable.' });
        this.rememberInbound(inboundId);
        this.event(i, 'DEVICE_BUTTON', 'freewili-button', 'Yellow button started a check-in.');
        return i;
      }
      if (active && (active.id !== incidentId || active.checkinId !== checkinId))
        throw new PolicyError('Board control must target the current incident and check-in.');
      if (!active && (incidentId !== null || checkinId !== null || action !== 'help'))
        throw new PolicyError('Board control is stale.');
      if (action === 'help') {
        const i = this.triggerInternal({ kind: 'manual', summary: 'Help requested from the wearable.' });
        this.rememberInbound(inboundId); this.event(i, 'DEVICE_BUTTON', 'freewili-button', 'Explicit help request.');
        return i;
      }
      if (!active || active.phase !== 'CONFIRMING' || this.now() >= active.checkinDeadline)
        throw new PolicyError('Board cancellation requires the current check-in before escalation.');
      active.progressDeadline = null;
      this.phase(active, 'CANCELLED_FALSE_ALARM', 'freewili-button', 'Patient cancelled the check-in with the green button.');
      this.stopPending(active); this.rememberInbound(inboundId);
      this.enqueue(active, 'wearer_status', null, 'Okay, check-in closed. I’m here if you need me.');
      this.notifyOkay(active, 'pressed the green button');
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
      && (recipientId === null ? ['wearer_checkin', 'wearer_ack', 'wearer_status', 'wearer_location'].includes(a.type)
        : ['alert', 'status', 'handoff', 'answer', 'wearer_relay'].includes(a.type)));
  }
  messageMatchesConversation(messageId: string, event: ProviderInbound): boolean {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row || !event.chatId || !event.lineId) return false;
    const a = JSON.parse(String(row.body)) as Action;
    return a.providerChatId === event.chatId && a.providerLineId === event.lineId;
  }
  responderQuestion(inboundId: string): ResponderQuestionPreparation | null {
    const row = this.db.prepare('SELECT body FROM responder_questions WHERE inbound_id=?').get(inboundId);
    return row ? JSON.parse(String(row.body)) as ResponderQuestionPreparation : null;
  }
  responderQuestions(incidentId: string): ResponderQuestionPreparation[] {
    return this.db.prepare('SELECT body FROM responder_questions WHERE incident_id=? ORDER BY rowid').all(incidentId)
      .map(row => JSON.parse(String(row.body)) as ResponderQuestionPreparation);
  }
  private saveResponderQuestion(job: ResponderQuestionPreparation): void {
    this.db.prepare('UPDATE responder_questions SET status=?,next_at=?,body=? WHERE inbound_id=?')
      .run(job.status, job.nextAttemptAt, JSON.stringify(job), job.inboundId);
  }
  private questionPermitted(job: ResponderQuestionPreparation): boolean {
    const i = this.active(), e = job.event, r = this.responders.find(r => r.id === job.responderId);
    if (!i || i.id !== job.incidentId || i.version !== job.incidentVersion || this.seenInbound(job.inboundId)
      || !r?.phone || phoneIdentity(r.phone) === null || phoneIdentity(r.phone) !== phoneIdentity(e.sender)
      || !i.contacted.includes(r.id) || i.declined.includes(r.id)) return false;
    if ((e.chatId !== undefined || e.lineId !== undefined) && !this.matchesConversation(e, r.id)) return false;
    if (/^(ON IT|DEPART|ARRIVED|DECLINE|RESOLVED)(?:\s|$)/i.test(job.question)) return false;
    if ((job.question.match(/\bLF-[A-Z0-9-]+\b/gi) ?? []).some(code => code.toUpperCase() !== i.id)) return false;
    if (e.targetMessageId !== undefined) {
      if (!e.targetMessageId) return false;
      const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(e.targetMessageId);
      const a = row ? JSON.parse(String(row.body)) as Action : null;
      if (!a || a.status !== 'provider_accepted' || a.incidentId !== i.id || a.recipientId !== r.id
        || !['alert', 'status', 'handoff', 'answer', 'wearer_relay'].includes(a.type)) return false;
      if (e.chatId && !this.messageMatchesConversation(e.targetMessageId, e)) return false;
    }
    return true;
  }
  /** Receive durably before inference. This is not an answer or a delivery receipt. */
  enqueueResponderQuestion(event: ProviderInbound): boolean {
    return this.transaction(() => {
      if (typeof event.messageId !== 'string' || !event.messageId.trim() || event.messageId.length > 500
        || event.removed || event.kind !== 'text' || typeof event.text !== 'string'
        || !event.text.trim() || event.text.length > 2000 || typeof event.sender !== 'string'
        || this.seenInbound(event.messageId) || this.responderQuestion(event.messageId)) return false;
      const i = this.active(), phone = phoneIdentity(event.sender);
      const r = phone ? this.responders.find(r => r.phone && phoneIdentity(r.phone) === phone) : null;
      if (!i || !r) return false;
      const now = this.now();
      const job: ResponderQuestionPreparation = {
        inboundId: event.messageId, incidentId: i.id, incidentVersion: i.version, responderId: r.id,
        question: event.text.trim(), event: structuredClone(event), incident: i,
        status: 'queued', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now, detail: null,
      };
      if (!this.questionPermitted(job)) return false;
      this.db.prepare('INSERT INTO responder_questions VALUES(?,?,?,?,?)')
        .run(job.inboundId, i.id, job.status, job.nextAttemptAt, JSON.stringify(job));
      this.event(i, 'QUESTION_RECEIVED', r.id, JSON.stringify({
        question: job.question, inboundId: job.inboundId, incidentVersion: job.incidentVersion,
        source: 'photon-imessage', providerTimestamp: event.providerTimestamp ?? null,
      }));
      return true;
    });
  }
  /** A bounded claim, including a durable token that prevents late or duplicate completions. */
  claimResponderQuestion(inboundId?: string): ResponderQuestionPreparation | null {
    return this.transaction(() => {
      const rows = inboundId === undefined
        ? this.db.prepare("SELECT body FROM responder_questions WHERE status='queued' AND next_at<=? ORDER BY rowid LIMIT 32").all(this.now())
        : this.db.prepare("SELECT body FROM responder_questions WHERE inbound_id=? AND status='queued' AND next_at<=?").all(inboundId, this.now());
      for (const row of rows) {
        const job = JSON.parse(String(row.body)) as ResponderQuestionPreparation;
        if (job.attempts >= 3 || !this.questionPermitted(job)) {
          job.status = job.attempts >= 3 ? 'failed' : 'discarded'; job.updatedAt = this.now();
          job.detail = job.attempts >= 3 ? 'Preparation attempt limit reached; no answer was queued.'
            : 'Incident or responder authorization changed before preparation; no answer was queued.';
          this.saveResponderQuestion(job); continue;
        }
        job.status = 'preparing'; job.attempts++; job.claimId = randomUUID(); job.updatedAt = this.now();
        this.saveResponderQuestion(job); return job;
      }
      return null;
    });
  }
  releaseResponderQuestion(inboundId: string, claimId: string, reason: 'retry' | 'stale' | 'stopped', delayMs = 5000): void {
    this.transaction(() => {
      const job = this.responderQuestion(inboundId);
      if (!job || job.status !== 'preparing' || job.claimId !== claimId) return;
      job.status = reason === 'stale' ? 'discarded' : job.attempts >= 3 ? 'failed' : 'queued';
      delete job.claimId; job.updatedAt = this.now();
      job.nextAttemptAt = this.now() + (reason === 'retry' ? Math.max(0, Math.min(60_000, delayMs)) : 0);
      job.detail = reason === 'stale' ? 'Incident or responder authorization changed during preparation; no answer was queued.'
        : reason === 'stopped' ? 'Preparation stopped before commit; no answer delivery is established.'
          : 'Preparation failed before commit; retries are bounded and no answer delivery is established.';
      this.saveResponderQuestion(job);
    });
  }
  finishResponderQuestion(inboundId: string, claimId: string, text: string,
    generation?: 'ai' | 'degraded' | 'policy_refusal'): boolean {
    return this.transaction(() => {
      if (generation !== undefined && !['ai', 'degraded', 'policy_refusal'].includes(generation))
        throw new PolicyError('An answer must preserve supported generation provenance.');
      const job = this.responderQuestion(inboundId);
      if (!job || job.status !== 'preparing' || job.claimId !== claimId) return false;
      if (!this.questionPermitted(job)) throw new PolicyError('Question no longer targets the authorized incident version.');
      const action = this.queueAnswerInternal(job.incidentId, job.incidentVersion, job.responderId, job.inboundId, text,
        { question: job.question, event: job.event, generation });
      if (!action) return false;
      job.status = 'answer_queued'; job.answerActionId = action.id; job.generation = generation;
      job.updatedAt = this.now(); job.detail = 'Answer committed to the outbox; delivery is not yet established.';
      delete job.claimId; this.saveResponderQuestion(job); return true;
    });
  }
  queueAnswer(id: string, version: number, responderId: string, inboundId: string, text: string,
    audit?: { question: string; generation?: 'ai' | 'degraded' | 'policy_refusal'; event?: ProviderInbound }): boolean {
    return this.transaction(() => Boolean(this.queueAnswerInternal(id, version, responderId, inboundId, text, audit)));
  }
  private queueAnswerInternal(id: string, version: number, responderId: string, inboundId: string, text: string,
    audit?: { question: string; generation?: 'ai' | 'degraded' | 'policy_refusal'; event?: ProviderInbound }): Action | null {
    if (this.seenInbound(inboundId)) return null;
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
    return inserted;
  }
  private saveAction(a: Action): void {
    this.db.prepare('UPDATE actions SET status=?,next_at=?,provider_message_id=?,body=? WHERE id=?')
      .run(a.status, a.nextAttemptAt, a.providerMessageId, JSON.stringify(a), a.id);
  }
  /** Persist the exact submitted body, including scoped mobile links, for reconciliation. */
  decorateAction(id: string, text: string): Action {
    const row = this.db.prepare('SELECT body FROM actions WHERE id=?').get(id);
    if (!row) throw new PolicyError('Message action no longer exists.');
    const a = JSON.parse(String(row.body)) as Action;
    if (a.status !== 'attempting' || typeof text !== 'string' || !text.trim() || text.length > 6000)
      throw new PolicyError('Only the current bounded message attempt can be prepared.');
    a.text = text; this.saveAction(a); return a;
  }
  queueApproachUpdate(id: string, version: number, text: string): boolean {
    return this.transaction(() => {
      const i = this.current(id);
      if (i.version !== version || !i.ownerId || i.phase !== 'RESPONDER_EN_ROUTE') return false;
      if (!text.trim() || text.length > 1000) throw new PolicyError('A bounded approach update is required.');
      return Boolean(this.enqueue(i, 'wearer_location', null, text,
        `${i.id}:${i.version}:wearer_location:${Math.floor(this.now() / 60_000)}`));
    });
  }
  actionPermitted(a: Action): boolean {
    const row = this.db.prepare('SELECT body FROM incidents WHERE id=?').get(a.incidentId);
    if (!row) return false;
    const i = JSON.parse(String(row.body)) as StoredIncident;
    if (a.type === 'wearer_location') {
      const row = this.db.prepare('SELECT dedupe_key FROM actions WHERE id=?').get(a.id);
      return row !== undefined && i.phase === 'RESPONDER_EN_ROUTE' && Boolean(i.ownerId)
        && Number(String(row.dedupe_key).split(':')[1]) === i.version;
    }
    if (a.type === 'wearer_checkin' || a.type === 'wearer_ack') return i.phase === 'CONFIRMING' && this.now() < i.checkinDeadline;
    if (a.type === 'wearer_status') {
      if (this.latest()?.id !== i.id) return false;
      const row = this.db.prepare('SELECT dedupe_key FROM actions WHERE id=?').get(a.id);
      return row !== undefined && Number(String(row.dedupe_key).split(':')[1]) === i.version;
    }
    if (a.type === 'status' && i.phase === 'CANCELLED_FALSE_ALARM' && this.responders.some(r => r.id === a.recipientId)) {
      const fyi = this.db.prepare('SELECT dedupe_key FROM actions WHERE id=?').get(a.id);
      if (fyi !== undefined && String(fyi.dedupe_key).includes(':fyi-okay:')) return true;
    }
    if (!a.recipientId || !this.responders.some(r => r.id === a.recipientId) || !i.contacted.includes(a.recipientId)) return false;
    if (a.type === 'alert') return i.phase === 'HELP_REQUESTED' && !i.ownerId && !i.declined.includes(a.recipientId);
    if (a.type === 'handoff') return !terminal(i.phase) && !i.declined.includes(a.recipientId);
    if (a.type === 'wearer_relay') return !terminal(i.phase) && !i.declined.includes(a.recipientId);
    if (a.type === 'status' || a.type === 'answer') {
      const action = this.db.prepare('SELECT dedupe_key FROM actions WHERE id=?').get(a.id);
      return action !== undefined && Number(String(action.dedupe_key).split(':')[1]) === i.version
        && (a.type !== 'answer' || (!terminal(i.phase) && !i.declined.includes(a.recipientId)));
    }
    return false;
  }
  claimAction(channel: 'any' | 'wearer' | 'responders' = 'any', prioritize = false, incidentId?: string): Action | null {
    return this.transaction(() => {
      const pending = this.db.prepare("SELECT body FROM actions WHERE status IN ('queued','failed') AND next_at<=? ORDER BY rowid").all(this.now())
        .map(row => JSON.parse(String(row.body)) as Action);
      if (prioritize) {
        const priority: Record<ActionType, number> = { alert: 0, wearer_checkin: 1, wearer_relay: 2, answer: 3,
          wearer_ack: 4, handoff: 5, status: 6, wearer_status: 7, wearer_location: 8, checkin: 9 };
        pending.sort((a, b) => priority[a.type] - priority[b.type]);
      }
      for (const a of pending) {
        if (incidentId && a.incidentId !== incidentId) continue;
        if (a.type === 'checkin' || a.attempts >= 3) continue;
        if (channel === 'wearer' && !['wearer_checkin', 'wearer_ack', 'wearer_status', 'wearer_location'].includes(a.type)) continue;
        if (channel === 'responders' && ['wearer_checkin', 'wearer_ack', 'wearer_status', 'wearer_location'].includes(a.type)) continue;
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
    if (a.recipientId && this.incident(a.incidentId)?.dispatchMode === 'simulated')
      throw new PolicyError('Simulated responder actions cannot acquire provider receipts.');
    a.status = status; a.providerResult = detail; a.providerMessageId = messageId ?? null;
    if (status === 'provider_accepted' && conversation?.chatId && conversation.lineId) {
      a.providerChatId = conversation.chatId; a.providerLineId = conversation.lineId;
    }
    a.nextAttemptAt = this.now() + Math.min(60_000, 5000 * 2 ** a.attempts); this.saveAction(a);
  }
  finishSimulatedAction(id: string): void {
    const row = this.db.prepare('SELECT body FROM actions WHERE id=?').get(id);
    if (!row) throw new PolicyError('Unknown simulated action.');
    const a = JSON.parse(String(row.body)) as Action, i = this.latest();
    const r = this.responders.find(r => r.id === a.recipientId);
    if (this.dispatchMode !== 'simulated' || i?.id !== a.incidentId || i.dispatchMode !== 'simulated'
      || !r?.simulated || r.phone !== null || a.status !== 'attempting' || !this.actionPermitted(a))
      throw new PolicyError('Only a current permitted local responder attempt can be delivered locally.');
    a.status = 'simulated'; a.providerResult = 'Delivered to local dispatch. No responder message was sent.';
    a.providerMessageId = null; delete a.providerChatId; delete a.providerLineId;
    this.saveAction(a);
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
      && ['alert', 'status', 'handoff', 'answer', 'wearer_relay'].includes(a.type) ? i : null;
  }
  wearerIncidentForMessage(messageId: string): Incident | null {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row) return null;
    const a = JSON.parse(String(row.body)) as Action; const i = this.active();
    return i && i.phase === 'CONFIRMING' && this.now() < i.checkinDeadline
      && a.incidentId === i.id && a.recipientId === null && ['wearer_checkin', 'wearer_ack'].includes(a.type) ? i : null;
  }
  wearerConversationIncidentForMessage(messageId: string): Incident | null {
    const row = this.db.prepare('SELECT body FROM actions WHERE provider_message_id=?').get(messageId);
    if (!row) return null;
    const a = JSON.parse(String(row.body)) as Action, i = this.active();
    return i && a.incidentId === i.id && a.recipientId === null && a.status === 'provider_accepted'
      && ['wearer_checkin', 'wearer_ack', 'wearer_status', 'wearer_location'].includes(a.type) ? i : null;
  }
  seenInbound(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM inbound WHERE id=?').get(id)); }
  rememberInbound(id: string): void { this.db.prepare('INSERT OR IGNORE INTO inbound VALUES(?)').run(id); }
  close(): void { this.db.close(); }
}
