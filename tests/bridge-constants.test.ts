import { describe, expect, it } from 'vitest';
import { formatIdleTimeoutMessage, formatTaskTimeoutMessage } from '../src/bridge/bridge-constants.js';

describe('bridge timeout messages', () => {
  it('formats per-task timeout durations instead of always using the global default', () => {
    expect(formatTaskTimeoutMessage(120_000)).toBe('Task timed out (2 minutes limit)');
    expect(formatIdleTimeoutMessage(60_000)).toBe('Task aborted: no activity for 1 minute');
  });
});
