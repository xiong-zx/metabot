import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

describe('CLI Vitest isolation config', () => {
  it('serializes files while preserving per-file fork isolation', () => {
    expect(config.test?.fileParallelism).toBe(false);
    expect(config.test?.pool).toBe('forks');
    expect(config.test?.poolOptions?.forks?.isolate).toBe(true);
    expect(config.test?.poolOptions?.forks?.singleFork).not.toBe(true);
  });
});
