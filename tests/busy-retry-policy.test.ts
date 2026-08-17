import { describe, expect, it } from 'vitest';
import { decideBusyRetry } from '../src/scheduler/busy-retry-policy.js';

describe('busy retry policy', () => {
  it('uses exponential delays capped at five minutes', () => {
    const first = decideBusyRetry(0, { retryCount: 0 });
    expect(first).toMatchObject({ kind: 'defer', retryCount: 1, retryDelayMs: 30_000, executeAt: 30_000 });

    const fifth = decideBusyRetry(450_000, { retryCount: 4, busySince: 0 });
    expect(fifth).toMatchObject({ kind: 'defer', retryCount: 5, retryDelayMs: 300_000, executeAt: 750_000 });
  });

  it('caps the last delay at the original 30-minute deadline', () => {
    const decision = decideBusyRetry(1_650_000, { retryCount: 8, busySince: 0 });
    expect(decision).toMatchObject({
      kind: 'defer',
      retryDelayMs: 150_000,
      remainingMs: 150_000,
      executeAt: 1_800_000,
    });
  });

  it('does not reset the deadline and reports exhaustion', () => {
    expect(decideBusyRetry(1_800_000, { retryCount: 9, busySince: 0 })).toEqual({
      kind: 'exhausted',
      busySince: 0,
    });
  });
});
