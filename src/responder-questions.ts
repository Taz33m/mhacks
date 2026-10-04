import type { Incident, ProviderInbound } from './contracts.ts';
import { Controller, PolicyError } from './controller.ts';
import type { ResponderQuestionPreparation } from './controller.ts';

export type ResponderAnswerGenerator = (
  incident: Incident, question: string, context?: { signal: AbortSignal },
) => Promise<string | { text: string; generation: 'ai' | 'degraded' | 'policy_refusal' }>;

/** Synchronous durable receipt; the listener need not wait for inference. */
export function enqueueResponderQuestion(event: ProviderInbound, controller: Controller): boolean {
  return controller.enqueueResponderQuestion(event);
}

async function prepare(
  job: ResponderQuestionPreparation, controller: Controller, generate: ResponderAnswerGenerator,
  canQueue: () => boolean, abort: AbortController, timeoutMs: number, propagateErrors: boolean,
  isStopped: () => boolean = () => false,
): Promise<boolean> {
  let generated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Question preparation interrupted.'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => abort.abort('timeout'), timeoutMs);
    });
    // Calling the generator here preserves the existing handler's immediate start.
    const answer = await Promise.race([generate(job.incident, job.question, { signal: abort.signal }), interrupted]);
    // A legacy caller may already have closed SQLite when its shutdown guard turns false.
    // Leave the durable claim for startup recovery rather than touching that database.
    if (!canQueue()) return false;
    if (abort.signal.aborted) return false;
    const answerText = typeof answer === 'string' ? answer : answer?.text;
    if (typeof answerText !== 'string' || !answerText.trim()
      || (typeof answer !== 'string' && !['ai', 'degraded', 'policy_refusal'].includes(answer.generation)))
      throw new Error('Question generator returned no valid answer.');
    generated = true;
    const text = `${job.incidentId}: ${answerText}`;
    const boundedText = text.length <= 6000 ? text
      : `${job.incidentId}: The returned record summary exceeds the message limit. Please ask about a specific medication, condition, or allergy.`;
    return controller.finishResponderQuestion(job.inboundId, job.claimId!, boundedText,
      text.length > 6000 ? 'degraded' : typeof answer === 'string' ? undefined : answer.generation);
  } catch (error) {
    // stop() has already released the claim and the caller may now close SQLite.
    if (isStopped()) return false;
    if (!canQueue()) return false;
    controller.releaseResponderQuestion(job.inboundId, job.claimId!, error instanceof PolicyError ? 'stale' : 'retry',
      generated && propagateErrors ? 0 : 5000);
    if (error instanceof PolicyError || !propagateErrors) return false;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) abort.signal.removeEventListener('abort', onAbort);
  }
}

/** One bounded preparation per tick. An interrupted generation cannot commit after stop(). */
export function createResponderQuestionWorker(
  controller: Controller, generate: ResponderAnswerGenerator,
  options: { canQueue?: () => boolean; timeoutMs?: number } = {},
): { tick(): Promise<boolean>; stop(): void } {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('Question preparation timeout must be between 1 and 60000 ms.');
  let stopped = false, busy = false;
  let current: { job: ResponderQuestionPreparation; abort: AbortController } | null = null;
  const canQueue = () => !stopped && (options.canQueue?.() ?? true);
  return {
    async tick() {
      if (busy || !canQueue()) return false;
      busy = true;
      try {
        const job = controller.claimResponderQuestion(); if (!job) return false;
        const abort = new AbortController(); current = { job, abort };
        return await prepare(job, controller, generate, canQueue, abort, timeoutMs, false, () => stopped);
      } finally { current = null; busy = false; }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (current) {
        const { job, abort } = current;
        try { controller.releaseResponderQuestion(job.inboundId, job.claimId!, 'stopped'); }
        finally { abort.abort('stopped'); }
      }
    },
  };
}

/** Compatible awaitable entry point for existing callers and isolated tests. */
export async function handleResponderQuestion(
  event: ProviderInbound, controller: Controller, generate: ResponderAnswerGenerator,
  canQueue: () => boolean = () => true,
): Promise<boolean> {
  if (!canQueue() || typeof event.messageId !== 'string' || !event.messageId.trim() || event.messageId.length > 500) return false;
  const queued = enqueueResponderQuestion(event, controller);
  if (!queued) {
    const existing = controller.responderQuestion(event.messageId);
    // Explicit redelivery can recover a failed commit; it cannot replace the original question or channel.
    if (!existing || existing.status !== 'queued' || existing.question !== event.text?.trim()
      || existing.event.sender !== event.sender || existing.event.kind !== event.kind || event.removed
      || existing.event.chatId !== event.chatId || existing.event.lineId !== event.lineId
      || existing.event.targetMessageId !== event.targetMessageId) return false;
  }
  const job = controller.claimResponderQuestion(event.messageId); if (!job) return false;
  return prepare(job, controller, generate, canQueue, new AbortController(), 15_000, true);
}
