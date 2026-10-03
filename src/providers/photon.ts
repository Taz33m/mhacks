import type { ProviderInbound, ProviderResult } from '../contracts.ts';

export interface PhotonMessage {
  id: string;
  platform: string;
  direction: string;
  sender?: { id: string; kind?: string };
  content: unknown;
  reactionRecord?: { selected?: boolean };
}
export interface PhotonSpace { send(text: string): Promise<{ id: string } | undefined> }
export interface PhotonClient {
  messages: AsyncIterable<readonly [unknown, PhotonMessage]>;
  openDm(phone: string): Promise<PhotonSpace | undefined>;
  stop(): Promise<void>;
}
export type PhotonFactory = (projectId: string, projectSecret: string) => Promise<PhotonClient>;

export const createCloudPhoton: PhotonFactory = async (projectId, projectSecret) => {
  const [{ Spectrum }, { imessage }] = await Promise.all([
    import('@spectrum-ts/core'), import('@spectrum-ts/imessage'),
  ]);
  const app = await Spectrum({
    projectId, projectSecret, providers: [imessage.config()],
    telemetry: false, options: { logLevel: 'error' },
  });
  const im = imessage(app);
  return {
    messages: app.messages,
    openDm: async (phone) => im.space.create(await im.user(phone)),
    stop: () => app.stop(),
  };
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
function targetId(content: Record<string, unknown>): string | undefined {
  const id = object(content.target)?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Preserve provider identities and targets; authorization belongs to the controller. */
export function normalizePhoton(message: PhotonMessage): ProviderInbound | null {
  if (message.platform !== 'imessage' || message.direction !== 'inbound' ||
      !message.id || !message.sender?.id || message.sender.kind === 'agent') return null;
  const content = object(message.content);
  if (!content) return null;
  const base = { messageId: message.id, sender: message.sender.id };
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
  if (content.type === 'reaction' && content.emoji === '👍') {
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
    if (reaction?.type === 'reaction' && reaction.emoji === '👍') {
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
}) {
  const configured = Boolean(options.projectId?.trim() && options.projectSecret?.trim());
  const timeoutMs = options.timeoutMs ?? 15_000;
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
    async sendMessage(phone: string, text: string, canSubmit?: () => boolean): Promise<ProviderResult> {
      if (!configured) return { status: 'failed', detail };
      if (shutdown) return { status: 'failed', detail: 'Photon adapter stopped; no message sent' };
      if (!/^\+[1-9]\d{7,14}$/.test(phone) || !text.trim() || text.length > 6_000) {
        return { status: 'failed', detail: 'Invalid recipient or message; no send attempted' };
      }
      let space: PhotonSpace | undefined;
      try {
        const client = await withDeadline(getClient(), timeoutMs);
        space = await withDeadline(client.openDm(phone), timeoutMs);
        if (!space) throw new Error('no DM');
      } catch {
        detail = 'Photon connection/DM unavailable before message send';
        return { status: 'failed', detail };
      }
      if (shutdown || (canSubmit && !canSubmit())) {
        return { status: 'cancelled', detail: 'Incident authorization ended before submission; no message sent.' };
      }
      try {
        const sent = await withDeadline(space.send(text), timeoutMs);
        if (!sent?.id) {
          detail = 'Send returned no message ID; delivery outcome unknown';
          return { status: 'unknown', detail };
        }
        detail = 'Cloud accepted a message; recipient delivery is not established';
        return { status: 'provider_accepted', messageId: sent.id, detail };
      } catch {
        detail = 'Send failed or timed out after submission; outcome unknown, reconcile before retry';
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
                const event = normalizePhoton(next.value[1]);
                if (!event) continue;
                failures = 0;
                if (seen.has(event.messageId)) continue;
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
