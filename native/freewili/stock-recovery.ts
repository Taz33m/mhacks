/** Explicit transport failures only; unknown worker/config/protocol errors stay fatal. */
export class StockBridgeFailure extends Error {
  readonly atMs = performance.now();
  readonly kind: 'usb-unavailable' | 'backend-transport' | 'backend-rejected' | 'protocol'
    | 'worker-runtime' | 'worker-unexpected' | 'queue-stalled' | 'command-undelivered' | 'recovery-exhausted';
  readonly recoverable: boolean;
  constructor(kind: StockBridgeFailure['kind'], message: string, recoverable = false) {
    super(message); this.kind = kind; this.recoverable = recoverable;
  }
}
const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);
export function backendTransportFailure(error: unknown): StockBridgeFailure {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return NETWORK_ERRORS.has(code)
    ? new StockBridgeFailure('backend-transport', `WILi backend transport unavailable (${code}).`, true)
    : new StockBridgeFailure('backend-rejected', 'WILi backend connection failed without a recoverable transport code.');
}
export function backendCloseFailure(code: number): StockBridgeFailure {
  return [1000, 1001, 1006, 1011, 1012, 1013].includes(code)
    ? new StockBridgeFailure('backend-transport', `WILi backend disconnected (WebSocket ${code}).`, true)
    : new StockBridgeFailure('backend-rejected', `WILi backend rejected the session (WebSocket ${code}); verify authentication/protocol.`);
}
export function backendHttpFailure(status: number): StockBridgeFailure {
  return [502, 503, 504].includes(status)
    ? new StockBridgeFailure('backend-transport', `WILi backend temporarily unavailable (HTTP ${status}).`, true)
    : new StockBridgeFailure('backend-rejected', `WILi backend rejected the connection (HTTP ${status}); verify origin/authentication.`);
}
export function selectedPortFailure(error: unknown): StockBridgeFailure {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return ['ENOENT', 'ENODEV', 'ENXIO', 'EIO'].includes(code)
    ? new StockBridgeFailure('usb-unavailable', 'Selected WILi DISPLAY port is unavailable; acquisition is stopped.', true)
    : new StockBridgeFailure('worker-runtime', 'Selected WILi DISPLAY port cannot be accessed; verify the path and permissions.');
}
const cancelledWait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});
const exhausted = () => new StockBridgeFailure('recovery-exhausted', 'WILi foreground recovery window expired; acquisition remains unavailable.');

/** Long-running foreground supervision, explicitly opted into by the CLI.
 * An attempt must finish all child/socket cleanup before resolving or rejecting.
 * A clean completion never restarts. Signal cancellation ends active work/waits.
 */
export async function superviseStockBridge(options: {
  signal: AbortSignal;
  attempt: (signal: AbortSignal, forwardedRealSample: () => void) => Promise<void>;
  onRetry?: (info: { kind: StockBridgeFailure['kind']; attempt: number; delayMs: number; remainingMs: number }) => void;
  recoveryWindowMs?: number; baseDelayMs?: number; maxDelayMs?: number; stableMs?: number;
}): Promise<void> {
  const windowMs = options.recoveryWindowMs ?? 120_000, baseDelayMs = options.baseDelayMs ?? 500,
    maxDelayMs = options.maxDelayMs ?? 5000, stableMs = options.stableMs ?? 30_000;
  if (![windowMs, baseDelayMs, maxDelayMs, stableMs].every(n => Number.isFinite(n) && n > 0)
    || maxDelayMs < baseDelayMs || stableMs >= windowMs) throw new Error('Invalid foreground recovery timing.');
  let outageAt: number | null = null, retries = 0;
  while (!options.signal.aborted) {
    const attemptAbort = new AbortController();
    const signal = AbortSignal.any([options.signal, attemptAbort.signal]);
    let expiry: ReturnType<typeof setTimeout> | null = null, expired = false, settled = false;
    let healthyAt: number | null = null, failure: unknown;
    if (outageAt !== null) {
      const remaining = windowMs - (performance.now() - outageAt); if (remaining <= 0) throw exhausted();
      expiry = setTimeout(() => { expired = true; attemptAbort.abort(); }, remaining);
    }
    try {
      await options.attempt(signal, () => {
        if (settled || signal.aborted) return;
        healthyAt ??= performance.now();
        if (performance.now() - healthyAt >= stableMs) {
          // Repeated real frames after sustained uptime permit a new future outage budget.
          outageAt = null; retries = 0; if (expiry) { clearTimeout(expiry); expiry = null; }
        }
      });
    } catch (error) { failure = error; }
    finally { settled = true; if (expiry) clearTimeout(expiry); }
    if (options.signal.aborted) return;
    if (expired) throw exhausted();
    if (failure === undefined) return;
    if (!(failure instanceof StockBridgeFailure) || !failure.recoverable) throw failure;
    outageAt ??= failure.atMs;
    const remainingMs = windowMs - (performance.now() - outageAt); if (remainingMs <= 0) throw exhausted();
    const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(retries, 12), remainingMs);
    options.onRetry?.({ kind: failure.kind, attempt: ++retries, delayMs, remainingMs });
    try { await cancelledWait(delayMs, options.signal); }
    catch (error) { if (options.signal.aborted) return; throw error; }
  }
}
