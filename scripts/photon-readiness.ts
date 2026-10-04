import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { Chat, Message, MessageListFilter, MessageListPage } from '@photon-ai/advanced-imessage/grpc';
import type { Action } from '../src/contracts.ts';

type UnknownAction = Pick<Action, 'id' | 'type' | 'recipientId' | 'status' | 'createdAt' | 'text' | 'providerMessageId'>;
export interface PhotonReadClient {
  chats: { get(chat: string): Promise<Chat> };
  messages: {
    get(message: string): Promise<Message>;
    listInChat(chat: string, options: MessageListFilter): Promise<MessageListPage>;
  };
  close(): Promise<void>;
}
interface ProjectUser { id: string; projectId: string; type: string; phoneNumber: string; assignedPhoneNumber: string; createdAt: string }
interface Contact { role: string; phone: string; recipientId: string | null }
interface ReadError { operation: 'token' | 'users' | 'chat' | 'history' | 'message' | 'close'; grpcCode?: number; httpStatus?: number }
interface NativeProof { at: string; deliveredAt: string | null; isSent: boolean; isDelivered: boolean; sendErrorCode: number }
interface UnknownEvidence {
  actionIndex: number; type: Action['type']; createdAt: string; status: 'unknown_preserved';
  correlation: 'provider_message_id' | 'exact_content_window';
  candidateCount: number; verifiedMatchCount: number;
  evidence: 'matching_native_candidate' | 'delivered' | 'sent_not_delivered' | 'native_failed' | 'conflicting_native_state' | 'ambiguous' | 'not_found_in_window' | 'unverified';
  nativeState: 'delivered' | 'sent_not_delivered' | 'native_failed' | 'conflicting_native_state' | 'unverified' | null;
  native: NativeProof[];
}
interface RoleEvidence {
  role: string; registration: 'verified' | 'not_found' | 'ambiguous' | 'incomplete' | 'unavailable';
  assignedLine: string | null; service: 'iMessage' | 'SMS' | 'RCS' | 'unknown'; exactChatMatched: boolean;
  historyComplete: boolean; historyPages: number;
  observedInboundTexts: number; latestInboundAt: string | null; inboundCountIsQuotaCounter: false;
  nativeLine: { verified: boolean; matchingMessages: number; conflictingMessages: number };
  unknownActions: UnknownEvidence[]; errors: ReadError[];
}
export interface PhotonReadinessReport {
  at: string; status: 'read_evidence_available' | 'attention_required'; readOnly: true; externalMessages: false;
  outboundReadiness: 'not_probed'; warmupQuota: 'not_exposed_by_read_api'; unknownActionsUnchanged: true;
  results: RoleEvidence[]; errors: ReadError[];
}
const actionTypes = new Set(['checkin', 'wearer_checkin', 'wearer_ack', 'wearer_status', 'wearer_location', 'wearer_relay', 'alert', 'status', 'handoff', 'answer']);
const e164 = /^\+[1-9]\d{7,14}$/;
const service = (value: unknown): RoleEvidence['service'] => value === 'iMessage' || value === 'SMS' || value === 'RCS' ? value : 'unknown';
const dateMs = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : NaN;
function nativePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.replace(/^p:/, '');
  return /^\+?[1-9]\d{7,14}$/.test(address) ? `+${address.replace(/^\+/, '')}` : null;
}
function readError(operation: ReadError['operation'], error: unknown): ReadError {
  const raw = error && typeof error === 'object' ? error as { grpcCode?: unknown; httpStatus?: unknown } : {};
  return { operation,
    ...(Number.isInteger(raw.grpcCode) && Number(raw.grpcCode) >= 0 && Number(raw.grpcCode) <= 16 ? { grpcCode: Number(raw.grpcCode) } : {}),
    ...(Number.isInteger(raw.httpStatus) && Number(raw.httpStatus) >= 100 && Number(raw.httpStatus) <= 599 ? { httpStatus: Number(raw.httpStatus) } : {}),
  };
}
function contactsFrom(env: Record<string, string | undefined>): Contact[] {
  const phone = env.LIFELINE_WEARER_PHONE?.trim();
  let responders: unknown;
  try { responders = JSON.parse(env.LIFELINE_RESPONDERS_JSON ?? '[]'); } catch { throw new Error('Invalid approved contact configuration.'); }
  if (!phone || !e164.test(phone) || !Array.isArray(responders) || responders.length > 10) throw new Error('Approved wearer and responder configuration required.');
  const contacts: Contact[] = [{ role: 'wearer', phone, recipientId: null }];
  for (const [index, value] of responders.entries()) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id
      || !(value.phone === null || (typeof value.phone === 'string' && e164.test(value.phone)))) throw new Error('Invalid approved contact configuration.');
    if (value.phone) contacts.push({ role: `responder-${index + 1}`, phone: value.phone, recipientId: value.id });
  }
  if (contacts.length < 2 || new Set(contacts.map(contact => contact.phone)).size !== contacts.length
    || new Set(contacts.map(contact => contact.recipientId)).size !== contacts.length) throw new Error('Approved contact identities must be distinct.');
  return contacts;
}

/** Opens only the existing SQLite file; never constructs the recovering Controller. */
export function readUnknownActions(path: string): UnknownAction[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT body FROM actions WHERE status='unknown' ORDER BY rowid LIMIT 101").all();
    if (rows.length > 100) throw new Error('More than 100 unknown actions; narrow reconciliation before using this command.');
    return rows.map(row => {
      const value = JSON.parse(String(row.body));
      if (value?.status !== 'unknown' || typeof value.id !== 'string' || !actionTypes.has(value.type)
        || !(value.recipientId === null || typeof value.recipientId === 'string')
        || typeof value.text !== 'string' || !value.text || value.text.length > 6000 || !Number.isFinite(value.createdAt)
        || !Number.isFinite(new Date(value.createdAt).getTime())
        || !(value.providerMessageId === null || typeof value.providerMessageId === 'string')) throw new Error('Malformed persisted unknown action.');
      return { id: value.id, type: value.type, recipientId: value.recipientId, status: value.status,
        createdAt: value.createdAt, text: value.text, providerMessageId: value.providerMessageId };
    });
  } finally { db.close(); }
}

async function boundedJson(response: Response): Promise<any> {
  if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('Invalid JSON read response.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing read response.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 1_000_000) throw new Error('Read response exceeds bound.');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Read-only auth/history proof. Counts are observations, never a provider quota. */
export async function runPhotonReadiness(options: {
  env: Record<string, string | undefined>; unknownActions?: readonly UnknownAction[];
  fetch?: typeof fetch; clientFactory?: (token: string) => Promise<PhotonReadClient>;
  now?: () => number; maxPages?: number; httpGapMs?: number;
}): Promise<PhotonReadinessReport> {
  const { env } = options, projectId = env.SPECTRUM_PROJECT_ID?.trim(), secret = env.SPECTRUM_PROJECT_SECRET?.trim();
  if (!projectId || !secret) throw new Error('Photon project configuration required.');
  const contacts = contactsFrom(env), actions = options.unknownActions ?? [], now = (options.now ?? Date.now)();
  const maxPages = options.maxPages ?? 5, gap = options.httpGapMs ?? 250;
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10
    || !Number.isFinite(gap) || gap < 0 || gap > 1000) throw new Error('Invalid read bounds.');
  const report: PhotonReadinessReport = { at: new Date(now).toISOString(), status: 'read_evidence_available',
    readOnly: true, externalMessages: false, outboundReadiness: 'not_probed', warmupQuota: 'not_exposed_by_read_api',
    unknownActionsUnchanged: true, results: [], errors: [] };
  const fetcher = options.fetch ?? fetch, authorization = `Basic ${Buffer.from(`${projectId}:${secret}`).toString('base64')}`;
  let lastHttpAt = 0;
  async function management(path: string, method: 'GET' | 'POST' = 'GET') {
    const delay = Math.max(0, gap - (Date.now() - lastHttpAt)); if (delay) await pause(delay);
    lastHttpAt = Date.now();
    const response = await fetcher(`https://spectrum.photon.codes/projects/${encodeURIComponent(projectId!)}${path}`, {
      method, redirect: 'error', headers: { Authorization: authorization }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Object.assign(new Error('Project read unavailable.'), { httpStatus: response.status });
    const payload = await boundedJson(response);
    if (payload?.succeed !== true || !payload.data) throw new Error('Invalid project read envelope.');
    return payload.data;
  }
  async function projectUsers(contact: Contact): Promise<{ users: ProjectUser[]; complete: boolean }> {
    const users: ProjectUser[] = [], ids = new Set<string>(); let total: number | null = null, offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const data = await management(`/users/?type=shared&search=${encodeURIComponent(contact.phone)}&limit=100&offset=${offset}`);
      if (!Array.isArray(data.users) || data.users.length > 100 || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Invalid Users pagination.');
      if (total !== null && total !== data.total) return { users, complete: false };
      const pageTotal = data.total as number;
      total = pageTotal;
      for (const value of data.users) {
        if (!value || typeof value.id !== 'string' || typeof value.projectId !== 'string' || typeof value.type !== 'string'
          || typeof value.phoneNumber !== 'string' || typeof value.assignedPhoneNumber !== 'string' || typeof value.createdAt !== 'string') throw new Error('Invalid project user.');
        if (ids.has(value.id)) return { users, complete: false };
        ids.add(value.id); users.push(value);
      }
      offset += data.users.length;
      if (offset === pageTotal) return { users, complete: true };
      if (offset > pageTotal || !data.users.length) return { users, complete: false };
    }
    return { users, complete: false };
  }
  let client: PhotonReadClient;
  try {
    const tokenData = await management('/imessage/tokens', 'POST');
    if (tokenData.type !== 'shared' || typeof tokenData.token !== 'string' || !tokenData.token) throw new Error('Shared Photon read token required.');
    client = options.clientFactory ? await options.clientFactory(tokenData.token) : (await import('@photon-ai/advanced-imessage/grpc')).createGrpcClient({
      address: 'imessage.spectrum.photon.codes:443', token: tokenData.token, tls: true, retry: false, timeout: 10000,
    });
  } catch (error) {
    report.errors.push(readError('token', error)); report.status = 'attention_required'; return report;
  }
  try {
    for (const contact of contacts) {
      const pending = actions.flatMap((action, index) => action.status === 'unknown' && action.recipientId === contact.recipientId
        && action.type !== 'checkin' ? [{ action, index }] : []);
      const result: RoleEvidence = { role: contact.role, registration: 'unavailable', assignedLine: null, service: 'unknown',
        exactChatMatched: false, historyComplete: false, historyPages: 0, observedInboundTexts: 0, latestInboundAt: null,
        inboundCountIsQuotaCounter: false, nativeLine: { verified: false, matchingMessages: 0, conflictingMessages: 0 },
        unknownActions: pending.map(({ action, index }) => ({ actionIndex: index, type: action.type, createdAt: new Date(action.createdAt).toISOString(),
          status: 'unknown_preserved', correlation: action.providerMessageId ? 'provider_message_id' : 'exact_content_window',
          candidateCount: 0, verifiedMatchCount: 0, evidence: 'unverified', nativeState: null, native: [] })), errors: [] };
      report.results.push(result);
      let user: ProjectUser;
      try {
        const page = await projectUsers(contact);
        const matches = page.users.filter(user => user.projectId === projectId && user.type === 'shared' && user.phoneNumber === contact.phone);
        result.registration = !page.complete ? 'incomplete' : matches.length > 1 ? 'ambiguous' : matches.length ? 'verified' : 'not_found';
        if (result.registration !== 'verified') continue;
        user = matches[0];
        if (!e164.test(user.assignedPhoneNumber) || !Number.isFinite(Date.parse(user.createdAt)) || Date.parse(user.createdAt) >= now) throw new Error('Invalid assigned-line metadata.');
        result.assignedLine = user.assignedPhoneNumber;
      } catch (error) { result.registration = 'unavailable'; result.errors.push(readError('users', error)); continue; }
      const chatGuid = `any;-;${contact.phone}`;
      try {
        const chat = await client.chats.get(chatGuid);
        result.exactChatMatched = chat.guid === chatGuid && !chat.isGroup; result.service = service(chat.service);
        if (!result.exactChatMatched) continue;
      } catch (error) { result.errors.push(readError('chat', error)); continue; }
      const registrationAt = Date.parse(user.createdAt), after = Math.min(registrationAt, ...pending.map(({ action }) => action.createdAt - 1000));
      const messages = new Map<string, Message>(), pageTokens = new Set<string>(); let pageToken: string | undefined, invalidHistory = false;
      try {
        for (let page = 0; page < maxPages; page++) {
          const found = await client.messages.listInChat(chatGuid, { after: new Date(after), before: new Date(now), pageSize: 100, pageToken });
          if (!Array.isArray(found.messages) || found.messages.length > 100
            || (found.nextPageToken !== undefined && typeof found.nextPageToken !== 'string')) throw new Error('Invalid bounded history page.');
          result.historyPages++;
          for (const message of found.messages) {
            if (!message.guid || !message.chatGuids.includes(chatGuid) || dateMs(message.dateCreated) < after || dateMs(message.dateCreated) >= now
              || !Number.isFinite(dateMs(message.dateCreated)) || messages.has(message.guid)) { invalidHistory = true; continue; }
            messages.set(message.guid, message);
          }
          pageToken = found.nextPageToken;
          if (!pageToken) { result.historyComplete = !invalidHistory; break; }
          if (pageTokens.has(pageToken)) break;
          pageTokens.add(pageToken);
        }
      } catch (error) { result.errors.push(readError('history', error)); }
      const history = [...messages.values()];
      const approved = history.filter(message => message.isFromMe || nativePhone(message.sender?.address) === contact.phone);
      const inbound = approved.filter(message => !message.isFromMe && dateMs(message.dateCreated) >= registrationAt && typeof message.content.text === 'string' && message.content.text.trim());
      result.observedInboundTexts = inbound.length;
      result.latestInboundAt = inbound.length ? new Date(Math.max(...inbound.map(message => dateMs(message.dateCreated)))).toISOString() : null;
      for (const message of approved.filter(message => dateMs(message.dateCreated) >= registrationAt)) {
        const caller = nativePhone(message.destinationCallerId);
        if (caller === result.assignedLine) result.nativeLine.matchingMessages++;
        else if (caller !== null) result.nativeLine.conflictingMessages++;
      }
      result.nativeLine.verified = result.nativeLine.matchingMessages > 0 && !result.nativeLine.conflictingMessages;
      for (const [index, { action }] of pending.entries()) {
        const evidence = result.unknownActions[index];
        const candidates = action.providerMessageId ? [action.providerMessageId] : history.filter(message => message.isFromMe
          && message.content.text === action.text && dateMs(message.dateCreated) >= action.createdAt - 1000).map(message => message.guid);
        evidence.candidateCount = candidates.length;
        if (candidates.length > 1) { evidence.evidence = 'ambiguous'; continue; }
        for (const guid of candidates) {
          try {
            const message = await client.messages.get(guid);
            if (message.guid !== guid || !message.isFromMe || !message.chatGuids.includes(chatGuid) || message.content.text !== action.text
              || nativePhone(message.destinationCallerId) !== result.assignedLine || !Number.isFinite(dateMs(message.dateCreated))
              || dateMs(message.dateCreated) < action.createdAt - 1000 || dateMs(message.dateCreated) >= now) continue;
            evidence.native.push({ at: message.dateCreated.toISOString(), deliveredAt: Number.isFinite(dateMs(message.dateDelivered)) ? message.dateDelivered!.toISOString() : null,
              isSent: message.isSent, isDelivered: message.isDelivered, sendErrorCode: message.sendErrorCode });
          } catch (error) { result.errors.push(readError('message', error)); }
        }
        evidence.verifiedMatchCount = evidence.native.length;
        if (evidence.native.length === 1) {
          const proof = evidence.native[0];
          evidence.nativeState = (proof.isDelivered && (!proof.isSent || proof.sendErrorCode !== 0)) ? 'conflicting_native_state'
            : proof.sendErrorCode !== 0 ? 'native_failed' : proof.isSent && proof.isDelivered ? 'delivered'
            : proof.isSent ? 'sent_not_delivered' : 'unverified';
        }
        if (!action.providerMessageId && !result.historyComplete) evidence.evidence = 'ambiguous';
        else if (!candidates.length && result.historyComplete) evidence.evidence = 'not_found_in_window';
        else if (evidence.native.length === 1) {
          // A later identical send can share this content window. Native delivery
          // proves that candidate's state, never the original UNKNOWN submission.
          evidence.evidence = action.providerMessageId ? evidence.nativeState! : 'matching_native_candidate';
        }
      }
    }
  } finally { try { await client.close(); } catch (error) { report.errors.push(readError('close', error)); } }
  if (report.errors.length || report.results.some(role => role.registration !== 'verified' || !role.exactChatMatched || !role.historyComplete
    || !role.nativeLine.verified || role.errors.length)) report.status = 'attention_required';
  return report;
}

export async function photonReadinessMain(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run check:photon -- [--output private-report.json]\nReads repo .env and existing SQLite only. No sends, chat creation, enrollment or UNKNOWN retries. Inbound counts do not prove quota readiness.'); return;
  }
  if (args.length && !(args.length === 2 && args[0] === '--output' && args[1])) throw new Error('Use --help for the read-only command arguments.');
  const root = fileURLToPath(new URL('../', import.meta.url)), envPath = resolve(root, '.env');
  const env = parseEnv(await readFile(envPath, 'utf8'));
  const dbPath = resolve(root, env.LIFELINE_DATA_DIR ?? 'data', 'lifeline.sqlite');
  const outputPath = args.length ? resolve(args[1]) : null;
  if (outputPath === envPath || outputPath === dbPath) throw new Error('Report output cannot overwrite configuration or incident data.');
  const report = await runPhotonReadiness({ env, unknownActions: readUnknownActions(dbPath) });
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writePrivateReadinessReport(outputPath, report);
  console.log(encoded.trimEnd());
  if (report.status === 'attention_required') process.exitCode = 2;
}
export async function writePrivateReadinessReport(path: string, report: PhotonReadinessReport): Promise<void> {
  const file = await open(path, 'w', 0o600);
  try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(report, null, 2)}\n`); }
  finally { await file.close(); }
}
if (import.meta.main) void photonReadinessMain().catch(() => {
  console.error('Photon read-only evidence check failed. Check approved configuration and the existing local database; no messages were sent or retried.');
  process.exitCode = 2;
});
