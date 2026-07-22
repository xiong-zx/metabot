import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

describe('CLI Vitest isolation config', () => {
  it('serializes test files that share process.env', () => {
    expect(config.test?.fileParallelism).toBe(false);
    expect(config.test?.pool).toBe('forks');
    expect(config.test?.poolOptions?.forks?.singleFork).toBe(true);
  });
});
