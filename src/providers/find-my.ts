import type { ClientOptions, LocationRequestReceipt, SharedFriendLocation, SharedFriendLocationUpdated } from '@photon-ai/advanced-imessage/grpc';
import type { TokenData } from '@spectrum-ts/core';

export interface FindMySubject {
  role: 'wearer' | 'responder'; address: string; name: string; responderId?: string; incidentId?: string;
}
export interface FindMyPoint {
  latitude: number; longitude: number; accuracy: number | null; timestamp: number; receivedAt: number;
  sourceSequence: number; expiresAt?: number; source: 'photon-find-my';
}
export interface FindMyStream extends AsyncIterable<SharedFriendLocationUpdated> { close(): Promise<void> }
export interface FindMyClient {
  locations: {
    get(address: string): Promise<SharedFriendLocation>;
    request(chatId: string, address: string, options?: { clientMessageId?: string }): Promise<LocationRequestReceipt>;
    watch(address: string): FindMyStream;
  };
  close(): Promise<void>;
}
export interface FindMyFactoryOptions { env: NodeJS.ProcessEnv; onHeartbeat: () => void }
export type FindMyFactory = (options: FindMyFactoryOptions) => Promise<FindMyClient>;
export type FindMyPositionHandler = (subject: FindMySubject, point: FindMyPoint | null) => void;
export type FindMyRequestResult = { status: 'provider_accepted' | 'failed' | 'unknown'; detail: string; messageId?: string };

const PHONE = /^\+[1-9]\d{7,14}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const RPC_MS = 10_000, STALL_MS = 90_000, MAX_BACKOFF_MS = 30_000;
const SHARED_ADDRESS = 'imessage.spectrum.photon.codes:443';
class NativeConfiguration extends Error {}
function text(value: unknown, max = 100): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !CONTROL.test(value);
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function epoch(value: unknown): number | null {
  const result = value instanceof Date ? value.getTime() : NaN;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/** Native capture time is mandatory; receipt time is never substituted for it. */
export function normalizeFindMyPoint(location: SharedFriendLocation, sequence: number, receivedAt = Date.now()): FindMyPoint | null {
  const timestamp = epoch(location.locationTimestamp), expiresAt = location.expiresAt === undefined ? undefined : epoch(location.expiresAt);
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)
    || location.latitude! < -90 || location.latitude! > 90 || location.longitude! < -180 || location.longitude! > 180
    || timestamp === null || timestamp > receivedAt + 10_000 || !Number.isFinite(receivedAt) || receivedAt < 0
    || !Number.isSafeInteger(sequence) || sequence < 0
    || (location.accuracy !== undefined && (!Number.isFinite(location.accuracy) || location.accuracy < 0))
    || expiresAt === null || (expiresAt !== undefined && expiresAt <= receivedAt)) return null;
  return { latitude: location.latitude!, longitude: location.longitude!, accuracy: location.accuracy ?? null,
    timestamp, receivedAt, sourceSequence: sequence, ...(expiresAt === undefined ? {} : { expiresAt }), source: 'photon-find-my' };
}

interface NativeDependencies {
  mint?: (projectId: string, projectSecret: string) => Promise<TokenData>;
  createClient?: (options: ClientOptions) => FindMyClient;
  now?: () => number;
}
/** Adapted from Nook's native location client; SDK unary retries are deliberately disabled. */
export async function createNativeFindMyClient(options: FindMyFactoryOptions, dependencies: NativeDependencies = {}): Promise<FindMyClient> {
  const { env, onHeartbeat } = options;
  const projectId = env.SPECTRUM_PROJECT_ID?.trim(), projectSecret = env.SPECTRUM_PROJECT_SECRET?.trim();
  if (!projectId || !projectSecret) throw new NativeConfiguration('Find My credentials unavailable');
  const mint = dependencies.mint ?? (await import('@spectrum-ts/core')).cloud.issueImessageTokens;
  const createClient = dependencies.createClient ?? (await import('@photon-ai/advanced-imessage/grpc')).createGrpcClient;
  const now = dependencies.now ?? Date.now;
  let data = await mint(projectId, projectSecret), mintedAt = now(), minting: Promise<TokenData> | undefined;
  const lineId = data.type === 'dedicated' ? env.SPECTRUM_IMESSAGE_LINE_ID?.trim() || Object.keys(data.auth)[0] : undefined;
  if (data.type === 'dedicated' && (!lineId || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,199}$/.test(lineId)))
    throw new NativeConfiguration('Find My dedicated line unavailable');
  const address = data.type === 'shared' ? env.SPECTRUM_IMESSAGE_ADDRESS?.trim() || SHARED_ADDRESS : `${lineId}.imsg.photon.codes:443`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*:\d{1,5}$/.test(address) || Number(address.split(':')[1]) < 1 || Number(address.split(':')[1]) > 65535)
    throw new NativeConfiguration('Find My service address invalid');
  const initialType = data.type;
  const tokenFor = (current: TokenData): string => {
    if (current.type !== initialType || !Number.isFinite(current.expiresIn) || current.expiresIn <= 0)
      throw new NativeConfiguration('Find My token configuration changed');
    const token = current.type === 'shared' ? current.token : lineId ? current.auth[lineId] : undefined;
    if (typeof token !== 'string' || !token) throw new NativeConfiguration('Find My line token unavailable');
    return token;
  };
  tokenFor(data);
  async function token(): Promise<string> {
    if (now() - mintedAt >= data.expiresIn * 800) {
      minting ??= Promise.resolve().then(() => mint(projectId!, projectSecret!)).then(next => {
        tokenFor(next); data = next; mintedAt = now(); return next;
      }).finally(() => { minting = undefined; });
      await minting;
    }
    return tokenFor(data);
  }
  return createClient({ address, tls: true, retry: false, timeout: RPC_MS, autoIdempotency: true, onHeartbeat, token });
}

class Stopped extends Error {}
class Deadline extends Error {}
async function bounded<T>(promise: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T> {
  if (signal?.aborted) { void promise.catch(() => {}); throw new Stopped(); }
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      if (signal) { abort = () => reject(new Stopped()); signal.addEventListener('abort', abort, { once: true }); }
      if (ms !== undefined) timer = setTimeout(() => reject(new Deadline()), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await bounded(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { if (timer) clearTimeout(timer); }
}
const grpcNames = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
function safeError(error: unknown): string {
  if (error instanceof Deadline) return 'adapter deadline exceeded';
  if (error instanceof NativeConfiguration) return 'native configuration unavailable';
  const e = object(error), code = e?.grpcCode;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code < grpcNames.length) return `gRPC ${grpcNames[code]}`;
  if (e?.name === 'AuthenticationError' || e?.name === 'ValidationError' || e?.name === 'NotFoundError' || e?.name === 'ConnectionError') return e.name;
  return 'no safe provider error metadata';
}
function fatal(error: unknown): boolean {
  const e = object(error);
  return error instanceof NativeConfiguration || e?.name === 'AuthenticationError' || e?.name === 'ValidationError'
    || e?.status === 401 || e?.status === 403 || [3, 7, 12, 16].includes(Number(e?.grpcCode));
}
function subjectKey(subject: FindMySubject): string {
  return JSON.stringify([subject.role, subject.address, subject.responderId, subject.incidentId]);
}

/** No friend enumeration, chat creation, simulated fixes, or uncertain-send retry. */
export function createFindMy(options: { env?: NodeJS.ProcessEnv; factory?: FindMyFactory; onPosition?: FindMyPositionHandler } = {}) {
  const env = { ...(options.env ?? process.env) };
  const configured = Boolean(env.SPECTRUM_PROJECT_ID?.trim() && env.SPECTRUM_PROJECT_SECRET?.trim());
  const wearer = env.LIFELINE_WEARER_PHONE?.trim();
  const responders = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(env.LIFELINE_RESPONDERS_JSON || '[]');
    if (Array.isArray(parsed)) for (const value of parsed.slice(0, 100)) {
      const r = object(value);
      if (text(r?.id) && typeof r?.phone === 'string' && PHONE.test(r.phone)) responders.set(r.id, r.phone);
    }
  } catch { /* malformed approval configuration grants no responder access */ }
  let detail = configured ? 'Native Find My configured; sharing permission has not been established.'
    : 'Native Find My unconfigured: set Photon project credentials.';
  let closed = false, started = false, subjects: (() => FindMySubject[]) | undefined;
  let handler = options.onPosition;
  let clientPromise: Promise<FindMyClient> | undefined, activeClient: FindMyClient | undefined, stopping: Promise<void> | undefined;
  const lifecycle = new AbortController();
  let reconcileTimer: ReturnType<typeof setInterval> | undefined, watchdog: ReturnType<typeof setInterval> | undefined;
  const work = new Set<Promise<void>>(), closedClients = new WeakSet<FindMyClient>();
  const seeded = new Set<string>(), blockedWatches = new Set<string>();
  interface Slot { subject: FindMySubject; abort: AbortController; cycle?: AbortController; stream?: FindMyStream; closing?: Promise<void>; lastActivity: number }
  const slots = new Map<string, Slot>();
  const approved = (subject: FindMySubject): boolean => text(subject.name) && PHONE.test(subject.address)
    && (subject.role === 'wearer' ? subject.address === wearer
      : subject.role === 'responder' && text(subject.responderId) && text(subject.incidentId, 200) && responders.get(subject.responderId) === subject.address);
  function currentSubjects(): FindMySubject[] {
    try {
      const values = subjects?.() ?? (wearer && PHONE.test(wearer) ? [{ role: 'wearer' as const, address: wearer, name: 'Wearer' }] : []);
      return values.filter(value => value && approved(value)).slice(0, 100);
    } catch { detail = 'Native Find My subject policy unavailable; no lookup or output is authorized.'; return []; }
  }
  const stillCurrent = (subject: FindMySubject): FindMySubject | undefined => !closed
    ? currentSubjects().find(current => subjectKey(current) === subjectKey(subject)) : undefined;
  const emit = (subject: FindMySubject, point: FindMyPoint | null): void => {
    const current = stillCurrent(subject); if (!current) return;
    if (point) detail = 'Native Find My receiving approved location updates; native capture time controls freshness.';
    try { handler?.({ ...current }, point); } catch { detail = 'Native location could not be recorded; no position is assumed.'; }
  };
  async function closeClient(client: FindMyClient): Promise<void> {
    if (closedClients.has(client)) return; closedClients.add(client);
    await bounded(Promise.resolve().then(() => client.close()), undefined, 2000).catch(() => {});
  }
  function getClient(): Promise<FindMyClient> {
    if (closed) return Promise.reject(new Stopped());
    if (!clientPromise) {
      const pending = Promise.resolve().then(() => (options.factory ?? createNativeFindMyClient)({ env, onHeartbeat: () => {
        const now = Date.now(); for (const slot of slots.values()) slot.lastActivity = now;
      } }));
      clientPromise = pending;
      void pending.then(client => { if (closed) void closeClient(client); else activeClient = client; }, () => { if (clientPromise === pending) clientPromise = undefined; });
    }
    return clientPromise;
  }
  function closeStream(slot: Slot): Promise<void> {
    if (!slot.stream) return Promise.resolve();
    slot.closing ??= bounded(Promise.resolve().then(() => slot.stream!.close()), undefined, 2000).catch(() => {});
    return slot.closing;
  }
  function track(task: Promise<void>): void { work.add(task); void task.finally(() => work.delete(task)).catch(() => {}); }
  async function watchLoop(client: FindMyClient, slot: Slot): Promise<void> {
    let backoff = 1000;
    while (!closed && !slot.abort.signal.aborted && stillCurrent(slot.subject)) {
      const cycle = new AbortController(); slot.cycle = cycle; slot.lastActivity = Date.now();
      const cancel = () => cycle.abort(); slot.abort.signal.addEventListener('abort', cancel, { once: true });
      let lastSequence = -1;
      try {
        slot.stream = client.locations.watch(slot.subject.address); slot.closing = undefined;
        const iterator = slot.stream[Symbol.asyncIterator]();
        while (!closed && !slot.abort.signal.aborted) {
          const next = await bounded(iterator.next(), cycle.signal);
          if (next.done) break;
          slot.lastActivity = Date.now(); backoff = 1000;
          const update = next.value;
          if (!update || update.location?.address !== slot.subject.address || !Number.isSafeInteger(update.sourceSequence)
            || update.sourceSequence < 0 || update.sourceSequence <= lastSequence) continue;
          lastSequence = update.sourceSequence;
          const point = normalizeFindMyPoint(update.location, update.sourceSequence);
          if (point) emit(slot.subject, point);
          // Missing coordinates/time while locating are not proof of revocation.
          // Only an explicit expired native sharing window clears retained context.
          else if (epoch(update.location.expiresAt) !== null && epoch(update.location.expiresAt)! <= Date.now()) emit(slot.subject, null);
        }
        if (!closed && !slot.abort.signal.aborted) detail = 'Native Find My stream ended; reconnecting approved watches.';
      } catch (error) {
        if (!closed && !slot.abort.signal.aborted) {
          detail = `Native Find My watch unavailable (${safeError(error)}); no current location is assumed.`;
          if (fatal(error)) { blockedWatches.add(subjectKey(slot.subject)); break; }
        }
      } finally {
        slot.abort.signal.removeEventListener('abort', cancel); await closeStream(slot);
        slot.stream = undefined; slot.closing = undefined; slot.cycle = undefined;
      }
      if (closed || slot.abort.signal.aborted || !stillCurrent(slot.subject)) break;
      try { await delay(backoff, slot.abort.signal); } catch { break; }
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  function reconcile(client: FindMyClient): void {
    const desired = new Map(currentSubjects().map(subject => [subject.address, subject]));
    for (const [address, slot] of slots) {
      if (!desired.has(address) || subjectKey(desired.get(address)!) !== subjectKey(slot.subject)) {
        slot.abort.abort(); slot.cycle?.abort(); void closeStream(slot);
      }
    }
    for (const [address, subject] of desired) {
      if (slots.has(address) || blockedWatches.has(subjectKey(subject))) continue;
      const slot: Slot = { subject: { ...subject }, abort: new AbortController(), lastActivity: Date.now() };
      slots.set(address, slot);
      const task = watchLoop(client, slot).finally(() => { if (slots.get(address) === slot) slots.delete(address); });
      track(task);
      // A cached snapshot has no stream sequence. Zero identifies this initial read;
      // its original native timestamp still controls freshness and replay rejection.
      if (subject.role === 'wearer' && !seeded.has(subjectKey(subject))) { seeded.add(subjectKey(subject)); track(bounded(Promise.resolve().then(() => client.locations.get(address)), slot.abort.signal, RPC_MS).then(location => {
        if (!slot.abort.signal.aborted && location.address === address) {
          const point = normalizeFindMyPoint(location, 0);
          if (point) emit(subject, point);
          else if (epoch(location.expiresAt) !== null && epoch(location.expiresAt)! <= Date.now()) emit(subject, null);
        }
      }).catch(error => {
        if (!closed && !slot.abort.signal.aborted) detail = `Cached native Find My lookup has no usable snapshot (${safeError(error)}); approved watches remain active.`;
      })); }
    }
  }
  async function stop(): Promise<void> {
    if (stopping) return stopping;
    closed = true; lifecycle.abort(); if (reconcileTimer) clearInterval(reconcileTimer); if (watchdog) clearInterval(watchdog);
    for (const slot of slots.values()) { slot.abort.abort(); slot.cycle?.abort(); }
    stopping = (async () => {
      await Promise.all([...slots.values()].map(closeStream));
      if (activeClient) await closeClient(activeClient);
      await Promise.allSettled([...work]); slots.clear(); detail = 'Native Find My stopped.';
    })();
    return stopping;
  }
  return {
    status: () => ({ configured, detail }),
    async request(address: string, chatId: string, clientMessageId?: string, canSubmit: () => boolean = () => true): Promise<FindMyRequestResult> {
      const allowed = () => { try { return canSubmit() === true; } catch { return false; } };
      if (!allowed()) return { status: 'failed', detail: 'Sharing request authorization ended before submission.' };
      if (!configured || closed) return { status: 'failed', detail: 'Native sharing request unavailable; no card was submitted.' };
      if (typeof address !== 'string' || !PHONE.test(address) || !currentSubjects().some(subject => subject.address === address)
        || !text(chatId, 500) || !/^(?:any|iMessage);[-+];.+$/.test(chatId)
        || (clientMessageId !== undefined && !text(clientMessageId, 200)))
        return { status: 'failed', detail: 'Native sharing request requires an approved subject and existing iMessage chat.' };
      let client: FindMyClient;
      try { client = await bounded(getClient(), lifecycle.signal, RPC_MS); }
      catch (error) { return { status: 'failed', detail: `Native sharing connection unavailable (${safeError(error)}); no card was submitted.` }; }
      if (closed || !allowed() || !currentSubjects().some(subject => subject.address === address))
        return { status: 'failed', detail: 'Sharing request authorization ended before submission.' };
      try {
        const receipt = await bounded(client.locations.request(chatId, address, clientMessageId ? { clientMessageId } : undefined), undefined, RPC_MS);
        if (!receipt || receipt.address !== address || !text(receipt.status, 100))
          return { status: 'unknown', detail: 'Native sharing request returned an unrecognized receipt; no automatic retry.' };
        if (/^(?:failed|error|unsupported|denied|rejected|not_sent)$/i.test(receipt.status))
          return { status: 'failed', detail: 'Photon reported the native sharing request was not accepted; no permission is assumed.' };
        const messageId = text(receipt.messageGuid, 500) ? receipt.messageGuid : undefined;
        if (!messageId && !/^(?:sent|accepted|success|requested|provider_accepted|ok)$/i.test(receipt.status))
          return { status: 'unknown', detail: 'Native sharing request returned an unrecognized operation status; no automatic retry or permission assumed.' };
        return { status: 'provider_accepted', detail: 'Photon reports the native sharing card was created or the request operation accepted; delivery and location-sharing permission remain unverified.',
          ...(messageId ? { messageId } : {}) };
      } catch (error) {
        return { status: fatal(error) ? 'failed' : 'unknown', detail: `Native sharing request ${fatal(error) ? 'rejected' : 'delivery uncertain'} (${safeError(error)}); no automatic retry or permission assumed.` };
      }
    },
    async start(getSubjects: () => FindMySubject[], onPosition?: FindMyPositionHandler): Promise<() => Promise<void>> {
      if (started || closed) throw new Error('Native Find My already started or stopped');
      started = true; subjects = getSubjects; handler = onPosition ?? handler;
      if (!configured) return stop;
      // Return cancellation promptly even while the cloud token mint is pending.
      track((async () => {
        let backoff = 1000;
        while (!closed) {
          let client: FindMyClient;
          try { client = await bounded(getClient(), lifecycle.signal, RPC_MS); }
          catch (error) {
            if (closed) break;
            detail = `Native Find My initialization unavailable (${safeError(error)}); ${fatal(error) ? 'verify native account configuration' : 'reconnecting with bounded backoff'}.`;
            if (fatal(error)) break;
            try { await delay(backoff, lifecycle.signal); } catch { break; }
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS); continue;
          }
          if (closed) { await closeClient(client); break; }
          detail = 'Native Find My watches approved subjects; only timestamped granted locations are usable.';
          reconcile(client);
          reconcileTimer = setInterval(() => reconcile(client), 1000);
          watchdog = setInterval(() => {
            for (const slot of slots.values()) if (slot.stream && Date.now() - slot.lastActivity > STALL_MS) {
              slot.cycle?.abort(); void closeStream(slot);
            }
          }, 15_000);
          break;
        }
      })());
      return stop;
    },
  };
}
