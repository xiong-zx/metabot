import { describe, expect, it, vi } from 'vitest';

const envKey = 'METABOT_CLI_FILE_ISOLATION_SENTINEL';
const globalKey = '__METABOT_CLI_FILE_ISOLATION_SENTINEL__';

describe('CLI Vitest file isolation sentinel A', () => {
  it('starts with clean process state before leaving a sentinel', () => {
    expect(process.env[envKey]).toBeUndefined();
    expect((globalThis as Record<string, unknown>)[globalKey]).toBeUndefined();

    process.env[envKey] = 'from-a';
    vi.stubGlobal(globalKey, 'from-a');
  });
});
