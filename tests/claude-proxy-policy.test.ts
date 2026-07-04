import { afterEach, describe, expect, it } from 'vitest';
import { applyProxyPolicy } from '../src/engines/claude/executor.js';

const ORIGINAL_DISABLE = process.env.METABOT_PROXY_NORMALIZE_DISABLE;

afterEach(() => {
  if (ORIGINAL_DISABLE === undefined) {
    delete process.env.METABOT_PROXY_NORMALIZE_DISABLE;
  } else {
    process.env.METABOT_PROXY_NORMALIZE_DISABLE = ORIGINAL_DISABLE;
  }
});

describe('applyProxyPolicy', () => {
  it('mirrors uppercase proxy values over stale lowercase values', () => {
    const env: Record<string, string> = {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://stale-proxy:8080',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://stale-proxy:8080',
    };

    applyProxyPolicy(env);

    expect(env.http_proxy).toBe('http://127.0.0.1:7890');
    expect(env.https_proxy).toBe('http://127.0.0.1:7890');
  });

  it('backfills uppercase values when only lowercase values are present', () => {
    const env: Record<string, string> = {
      http_proxy: 'http://proxy:8080',
      https_proxy: 'http://secure-proxy:8080',
    };

    applyProxyPolicy(env);

    expect(env.HTTP_PROXY).toBe('http://proxy:8080');
    expect(env.HTTPS_PROXY).toBe('http://secure-proxy:8080');
  });

  it('can be disabled for hosts that intentionally split proxy variables', () => {
    process.env.METABOT_PROXY_NORMALIZE_DISABLE = 'true';
    const env: Record<string, string> = {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://different-proxy:8080',
    };

    applyProxyPolicy(env);

    expect(env.http_proxy).toBe('http://different-proxy:8080');
  });
});
