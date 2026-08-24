import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreMetaMemoryRuleReader } from '../src/metamemory-reader.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function documentResponse(): Response {
  return new Response(
    JSON.stringify({
      document: {
        path: '/imac/rules/codex',
        version: 1,
        updated_at: '2026-08-18T06:00:00.000Z',
        content: JSON.stringify({ schemaVersion: 1, revision: '1', rules: [] }),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('CoreMetaMemoryRuleReader loopback redirects', () => {
  it.each(['http://127.0.0.1:9200', 'http://127.42.7.9:9200', 'http://[::1]:9200'])(
    'reads without redirects from IPv4/IPv6 loopback %s',
    async (baseUrl) => {
      const fetchMock = vi.fn(async () => documentResponse());
      vi.stubGlobal('fetch', fetchMock);
      const result = await new CoreMetaMemoryRuleReader(baseUrl).readStructuredRules(['/imac/rules/codex']);
      expect(result.rules).toEqual([]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    },
  );

  it('follows a bounded redirect only after validating the alternate loopback URL', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      if (String(url).startsWith('http://127.0.0.1:9200/')) {
        return new Response(null, { status: 307, headers: { location: 'http://[::1]:9300/redirected' } });
      }
      return documentResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    await new CoreMetaMemoryRuleReader('http://127.0.0.1:9200').readStructuredRules(['/imac/rules/codex']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('http://[::1]:9300/redirected');
  });

  it('rejects a public redirect before making any request to that origin', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://public.example/rules' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new CoreMetaMemoryRuleReader('http://127.0.0.1:9200').readStructuredRules(['/imac/rules/codex']),
    ).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).hostname !== 'public.example')).toBe(true);
  });
});
