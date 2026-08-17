const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_WINDOW_MS = 30 * 60_000;

export interface BusyRetryState {
  retryCount: number;
  busySince?: number;
}

export type BusyRetryDecision =
  | {
      kind: 'defer';
      busySince: number;
      retryCount: number;
      retryDelayMs: number;
      remainingMs: number;
      executeAt: number;
    }
  | {
      kind: 'exhausted';
      busySince: number;
    };

export interface BusyRetryPolicyOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  windowMs?: number;
}

export function decideBusyRetry(
  now: number,
  state: BusyRetryState,
  options: BusyRetryPolicyOptions = {},
): BusyRetryDecision {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const busySince = state.busySince ?? now;
  const remainingMs = busySince + windowMs - now;
  if (remainingMs <= 0) return { kind: 'exhausted', busySince };

  const exponentialDelay = initialDelayMs * 2 ** Math.min(state.retryCount, 10);
  const retryDelayMs = Math.min(exponentialDelay, maxDelayMs, remainingMs);
  return {
    kind: 'defer',
    busySince,
    retryCount: state.retryCount + 1,
    retryDelayMs,
    remainingMs,
    executeAt: now + retryDelayMs,
  };
}
