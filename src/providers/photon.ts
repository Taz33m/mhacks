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

export function createPhotonAdapter(options: {
  projectId?: string; projectSecret?: string; factory?: PhotonFactory; timeoutMs?: number;
}) {
  const configured = Boolean(options.projectId?.trim() && options.projectSecret?.trim());
  const timeoutMs = options.timeoutMs ?? 15_000;
  let detail = configured ? 'Cloud credentials configured; connection not yet verified' : 'Unconfigured: set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET';
  let clientPromise: Promise<PhotonClient> | undefined;
  let listening = false;
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = (options.factory ?? createCloudPhoton)(options.projectId!, options.projectSecret!)
        .catch((error: unknown) => { clientPromise = undefined; throw error; });
    }
    return clientPromise;
  };
  return {
    status: () => ({ configured, detail }),
    async sendMessage(phone: string, text: string): Promise<ProviderResult> {
      if (!configured) return { status: 'failed', detail };
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
      if (listening) throw new Error('Photon listener already running');
      let client: PhotonClient;
      try { client = await withDeadline(getClient(), timeoutMs); }
      catch { detail = 'Photon listener connection unavailable'; throw new Error(detail); }
      listening = true;
      detail = 'Cloud listener started; verify actual inbound text and reaction on the demo phones';
      let stopped = false;
      const consume = (async () => {
        try {
          for await (const [, message] of client.messages) {
            if (stopped) break;
            const event = normalizePhoton(message);
            if (!event) continue;
            try { await handler(event); }
            catch { detail = 'Inbound handler failed; event was not acknowledged by LIFELINE'; }
          }
          if (!stopped) detail = 'Photon listener ended; inbound messages unavailable';
        } catch { if (!stopped) detail = 'Photon listener failed; inbound messages unavailable'; }
        finally { listening = false; }
      })();
      return async () => {
        if (stopped) return;
        stopped = true;
        await client.stop();
        await consume;
        clientPromise = undefined;
        listening = false;
        detail = 'Cloud listener stopped';
      };
    },
  };
}
