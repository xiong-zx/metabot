import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, DEFAULT_URL } from '../src/config.js';
import { request } from '../src/client.js';
import { parseArgs, resolveContentTypeFlag } from '../src/commands.js';

describe('parseArgs', () => {
  it('splits positional and flags', () => {
    const a = parseArgs(['hello', '--folder', 'f1', '--tags', 'a,b', 'world']);
    expect(a.positional).toEqual(['hello', 'world']);
    expect(a.flags).toEqual({ folder: 'f1', tags: 'a,b' });
  });
  it('handles --flag=value', () => {
    const a = parseArgs(['--limit=50', 'q']);
    expect(a.flags.limit).toBe('50');
    expect(a.positional).toEqual(['q']);
  });
  it('handles boolean flag at end', () => {
    const a = parseArgs(['x', '--dry']);
    expect(a.flags.dry).toBe(true);
  });
});

describe('loadConfig', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('uses env vars when set', () => {
    const cfg = loadConfig({ METABOT_CORE_URL: 'http://example/', METABOT_CORE_TOKEN: 'tok1' });
    expect(cfg.url).toBe('http://example');
    expect(cfg.token).toBe('tok1');
  });

  it('defaults URL and reads token from ~/.metabot-core/token', () => {
    fs.mkdirSync(path.join(tmpHome, '.metabot-core'));
    fs.writeFileSync(path.join(tmpHome, '.metabot-core', 'token'), 'file-tok\n');
    const cfg = loadConfig({});
    expect(cfg.url).toBe(DEFAULT_URL);
    expect(cfg.token).toBe('file-tok');
  });

  it('throws when no token configured', () => {
    expect(() => loadConfig({})).toThrow(/no token configured/);
  });
});

describe('resolveContentTypeFlag', () => {
  it('returns undefined when neither flag is set', () => {
    expect(resolveContentTypeFlag({})).toBeUndefined();
  });
  it('--html maps to text/html', () => {
    expect(resolveContentTypeFlag({ html: true })).toBe('text/html');
  });
  it('--content-type text/html passes through', () => {
    expect(resolveContentTypeFlag({ 'content-type': 'text/html' })).toBe('text/html');
  });
  it('--content-type text/markdown passes through', () => {
    expect(resolveContentTypeFlag({ 'content-type': 'text/markdown' })).toBe('text/markdown');
  });
  it('--html and --content-type together → exit 2', () => {
    try {
      resolveContentTypeFlag({ html: true, 'content-type': 'text/html' });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as Error & { exitCode?: number };
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/mutually exclusive/);
    }
  });
  it('unknown --content-type → exit 2', () => {
    try {
      resolveContentTypeFlag({ 'content-type': 'application/pdf' });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as Error & { exitCode?: number };
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/unsupported content_type/);
    }
  });
  it('--content-type without a value → exit 2', () => {
    try {
      resolveContentTypeFlag({ 'content-type': true });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as Error & { exitCode?: number };
      expect(err.exitCode).toBe(2);
    }
  });
});

describe('request', () => {
  it('sends Authorization bearer + json body, returns parsed JSON', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const body = await request(
      { url: 'http://example', token: 'tok' },
      { method: 'POST', path: '/api/memory/documents', body: { title: 'hi' } },
      fakeFetch,
    );
    expect(body).toEqual({ ok: true });
    expect(captured.url).toBe('http://example/api/memory/documents');
    expect((captured.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((captured.init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(captured.init!.method).toBe('POST');
    expect(captured.init!.body).toBe(JSON.stringify({ title: 'hi' }));
  });

  it('throws on non-2xx with status + body attached', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })) as unknown as typeof fetch;
    await expect(
      request({ url: 'http://x', token: 't' }, { path: '/api/memory/documents/xx' }, fakeFetch),
    ).rejects.toThrow(/404.*not_found/);
  });

  it('appends query string', async () => {
    let captured = '';
    const fakeFetch = (async (url: string) => {
      captured = url;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await request(
      { url: 'http://x', token: 't' },
      { path: '/api/memory/search', query: { q: 'hello', limit: 5 } },
      fakeFetch,
    );
    expect(captured).toBe('http://x/api/memory/search?q=hello&limit=5');
  });
});
