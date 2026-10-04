import { patientChoices } from '../patient-followup.ts';
import { setTimeout as pause } from 'node:timers/promises';
import type { ProviderInbound, ProviderResult } from '../contracts.ts';
import { phoneIdentity } from '../identity.ts';

/** Native Spectrum identities; `phone` can be the SDK's literal shared line. */
export interface PhotonChannel { id?: string; phone?: string; type?: string }
export interface PhotonSentMessage { id: string; space?: PhotonChannel }
export interface PhotonSendOptions { replyToMessageId?: string; chatId?: string; lineId?: string }

export interface PhotonMessage {
  id: string;
  platform: string;
  direction: string;
  sender?: { id: string; kind?: string; service?: unknown };
  content: unknown;
  reactionRecord?: { selected?: boolean };
  space?: PhotonChannel;
  timestamp?: Date;
  reply?(text: string): Promise<PhotonSentMessage | undefined>;
  /** Spectrum read receipt; iMessage marks the whole chat read. Best-effort. */
  read?(): Promise<void>;
}
export interface PhotonSpace extends PhotonChannel {
  send(text: string): Promise<PhotonSentMessage | undefined>;
  sendPoll?(title: string, options: string[]): Promise<PhotonSentMessage | undefined>;
  getMessage?(id: string): Promise<PhotonMessage | undefined>;
  /** Spectrum typing indicator; providers without one no-op. Best-effort. */
  startTyping?(): Promise<void>;
  stopTyping?(): Promise<void>;
}
export interface PhotonClient {
  messages: AsyncIterable<readonly [unknown, PhotonMessage]>;
  openDm(phone: string): Promise<PhotonSpace | undefined>;
  openSpace?(chatId: string, lineId: string): Promise<PhotonSpace | undefined>;
  stop(): Promise<void>;
}
export type PhotonFactory = (projectId: string, projectSecret: string) => Promise<PhotonClient>;

export const createCloudPhoton: PhotonFactory = async (projectId, projectSecret) => {
  const [{ Spectrum, poll }, { imessage }] = await Promise.all([
    import('@spectrum-ts/core'), import('@spectrum-ts/imessage'),
  ]);
  const app = await Spectrum({
    projectId, projectSecret, providers: [imessage.config()],
    telemetry: false, options: { logLevel: 'error' },
  });
  const im = imessage(app);
  const decorate = (space: Awaited<ReturnType<typeof im.space.create>>) => space ? Object.assign(space, {
    sendPoll: async (title: string, options: string[]) => {
      const question = await space.send(`${title}\nTap a choice, or reply with its number. WILi voice works too.`);
      if (!question) throw new Error('Patient poll question delivery unknown');
      return space.send(poll(title, options));
    },
  }) : undefined;
  return {
    messages: app.messages,
    openDm: async (phone) => decorate(await im.space.create(await im.user(phone))),
    openSpace: async (chatId, lineId) => decorate(await im.space.get(chatId, { phone: lineId })),
    stop: () => app.stop(),
  };
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
const sdkErrorNames = new Set(['IMessageError', 'AuthenticationError', 'NotFoundError', 'RateLimitError', 'ValidationError', 'ConnectionError']);
// Fixed public codes from the installed SDK; diagnostics must not eagerly load it.
// Unknown future codes are intentionally omitted until reviewed.
const sdkErrorCodes = new Set([
  'unauthenticated', 'tokenExpired', 'tokenBlocked', 'unauthorized',
  'dailyLimitExceeded', 'recipientLimitExceeded', 'uploadRateExceeded', 'contentDuplicateExceeded',
  'recipientCoolingDown', 'recipientLocked', 'burstRateExceeded', 'newContactThrottled',
  'sendReceiveRatioExceeded', 'duplicateMessage', 'chatNotFound', 'messageNotFound',
  'attachmentNotFound', 'addressNotFound', 'sharedFriendLocationNotFound', 'groupIconNotFound',
  'pollNotFound', 'invalidArgument', 'preconditionFailed', 'operationNotSupported',
  'attachmentNotReady', 'privateApiUnavailable', 'serviceUnavailable', 'timeout',
  'internalError', 'databaseError', 'networkError',
]);
const sdkErrorSources = new Set(['upstream', 'spectrum-imessage', 'middleware', 'intermediary']);
const grpcStatuses = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
/** Never expose arbitrary SDK messages, payloads, context, addresses or request IDs. */
function safeErrorDetail(error: unknown, method: 'space.prepare' | 'space.send' | 'message.reply'): string {
  const e = object(error), facts: string[] = [];
  if (typeof e?.name === 'string' && sdkErrorNames.has(e.name)) facts.push(e.name);
  if (typeof e?.code === 'string' && sdkErrorCodes.has(e.code)) facts.push(e.code);
  if (typeof e?.grpcCode === 'number' && Number.isInteger(e.grpcCode) && e.grpcCode >= 0 && e.grpcCode < grpcStatuses.length)
    facts.push(`gRPC ${e.grpcCode} ${grpcStatuses[e.grpcCode]}`);
  if (typeof e?.source === 'string' && sdkErrorSources.has(e.source)) facts.push(`source ${e.source}`);
  if (typeof e?.retryable === 'boolean') facts.push(`SDK retryable=${e.retryable}`);
  if (error instanceof Error && error.message === 'provider timeout') facts.push('adapter deadline exceeded');
  // This is a fixed service explanation, never a copy of surrounding raw text.
  if (typeof e?.message === 'string' && /Target not allowed for this project/.test(e.message))
    facts.push('Target not allowed for this project; verify registered Photon project Users');
  return ` [${method}${facts.length ? ': ' + facts.join('; ') : ': no safe SDK error metadata'}]`;
}
function resourceLimitReported(error: unknown): boolean {
  const e = object(error);
  // The SDK maps RESOURCE_EXHAUSTED to RateLimitError. This identifies a
  // reported limit, not whether a message reached Apple before the error.
  return e?.name === 'RateLimitError' || e?.grpcCode === 8;
}
function contactWarmupCounters(error: unknown): { sent: number; required: number; replies: number } | null {
  const e = object(error);
  if (!resourceLimitReported(error) || typeof e?.message !== 'string') return null;
  // This exact observed SDK explanation is parsed only into bounded counters.
  // Never copy surrounding service text, identifiers or arbitrary raw errors.
  const match = e.message.match(/^\[upstream\] New contact has sent (\d{1,3}) of (\d{1,3}) messages; replies are limited to (\d{1,5}) until they respond$/);
  if (!match) return null;
  const [sent, required, replies] = match.slice(1).map(Number);
  return required > 0 && replies > 0 ? { sent, required, replies } : null;
}
function targetId(content: Record<string, unknown>): string | undefined {
  const id = object(content.target)?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
function channel(space?: PhotonChannel): { chatId?: string; lineId?: string } {
  return {
    ...(typeof space?.id === 'string' && space.id ? { chatId: space.id } : {}),
    ...(typeof space?.phone === 'string' && space.phone ? { lineId: space.phone } : {}),
  };
}
function nativeService(value: unknown): ProviderInbound['service'] {
  return value === 'iMessage' || value === 'SMS' || value === 'RCS' || value === 'unknown' ? value : undefined;
}

/** Preserve provider identities and targets; authorization belongs to the controller. */
export function normalizePhoton(message: PhotonMessage): ProviderInbound | null {
  if (message.platform !== 'imessage' || message.direction !== 'inbound' ||
      !message.id || !message.sender?.id || message.sender.kind === 'agent') return null;
  const content = object(message.content);
  if (!content) return null;
  const at = message.timestamp instanceof Date ? message.timestamp.getTime() : NaN;
  const service = nativeService(message.sender.service);
  const base = { messageId: message.id, sender: message.sender.id, ...channel(message.space),
    ...(Number.isFinite(at) ? { providerTimestamp: at } : {}),
    ...(service ? { service } : {}),
  };
  if (content.type === 'poll_option' && content.selected === true) {
    const question = object(content.poll)?.title, title = object(content.option)?.title;
    if (typeof question === 'string' && typeof title === 'string' && question.length <= 200 && title.length <= 100)
      return { ...base, kind: 'text', text: title, pollQuestion: question,
        pollOptions: (object(content.poll)?.options as {title:string}[] | undefined)?.map(o=>o.title) };
    return null;
  }
  if (content.type === 'text' && typeof content.text === 'string') {
    return { ...base, kind: 'text', text: content.text };
  }
  if (content.type === 'reply') {
    const inner = object(content.content);
    const targetMessageId = targetId(content);
    if (inner?.type === 'text' && typeof inner.text === 'string' && targetMessageId) {
      return { ...base, kind: 'text', text: inner.text, targetMessageId };
    }
  }
  // Any skin tone of thumbs-up counts as the same 👍 reaction.
  if (content.type === 'reaction' && typeof content.emoji === 'string' && content.emoji.startsWith('👍')) {
    const targetMessageId = targetId(content);
    if (targetMessageId) return {
      ...base, kind: 'reaction', reaction: '👍', targetMessageId,
      removed: message.reactionRecord?.selected === false,
    };
  }
  // The generic content model can represent reaction retractions. Cloud v12.10.1
  // does not reliably emit them; never infer removal from silence or a new like.
  if (content.type === 'unsend') {
    const reaction = object(object(content.target)?.content);
    if (reaction?.type === 'reaction' && typeof reaction.emoji === 'string' && reaction.emoji.startsWith('👍')) {
      const targetMessageId = targetId(reaction);
      if (targetMessageId) return {
        ...base, kind: 'reaction', reaction: '👍', targetMessageId, removed: true,
      };
    }
  }
  return null;
}

export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('provider timeout')), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

class ListenerStopped extends Error {}
class ListenerEnded extends Error {}

/** Abort waits without retaining a timer or dispatching a late iterator result. */
async function listenerWait<T>(promise: Promise<T>, signal: AbortSignal, ms?: number): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw new ListenerStopped(); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new ListenerStopped());
        signal.addEventListener('abort', abort, { once: true });
        if (ms !== undefined) timer = setTimeout(() => reject(new Error('provider timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function listenerDelay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await listenerWait(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal);
  } finally { if (timer) clearTimeout(timer); }
}

export function createPhotonAdapter(options: {
  projectId?: string; projectSecret?: string; factory?: PhotonFactory; timeoutMs?: number;
  listenerRetryBaseMs?: number; listenerRetryMaxMs?: number;
  /** Read receipt + typing shown before conversational replies; 0 disables both. */
  typingMs?: number;
}) {
  const configured = Boolean(options.projectId?.trim() && options.projectSecret?.trim());
  const timeoutMs = options.timeoutMs ?? 15_000;
  const typingSetting = options.typingMs ?? Number(process.env.LIFELINE_PHOTON_TYPING_MS ?? 900);
  const typingMs = Number.isFinite(typingSetting) ? Math.max(0, Math.min(3_000, typingSetting)) : 900;
  let detail = configured ? 'Cloud credentials configured; outbound sends not yet verified' : 'Unconfigured: set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET';
  let clientPromise: Promise<PhotonClient> | undefined;
  let listening = false;
  let shutdown = false;
  let listenerDetail: string | null = null;
  let retiring: Promise<void> | undefined;
  const stoppedClients = new WeakMap<PhotonClient, Promise<void>>();
  const returnedIterators = new WeakMap<object, Promise<unknown>>();
  const retryBaseMs = Math.max(1, Math.min(30_000, Number.isFinite(options.listenerRetryBaseMs) ? options.listenerRetryBaseMs! : 1000));
  const retryMaxMs = Math.max(retryBaseMs, Math.min(60_000, Number.isFinite(options.listenerRetryMaxMs) ? options.listenerRetryMaxMs! : 30_000));
  const stopClient = (client: PhotonClient): Promise<void> => {
    let stopping = stoppedClients.get(client);
    if (!stopping) {
      stopping = Promise.resolve().then(() => client.stop());
      stoppedClients.set(client, stopping);
      void stopping.catch(() => {});
    }
    return stopping;
  };
  const getClient = (): Promise<PhotonClient> => {
    if (shutdown) return Promise.reject(new ListenerStopped());
    if (retiring) return retiring.then(() => getClient());
    if (!clientPromise) {
      const pending = Promise.resolve().then(() => {
        if (shutdown) throw new ListenerStopped();
        return (options.factory ?? createCloudPhoton)(options.projectId!, options.projectSecret!);
      });
      clientPromise = pending;
      void pending.then(client => {
        // Spectrum initialization has no cancellation contract. A late client
        // still belongs to this stopped adapter and must never acquire a listener.
        if (shutdown) void stopClient(client);
      }, () => { if (clientPromise === pending) clientPromise = undefined; });
    }
    return clientPromise;
  };
  return {
    status: () => ({ configured, detail: listenerDetail ? `${listenerDetail}; ${detail}` : detail }),
    async sendMessage(phone: string, text: string, canSubmit?: () => boolean, transport?: PhotonSendOptions): Promise<ProviderResult> {
      if (!configured) return { status: 'failed', detail };
      if (shutdown) return { status: 'failed', detail: 'Photon adapter stopped; no message sent' };
      if (!/^\+[1-9]\d{7,14}$/.test(phone) || !text.trim() || text.length > 6_000) {
        return { status: 'failed', detail: 'Invalid recipient or message; no send attempted' };
      }
      const bound = transport?.replyToMessageId !== undefined || transport?.chatId !== undefined || transport?.lineId !== undefined;
      if (bound && (!transport?.chatId || !transport.lineId
        || !/^any;-;.+$/.test(transport.chatId)
        || phoneIdentity(transport.chatId.slice('any;-;'.length)) !== phoneIdentity(phone)
        || !transport.lineId.trim() || transport.lineId !== transport.lineId.trim()
        || (transport.replyToMessageId !== undefined && !transport.replyToMessageId.trim()))) {
        return { status: 'failed', detail: 'Invalid or incomplete bound DM/reply identities; no send attempted' };
      }
      let space: PhotonSpace | undefined;
      let replyTarget: PhotonMessage | undefined;
      try {
        const client = await withDeadline(getClient(), timeoutMs);
        if (bound) {
          if (!client.openSpace) throw new Error('bound conversation lookup unavailable');
          space = await withDeadline(client.openSpace(transport!.chatId!, transport!.lineId!), timeoutMs);
          if (!space || space.id !== transport!.chatId || space.phone !== transport!.lineId || space.type === 'group')
            throw new Error('conversation identity mismatch');
          if (transport!.replyToMessageId !== undefined) {
            if (!space.getMessage) throw new Error('target lookup unavailable');
            replyTarget = await withDeadline(space.getMessage(transport!.replyToMessageId), timeoutMs);
            // The original normalized inbound event supplies trusted persisted
            // chat/line provenance. On cache misses Spectrum rebuilds the target
            // using that chat hint; reject every contradictory returned identity.
            if (!replyTarget || replyTarget.id !== transport!.replyToMessageId
              || replyTarget.platform !== 'imessage' || replyTarget.direction !== 'inbound'
              || replyTarget.sender?.kind === 'agent'
              || !replyTarget.sender?.id || phoneIdentity(replyTarget.sender.id) !== phoneIdentity(phone)
              || !replyTarget.space || replyTarget.space.id !== transport!.chatId || replyTarget.space.phone !== transport!.lineId
              || replyTarget.space.type === 'group' || !replyTarget.reply)
              throw new Error('reply target identity mismatch');
          }
        } else space = await withDeadline(client.openDm(phone), timeoutMs);
        if (!space) throw new Error('no DM');
      } catch (error) {
        detail = bound ? 'Photon bound conversation/reply target unavailable or mismatched; no send attempted'
          : 'Photon connection/DM unavailable before message send';
        detail += safeErrorDetail(error, 'space.prepare');
        return { status: 'failed', detail };
      }
      if (shutdown || (canSubmit && !canSubmit())) {
        return { status: 'cancelled', detail: 'Incident authorization ended before submission; no message sent.' };
      }
      // Conversational replies only (alerts and check-ins never wait): mark the
      // person's message read, show typing briefly, then answer. Best-effort; a
      // presence failure never blocks the send, and authorization is rechecked.
      const typingSpace = space;
      let typing = false;
      const stopTyping = () => { if (typing) void Promise.resolve().then(() => typingSpace.stopTyping?.()).catch(() => {}); };
      if (replyTarget && typingMs > 0 && typingSpace.startTyping) {
        const target = replyTarget;
        void Promise.resolve().then(() => target.read?.()).catch(() => {});
        typing = await withDeadline(Promise.resolve().then(() => typingSpace.startTyping!()), Math.min(timeoutMs, 1_500))
          .then(() => true, () => false);
        if (typing) await pause(typingMs);
        if (shutdown || (canSubmit && !canSubmit())) {
          stopTyping();
          return { status: 'cancelled', detail: 'Incident authorization ended before submission; no message sent.' };
        }
      }
      try {
        const choices = patientChoices(text);
        const sent = await withDeadline(choices && space.sendPoll
          ? space.sendPoll(choices.title, choices.options)
          : replyTarget ? replyTarget.reply!(text) : space.send(text), timeoutMs);
        stopTyping();
        if (!sent?.id) {
          detail = 'Send returned no message ID; delivery outcome unknown';
          return { status: 'unknown', detail };
        }
        const identities = { ...channel(space), ...channel(sent.space) };
        if (bound && (identities.chatId !== transport!.chatId || identities.lineId !== transport!.lineId)) {
          detail = 'Submitted message returned different conversation identities; outcome unknown, reconcile before retry';
          return { status: 'unknown', messageId: sent.id, ...identities, detail };
        }
        detail = 'Cloud accepted a message; recipient delivery is not established';
        return { status: 'provider_accepted', messageId: sent.id, ...identities, detail };
      } catch (error) {
        stopTyping();
        const warmup = contactWarmupCounters(error);
        detail = warmup
          ? `Photon reported a contact warm-up restriction after submission; outcome unknown. Contact messages ${warmup.sent}/${warmup.required}; reply allowance ${warmup.replies}. A new inbound reply is required; reconcile this attempt before retry`
          : resourceLimitReported(error)
          ? 'Photon reported a rate/resource limit after submission; outcome unknown. Pace new messages and reconcile this attempt before retry'
          : 'Send failed or timed out after submission; outcome unknown, reconcile before retry';
        detail += safeErrorDetail(error, replyTarget ? 'message.reply' : 'space.send');
        return { status: 'unknown', detail };
      }
    },
    async startPhotonListener(handler: (event: ProviderInbound) => Promise<void>): Promise<() => Promise<void>> {
      if (!configured) return async () => {};
      if (shutdown) throw new Error('Photon adapter has stopped');
      if (listening) throw new Error('Photon listener already running');
      listening = true;
      const abort = new AbortController();
      const seen = new Set<string>();
      let currentClient: PhotonClient | undefined;
      let currentConnection: Promise<PhotonClient> | undefined;
      let currentIterator: AsyncIterator<readonly [unknown, PhotonMessage]> | undefined;
      let stopPromise: Promise<void> | undefined;
      const closeCurrent = async (): Promise<boolean> => {
        const client = currentClient, iterator = currentIterator;
        if (!client) return true;
        if (clientPromise === currentConnection) clientPromise = undefined;
        const closing = stopClient(client);
        // Prevent outbound lanes or the recovery loop from constructing another
        // SDK client while this one's shutdown is incomplete.
        retiring = closing;
        void closing.then(() => { if (retiring === closing) retiring = undefined; }, () => {});
        let returned = iterator ? returnedIterators.get(iterator) : undefined;
        if (iterator?.return && !returned) {
          returned = Promise.resolve().then(() => iterator.return!());
          returnedIterators.set(iterator, returned);
        }
        const cleanup = Promise.all([closing, returned]);
        try { await withDeadline(cleanup, timeoutMs); return true; }
        catch { return false; }
      };
      const consume = (async () => {
        let failures = 0;
        try {
          while (!abort.signal.aborted) {
            let subscribed = false;
            let reason = 'Photon listener connection unavailable';
            try {
              listenerDetail = retiring ? 'Photon listener waiting for previous SDK client cleanup' : 'Photon listener connecting';
              currentConnection = getClient();
              currentClient = await listenerWait(currentConnection, abort.signal, timeoutMs);
              if (abort.signal.aborted) break;
              currentIterator = currentClient.messages[Symbol.asyncIterator]();
              subscribed = true;
              listenerDetail = 'Cloud listener subscribed; actual inbound text/reaction receipt still needs verification';
              while (!abort.signal.aborted) {
                const iterator = currentIterator;
                const next = await listenerWait(Promise.resolve().then(() => {
                  if (abort.signal.aborted) throw new ListenerStopped();
                  return iterator.next();
                }), abort.signal);
                if (abort.signal.aborted) break;
                if (next.done) throw new ListenerEnded();
                if (object(next.value[1].content)?.type === 'poll_option') console.info('Patient poll event', JSON.stringify({platform:next.value[1].platform,direction:next.value[1].direction,kind:next.value[1].sender?.kind,selected:object(next.value[1].content)?.selected,title:object(object(next.value[1].content)?.poll)?.title}));
                const event = normalizePhoton(next.value[1]);
                if (!event) continue;
                failures = 0;
                if (seen.has(event.messageId)) continue;
                // Read receipt on arrival (texts only); best-effort, never awaited.
                if (typingMs > 0 && event.kind === 'text') {
                  const received = next.value[1];
                  void Promise.resolve().then(() => received.read?.()).catch(() => {});
                }
                try {
                  await listenerWait(Promise.resolve().then(() => {
                    if (abort.signal.aborted) throw new ListenerStopped();
                    return handler(event);
                  }), abort.signal);
                  if (abort.signal.aborted) break;
                  seen.add(event.messageId);
                  if (seen.size > 4096) seen.delete(seen.values().next().value!);
                  listenerDetail = 'Cloud listener received an inbound event; incident authorization remains controller-owned';
                } catch {
                  if (abort.signal.aborted) break;
                  listenerDetail = 'Cloud listener subscribed; inbound handler failed and event was not acknowledged';
                }
              }
            } catch (error) {
              if (abort.signal.aborted) break;
              reason = retiring ? 'Photon listener recovery waits for previous SDK cleanup' : error instanceof ListenerEnded ? 'Photon listener iterator ended unexpectedly' : subscribed ? 'Photon listener iterator failed' : reason;
            } finally {
              const clean = await closeCurrent();
              currentClient = undefined; currentIterator = undefined; currentConnection = undefined;
              if (!clean && !abort.signal.aborted) reason = 'Photon listener unavailable; previous SDK cleanup incomplete';
            }
            if (abort.signal.aborted) break;
            const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(failures++, 20));
            listenerDetail = `${reason}; retrying in ${delay} ms`;
            await listenerDelay(delay, abort.signal);
          }
        } catch {
          if (!abort.signal.aborted) listenerDetail = 'Photon listener recovery unavailable; incident remains unresolved';
        } finally { listening = false; }
      })();
      // Return the stop handle before connection succeeds, including during
      // initial failures, so server shutdown can cancel every recovery wait.
      return () => {
        if (stopPromise) return stopPromise;
        const connectionToClose = clientPromise ?? currentConnection;
        const retirementToAwait = retiring;
        shutdown = true;
        abort.abort();
        listenerDetail = 'Cloud listener stopping';
        stopPromise = (async () => {
          // A promise may have resolved just before abort without being assigned
          // to currentClient. Attach cleanup to it too; the WeakMap stops once.
          const pendingCleanup = connectionToClose?.then(client => stopClient(client), () => {});
          const clean = await withDeadline(Promise.all([closeCurrent(), pendingCleanup, retirementToAwait]).then(([closed]) => closed), timeoutMs).catch(() => false);
          const finished = await withDeadline(consume.then(() => true), timeoutMs).catch(() => false);
          clientPromise = undefined;
          listenerDetail = clean && finished ? 'Cloud listener stopped' : 'Cloud listener stopped dispatch/recovery; SDK cleanup incomplete';
        })();
        return stopPromise;
      };
    },
  };
}
