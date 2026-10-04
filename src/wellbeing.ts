import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderInbound, ProviderResult } from './contracts.ts';
import { phoneIdentity } from './identity.ts';
import type { PatientRecordSnapshot } from './patient-record.ts';

export type WellbeingSource = 'agent' | 'daily-checkin' | 'photon-imessage' | 'freewili-local-speech';
export type WellbeingDelivery = 'recorded' | 'queued' | 'attempting' | ProviderResult['status'];
export interface WellbeingRecordContext {
  source: 'finchnode-synthetic'; synthetic: true;
  subjectId: string | null; subjectName: string | null; revision: string | null;
  sourceRecordIds: string[]; retrievedAt: number | null; truncated: boolean; requestMessageId?: string;
}
export interface WellbeingMessage {
  id: string; speaker: 'wearer' | 'lifeline'; text: string; source: WellbeingSource;
  at: number; delivery: WellbeingDelivery; generation?: 'ai' | 'degraded' | 'policy_refusal';
  recordContext?: WellbeingRecordContext;
}
export interface WellbeingView {
  conversationId: string; enabled: boolean;
  schedule: { hour: number; timeZone: string; label: string };
  lastCheckinDate: string | null; messages: WellbeingMessage[]; pendingCount: number;
  voice?: { stage: string; at: number };
}
export interface WellbeingAction {
  id: string; conversationId: string; type: 'daily_checkin' | 'reply'; text: string;
  status: 'queued' | 'attempting' | ProviderResult['status']; attempts: number; createdAt: number;
  providerMessageId: string | null; providerResult: string | null;
  providerChatId?: string; providerLineId?: string;
  replyToMessageId?: string; replyChatId?: string; replyLineId?: string;
}
export interface WellbeingPendingMessage extends WellbeingMessage {
  speaker: 'wearer'; conversationId: string;
  replyToMessageId?: string; replyChatId?: string; replyLineId?: string;
}
type StoredAction = WellbeingAction & { messageId: string; wearerMessageId?: string; phone: string;
  dailyDate?: string; scheduled?: boolean };
type MessageRow = { body: string; reply_to: string | null; chat_id: string | null; line_id: string | null };
type LocalDate = { date: string; hour: number; minute: number };
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value);
const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 500 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

/** Local conversation and outbox; clinical snapshots are supplied by the grounded record engine. */
export class Wellbeing {
  private readonly db: DatabaseSync;
  private readonly options: { phone: string | null; wearerName: string; timezone: string; hour: number; enabled: boolean };
  private readonly formatter: Intl.DateTimeFormat;
  private readonly now: () => number;
  readonly conversationId: string;

  constructor(dbPath: string, options: { phone: string | null; wearerName: string; timezone?: string; hour?: number; enabled?: boolean }, now = Date.now) {
    this.options = { ...options, wearerName: options.wearerName.trim(), timezone: options.timezone ?? 'America/New_York',
      hour: options.hour ?? 14, enabled: (options.enabled ?? true) && Boolean(options.phone) };
    if (options.phone !== null && !/^\+[1-9]\d{7,14}$/.test(options.phone)) throw new Error('Wellbeing phone must be approved E.164 or null.');
    if (!this.options.wearerName || this.options.wearerName.length > 100 || /[\x00-\x1f\x7f]/.test(this.options.wearerName)
      || !Number.isInteger(this.options.hour) || this.options.hour < 0 || this.options.hour > 23) throw new Error('Invalid wellbeing name or schedule hour.');
    this.formatter = new Intl.DateTimeFormat('en-US', { timeZone: this.options.timezone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    this.now = now;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wellbeing_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wellbeing_messages (id TEXT PRIMARY KEY, speaker TEXT NOT NULL, reply_state TEXT,
        body TEXT NOT NULL, reply_to TEXT, chat_id TEXT, line_id TEXT);
      CREATE TABLE IF NOT EXISTS wellbeing_actions (id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wellbeing_record_snapshots (request_message_id TEXT PRIMARY KEY,
        reply_message_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wellbeing_inbound (source TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(source,event_id));`);
    this.db.prepare('INSERT OR IGNORE INTO wellbeing_meta VALUES (?,?)').run('conversationId', `WB-${randomUUID()}`);
    this.conversationId = String(this.db.prepare('SELECT value FROM wellbeing_meta WHERE key=?').get('conversationId')!.value);
    this.transaction(() => {
      for (const action of this.actions().filter(action => action.status === 'attempting')) {
        action.status = 'unknown'; action.providerResult = 'Previous worker stopped during submission; not retried automatically.';
        this.saveAction(action); this.delivery(action.messageId, 'unknown');
      }
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private localDate(): LocalDate {
    const at = this.now(); if (!Number.isFinite(at)) throw new Error('Invalid wellbeing clock.');
    const p = Object.fromEntries(this.formatter.formatToParts(at).map(part => [part.type, part.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
  }
  private inWindow(local: LocalDate): boolean {
    const elapsed = local.hour * 60 + local.minute - this.options.hour * 60;
    return elapsed >= 0 && elapsed < 360;
  }
  private actions(): StoredAction[] {
    return this.db.prepare('SELECT body FROM wellbeing_actions ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as StoredAction);
  }
  private action(id: string): StoredAction | null {
    const row = this.db.prepare('SELECT body FROM wellbeing_actions WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as StoredAction : null;
  }
  private saveAction(action: StoredAction): void {
    this.db.prepare('UPDATE wellbeing_actions SET status=?,body=? WHERE id=?').run(action.status, JSON.stringify(action), action.id);
  }
  private message(id: string): WellbeingMessage | null {
    const row = this.db.prepare('SELECT body FROM wellbeing_messages WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as WellbeingMessage : null;
  }
  private delivery(id: string, delivery: WellbeingDelivery): void {
    const message = this.message(id); if (!message) return;
    message.delivery = delivery;
    this.db.prepare('UPDATE wellbeing_messages SET body=? WHERE id=?').run(JSON.stringify(message), id);
  }
  private latestWearerId(): string | null {
    const row = this.db.prepare("SELECT id FROM wellbeing_messages WHERE speaker='wearer' ORDER BY rowid DESC LIMIT 1").get();
    return row ? String(row.id) : null;
  }
  private publicAction(action: StoredAction): WellbeingAction {
    const { messageId, wearerMessageId, phone, dailyDate, scheduled, ...visible } = action;
    return visible;
  }
  private enqueue(type: WellbeingAction['type'], text: string, key: string, extra: Partial<StoredAction> = {}, generation?: WellbeingMessage['generation'],
    clinical?: { context: WellbeingRecordContext; snapshot: PatientRecordSnapshot | null }): boolean {
    const message: WellbeingMessage = { id: randomUUID(), speaker: 'lifeline', text, source: type === 'daily_checkin' ? 'daily-checkin' : 'agent',
      at: this.now(), delivery: 'queued', ...(generation ? { generation } : {}), ...(clinical ? { recordContext: clinical.context } : {}) };
    const action: StoredAction = { id: randomUUID(), conversationId: this.conversationId, type, text, status: 'queued', attempts: 0,
      createdAt: this.now(), providerMessageId: null, providerResult: null, messageId: message.id, phone: this.options.phone ?? '', ...extra };
    const inserted = this.db.prepare('INSERT OR IGNORE INTO wellbeing_actions VALUES (?,?,?,?)').run(action.id, key, action.status, JSON.stringify(action)).changes === 1;
    if (!inserted) return false;
    this.db.prepare('INSERT INTO wellbeing_messages VALUES (?,?,?,?,?,?,?)').run(message.id, message.speaker, null, JSON.stringify(message), null, null, null);
    if (clinical?.snapshot) this.db.prepare('INSERT INTO wellbeing_record_snapshots VALUES (?,?,?)')
      .run(extra.wearerMessageId!, message.id, JSON.stringify(clinical.snapshot));
    return true;
  }
  private queueDaily(scheduled: boolean): boolean {
    if (!this.options.enabled || !this.options.phone) return false;
    const date = this.localDate().date;
    return this.transaction(() => this.enqueue('daily_checkin',
      `Hi ${this.options.wearerName}, how are you feeling today? Reply here, or hold the blue button on WILi, speak, and release.`, `daily:${date}`, { dailyDate: date, scheduled }));
  }
  /** Explicit authenticated demo request; scheduler-only catch-up limits still apply to tick(). */
  queueDailyCheckin(): boolean { return this.queueDaily(false); }
  tick(blocked: boolean): void {
    const local = this.localDate();
    for (const action of this.actions().filter(action => action.status === 'queued')) this.actionPermitted(action, blocked);
    if (!blocked && this.inWindow(local)) this.queueDaily(true);
  }
  actionPermitted(action: WellbeingAction, blocked: boolean): boolean {
    const stored = this.action(action.id);
    if (!stored || stored.conversationId !== this.conversationId || !['queued', 'attempting'].includes(stored.status)) return false;
    const local = this.localDate();
    const expired = stored.type === 'daily_checkin' && (stored.dailyDate !== local.date || (stored.scheduled && !this.inWindow(local)));
    const staleReply = stored.type === 'reply' && stored.wearerMessageId !== this.latestWearerId();
    if (expired || staleReply) {
      stored.status = 'cancelled'; stored.providerResult = expired ? 'Daily check-in window ended; no late catch-up.' : 'A newer wearer message superseded this reply.';
      this.saveAction(stored); this.delivery(stored.messageId, 'cancelled'); return false;
    }
    return this.options.enabled && !blocked && Boolean(this.options.phone) && stored.phone === this.options.phone;
  }
  claimAction(): WellbeingAction | null {
    return this.transaction(() => {
      for (const action of this.actions().filter(action => action.status === 'queued')) {
        if (!this.actionPermitted(action, false)) continue;
        action.status = 'attempting'; action.attempts++; this.saveAction(action); this.delivery(action.messageId, 'attempting');
        return this.publicAction(action);
      }
      return null;
    });
  }
  finishAction(id: string, status: ProviderResult['status'], detail: string, messageId?: string, channel?: { chatId?: string; lineId?: string }): void {
    this.transaction(() => {
      const action = this.action(id);
      // Cancellation during the final authorization check may precede a remote
      // result. Preserve actual post-submission acceptance/uncertainty if returned.
      if (!action || !['attempting', 'cancelled'].includes(action.status) || !action.attempts) return;
      action.status = status === 'provider_accepted' && !validId(messageId) ? 'unknown' : status;
      action.providerResult = detail.slice(0, 500);
      action.providerMessageId = action.status === 'provider_accepted' && validId(messageId) ? messageId : null;
      if (action.status === 'provider_accepted') {
        if (validId(channel?.chatId)) action.providerChatId = channel.chatId;
        if (validId(channel?.lineId)) action.providerLineId = channel.lineId;
      }
      this.saveAction(action); this.delivery(action.messageId, action.status);
    });
  }
  matchesConversation(event: ProviderInbound): boolean {
    if (!this.options.enabled || !this.options.phone || typeof event.sender !== 'string'
      || phoneIdentity(event.sender) !== phoneIdentity(this.options.phone) || !validId(event.chatId) || !validId(event.lineId)) return false;
    const accepted = this.actions().filter(action => action.status === 'provider_accepted' && action.providerMessageId
      && action.phone === this.options.phone && action.providerChatId === event.chatId && action.providerLineId === event.lineId);
    return event.targetMessageId !== undefined
      ? validId(event.targetMessageId) && accepted.some(action => action.providerMessageId === event.targetMessageId)
      : accepted.length > 0;
  }
  /** Native Photon onboarding reuses this exact accepted wearer chat. */
  acceptedConversation(): { chatId: string; lineId: string } | null {
    const action = this.actions().findLast(a => a.status === 'provider_accepted' && a.phone === this.options.phone
      && validId(a.providerMessageId) && validId(a.providerChatId) && validId(a.providerLineId));
    return action ? { chatId: action.providerChatId!, lineId: action.providerLineId! } : null;
  }
  private appendWearer(text: string, source: 'photon-imessage' | 'freewili-local-speech', eventId: string, channel?: { target: string; chatId: string; lineId: string }): boolean {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO wellbeing_inbound VALUES (?,?)').run(source, eventId).changes === 1;
    if (!inserted) return false;
    this.db.prepare("UPDATE wellbeing_messages SET reply_state='superseded' WHERE speaker='wearer' AND reply_state='pending'").run();
    for (const action of this.actions().filter(action => action.type === 'reply' && action.status === 'queued')) {
      action.status = 'cancelled'; action.providerResult = 'A newer wearer message superseded this reply.';
      this.saveAction(action); this.delivery(action.messageId, 'cancelled');
    }
    const message: WellbeingMessage = { id: randomUUID(), speaker: 'wearer', text: text.trim(), source, at: this.now(), delivery: 'recorded' };
    this.db.prepare('INSERT INTO wellbeing_messages VALUES (?,?,?,?,?,?,?)').run(message.id, 'wearer', 'pending', JSON.stringify(message), channel?.target ?? null, channel?.chatId ?? null, channel?.lineId ?? null);
    return true;
  }
  recordText(event: ProviderInbound): boolean {
    if (event.kind !== 'text' || event.removed || !validId(event.messageId) || !validText(event.text) || !this.matchesConversation(event)) return false;
    return this.transaction(() => this.appendWearer(event.text!, 'photon-imessage', event.messageId,
      { target: event.messageId, chatId: event.chatId!, lineId: event.lineId! }));
  }
  recordVoice(input: { eventId: string; conversationId: string; transcript: string; sessionId: string }): boolean {
    if (!this.options.enabled || input.conversationId !== this.conversationId || !validId(input.eventId)
      || !validId(input.sessionId) || !validText(input.transcript)) return false;
    return this.transaction(() => this.appendWearer(input.transcript, 'freewili-local-speech', input.eventId));
  }
  replyNeeded(): WellbeingPendingMessage | null {
    if (!this.options.enabled) return null;
    const row = this.db.prepare("SELECT body,reply_to,chat_id,line_id FROM wellbeing_messages WHERE speaker='wearer' AND reply_state='pending' ORDER BY rowid DESC LIMIT 1").get() as MessageRow | undefined;
    if (!row) return null;
    return { ...JSON.parse(row.body) as WellbeingMessage, speaker: 'wearer', conversationId: this.conversationId,
      ...(row.reply_to && row.chat_id && row.line_id ? { replyToMessageId: row.reply_to, replyChatId: row.chat_id, replyLineId: row.line_id } : {}) };
  }
  /** Root incident policy calls this after independently routing an authenticated help request. */
  markIncidentRouted(messageId: string): void {
    this.db.prepare("UPDATE wellbeing_messages SET reply_state='incident' WHERE id=? AND speaker='wearer' AND reply_state='pending'").run(messageId);
  }
  queueReply(messageId: string, text: string, generation: 'ai' | 'degraded'): boolean {
    if (!this.options.enabled || !validText(text) || !['ai', 'degraded'].includes(generation) || (text.match(/\?/g) ?? []).length > 1) return false;
    return this.transaction(() => {
      const pending = this.replyNeeded();
      if (!pending || pending.id !== messageId || this.latestWearerId() !== messageId) return false;
      const queued = this.enqueue('reply', text.trim(), `reply:${messageId}`, { wearerMessageId: messageId,
        ...(pending.replyToMessageId ? { replyToMessageId: pending.replyToMessageId, replyChatId: pending.replyChatId, replyLineId: pending.replyLineId } : {}) }, generation);
      if (queued) this.db.prepare("UPDATE wellbeing_messages SET reply_state='queued' WHERE id=?").run(messageId);
      return queued;
    });
  }
  /** Keep the answer tied to the exact fictional record used, including across refreshes/restarts. */
  queueRecordReply(messageId: string, text: string, generation: NonNullable<WellbeingMessage['generation']>,
    context: WellbeingRecordContext, snapshot?: PatientRecordSnapshot): boolean {
    if (!this.options.enabled || typeof text !== 'string' || !text.trim() || text.length > 6000
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || !['ai', 'degraded', 'policy_refusal'].includes(generation)
      || context.source !== 'finchnode-synthetic' || context.synthetic !== true || typeof context.truncated !== 'boolean'
      || !Array.isArray(context.sourceRecordIds) || context.sourceRecordIds.length > 2000
      || context.sourceRecordIds.some(id => !validId(id)) || new Set(context.sourceRecordIds).size !== context.sourceRecordIds.length) return false;
    if (snapshot) {
      const name = snapshot.records.find(record => record.category === 'demographics')?.fields.name;
      if (snapshot.provider !== 'finchnode' || snapshot.synthetic !== true || snapshot.environment !== 'demo'
        || !validId(snapshot.revision) || context.revision !== snapshot.revision || context.subjectId !== snapshot.subject
        || context.subjectName !== (typeof name === 'string' ? name : null) || context.retrievedAt !== snapshot.fetchedAt
        || !Number.isFinite(snapshot.fetchedAt) || context.sourceRecordIds.some(id => !snapshot.records.some(record => record.id === id))) return false;
    } else if (context.revision !== null || context.subjectId !== null || context.subjectName !== null
      || context.retrievedAt !== null || context.sourceRecordIds.length !== 0 || generation === 'ai') return false;
    // Serialize before touching the outbox, so the export cannot follow a later mutation of the cached record.
    const serialized = snapshot ? JSON.stringify(snapshot) : null;
    if (serialized && Buffer.byteLength(serialized) > 2_000_000) return false;
    const copiedContext: WellbeingRecordContext = { source: 'finchnode-synthetic', synthetic: true,
      subjectId: context.subjectId, subjectName: context.subjectName, revision: context.revision,
      sourceRecordIds: [...context.sourceRecordIds], retrievedAt: context.retrievedAt, truncated: context.truncated, requestMessageId: messageId };
    return this.transaction(() => {
      const pending = this.replyNeeded();
      if (!pending || pending.id !== messageId || this.latestWearerId() !== messageId) return false;
      const queued = this.enqueue('reply', text.trim(), `reply:${messageId}`, { wearerMessageId: messageId,
        ...(pending.replyToMessageId ? { replyToMessageId: pending.replyToMessageId, replyChatId: pending.replyChatId, replyLineId: pending.replyLineId } : {}) },
      generation, { context: copiedContext, snapshot: serialized ? JSON.parse(serialized) as PatientRecordSnapshot : null });
      if (queued) this.db.prepare("UPDATE wellbeing_messages SET reply_state='queued' WHERE id=?").run(messageId);
      return queued;
    });
  }
  /** Protected export. Native chat IDs, phone numbers and the current mutable record are excluded. */
  careJournal() {
    const messages = this.view().messages;
    const snapshots = this.db.prepare(`SELECT request_message_id,reply_message_id,body FROM wellbeing_record_snapshots
      WHERE reply_message_id IN (SELECT id FROM wellbeing_messages ORDER BY rowid DESC LIMIT 40) ORDER BY rowid`)
      .all().map(row => ({
        requestMessageId: String(row.request_message_id), replyMessageId: String(row.reply_message_id),
        snapshot: JSON.parse(String(row.body)) as PatientRecordSnapshot,
      }));
    return { schemaVersion: 1, kind: 'LIFELINE care journal', exportedAt: new Date(this.now()).toISOString(),
      hospitalRecords: { source: 'FinchNode read-only synthetic demo; not the wearer’s personal EHR', snapshots },
      lifelineObservations: { source: 'LIFELINE local everyday conversation; not hospital EHR entries',
        conversationId: this.conversationId, historyWindow: 'Most recent 40 messages', messages,
        limitations: 'Messages are attributed reports. This journal does not diagnose, score mood, or write to hospital records.' },
    };
  }
  view(): WellbeingView {
    const date = this.db.prepare("SELECT json_extract(body,'$.dailyDate') AS date FROM wellbeing_actions WHERE json_extract(body,'$.type')='daily_checkin' ORDER BY rowid DESC LIMIT 1").get();
    const messages = this.db.prepare('SELECT body FROM wellbeing_messages ORDER BY rowid DESC LIMIT 40').all().reverse().map(row => JSON.parse(String(row.body)) as WellbeingMessage);
    const pendingReplies = Number(this.db.prepare("SELECT COUNT(*) AS count FROM wellbeing_messages WHERE speaker='wearer' AND reply_state='pending'").get()!.count);
    return { conversationId: this.conversationId, enabled: this.options.enabled,
      schedule: { hour: this.options.hour, timeZone: this.options.timezone, label: `${String(this.options.hour).padStart(2, '0')}:00 ${this.options.timezone}` },
      lastCheckinDate: date?.date ? String(date.date) : null, messages,
      pendingCount: pendingReplies + this.actions().filter(action => ['queued', 'attempting'].includes(action.status)).length };
  }
  close(): void { this.db.close(); }
}
