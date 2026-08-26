import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { SILENT_LARK_REST_LOGGER } from '../src/feishu/sdk-logger.js';

describe('Lark REST SDK log safety', () => {
  it('does not serialize raw SDK errors through console logging', async () => {
    const consoleMethods = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'trace').mockImplementation(() => undefined),
    ];
    const rawSdkError = {
      config: { headers: { authorization: 'synthetic-test-credential' } },
      request: { cookie: 'synthetic-test-cookie' },
    };

    await SILENT_LARK_REST_LOGGER.error(rawSdkError);
    await SILENT_LARK_REST_LOGGER.warn(rawSdkError);
    await SILENT_LARK_REST_LOGGER.info(rawSdkError);
    await SILENT_LARK_REST_LOGGER.debug(rawSdkError);
    await SILENT_LARK_REST_LOGGER.trace(rawSdkError);

    expect(Object.isFrozen(SILENT_LARK_REST_LOGGER)).toBe(true);
    for (const method of consoleMethods) expect(method).not.toHaveBeenCalled();
  });

  it('is wired to every upstream REST client construction site', () => {
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const docSyncSource = readFileSync(new URL('../src/sync/doc-sync.ts', import.meta.url), 'utf8');

    expect(indexSource.match(/logger: SILENT_LARK_REST_LOGGER/g)).toHaveLength(2);
    expect(docSyncSource.match(/logger: SILENT_LARK_REST_LOGGER/g)).toHaveLength(1);
  });
});
