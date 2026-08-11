import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { loadConfig, DEFAULT_URL } from '../src/config.js';
import { request } from '../src/client.js';
import {
  parseArgs,
  cmdInstall,
  cmdPublish,
  defaultInstallDir,
  targetsEngineAutoloadDir,
} from '../src/commands.js';

describe('parseArgs', () => {
  it('handles --to flag value', () => {
    const a = parseArgs(['my-skill', '--to', '/tmp/x']);
    expect(a.positional).toEqual(['my-skill']);
    expect(a.flags.to).toBe('/tmp/x');
  });
});

describe('loadConfig', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cfg-'));
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
  it('reads token from ~/.metabot-core/token', () => {
    fs.mkdirSync(path.join(tmpHome, '.metabot-core'));
    fs.writeFileSync(path.join(tmpHome, '.metabot-core', 'token'), 'file-tok\n');
    const cfg = loadConfig({});
    expect(cfg.url).toBe(DEFAULT_URL);
    expect(cfg.token).toBe('file-tok');
  });
});

describe('request', () => {
  it('sends Authorization bearer + parses JSON response', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const body = await request(
      { url: 'http://ex', token: 'tok' },
      { path: '/api/skills' },
      fakeFetch,
    );
    expect(body).toEqual({ skills: [] });
    expect(captured.url).toBe('http://ex/api/skills');
    expect((captured.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});

describe('cmdInstall', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-install-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes SKILL.md to <to>/SKILL.md', async () => {
    const skillMd = '---\nname: foo\n---\n# hi\n';
    const cfg = { url: 'http://ex', token: 't' };
    // Override global fetch for this test.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: 'foo', version: 1, skillMd }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const stdoutSpy: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
        stdoutSpy.push(s);
        return true;
      };
      try {
        await cmdInstall(cfg, { positional: ['foo'], flags: { to: tmp } });
      } finally {
        process.stdout.write = origWrite;
      }
      const dst = path.join(tmp, 'SKILL.md');
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.readFileSync(dst, 'utf8')).toBe(skillMd);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('defaults to a non-engine review directory', () => {
    expect(defaultInstallDir('foo')).toBe(path.join('.metabot', 'skills', 'foo'));
    expect(targetsEngineAutoloadDir(defaultInstallDir('foo'))).toBe(false);
  });

  it('refuses to install into engine auto-load directories without --trust', async () => {
    const cfg = { url: 'http://ex', token: 't' };
    await expect(cmdInstall(cfg, { positional: ['foo'], flags: { to: path.join(tmp, '.claude', 'skills', 'foo') } }))
      .rejects.toThrow('without --trust');
  });

  it('allows engine auto-load install when --trust is explicit', async () => {
    const skillMd = '---\nname: foo\n---\n# hi\n';
    const cfg = { url: 'http://ex', token: 't' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: 'foo', version: 1, skillMd }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const stdoutSpy: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
        stdoutSpy.push(s);
        return true;
      };
      try {
        const to = path.join(tmp, '.claude', 'skills', 'foo');
        await cmdInstall(cfg, { positional: ['foo'], flags: { to, trust: true } });
        expect(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8')).toBe(skillMd);
      } finally {
        process.stdout.write = origWrite;
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('restores the complete bundle and replaces stale files', async () => {
    const skillMd = '---\nname: foo\n---\n# hi\n';
    const binary = Buffer.from([0, 1, 2, 255]);
    const cfg = { url: 'http://ex', token: 't' };
    const to = path.join(tmp, 'foo');
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, 'stale.txt'), 'old');
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/references')) {
        return new Response(JSON.stringify({
          name: 'foo',
          version: 2,
          files: [
            { path: 'assets/blob.bin', content: binary.toString('base64'), encoding: 'base64', mode: 0o644 },
            { path: 'scripts/run.sh', content: '#!/bin/sh\necho ok\n', mode: 0o755 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'foo', version: 2, skillMd, hasReferences: true }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = () => true;
      try {
        await cmdInstall(cfg, { positional: ['foo'], flags: { to } });
      } finally {
        process.stdout.write = origWrite;
      }
      expect(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8')).toBe(skillMd);
      expect(fs.readFileSync(path.join(to, 'assets', 'blob.bin'))).toEqual(binary);
      expect(fs.readFileSync(path.join(to, 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho ok\n');
      expect(fs.statSync(path.join(to, 'scripts', 'run.sh')).mode & 0o777).toBe(0o755);
      expect(fs.existsSync(path.join(to, 'stale.txt'))).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('rejects unsafe bundle paths before changing the destination', async () => {
    const cfg = { url: 'http://ex', token: 't' };
    const to = path.join(tmp, 'foo');
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, 'keep.txt'), 'keep');
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/references')) {
        return new Response(JSON.stringify({
          files: [{ path: '../escape.txt', content: 'bad' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: 'foo', version: 1, skillMd: '---\nname: foo\n---\n', hasReferences: true,
      }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(cmdInstall(cfg, { positional: ['foo'], flags: { to } })).rejects.toThrow('unsafe file path');
      expect(fs.readFileSync(path.join(to, 'keep.txt'), 'utf8')).toBe('keep');
      expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('cmdPublish', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-publish-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('packs the complete bundle from --from <dir>', async () => {
    fs.writeFileSync(path.join(tmp, 'SKILL.md'), '# hello\n');
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.writeFileSync(path.join(tmp, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    fs.mkdirSync(path.join(tmp, 'assets'));
    fs.writeFileSync(path.join(tmp, 'assets', 'blob.bin'), Buffer.from([0, 255, 1]));
    let captured: { body?: string } = {};
    const cfg = { url: 'http://ex', token: 't' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      captured.body = init.body as string;
      return new Response(JSON.stringify({ name: 'x', version: 1, published: true }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    try {
      const stdoutSpy: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
        stdoutSpy.push(s);
        return true;
      };
      try {
        await cmdPublish(cfg, { positional: ['x'], flags: { from: tmp } });
      } finally {
        process.stdout.write = origWrite;
      }
      const parsed = JSON.parse(captured.body!);
      expect(parsed.skillMd).toBe('# hello\n');
      const packed = JSON.parse(zlib.gunzipSync(Buffer.from(parsed.referencesTar, 'base64')).toString('utf8'));
      expect(packed.files).toEqual([
        {
          path: 'assets/blob.bin',
          content: Buffer.from([0, 255, 1]).toString('base64'),
          encoding: 'base64',
          mode: 0o644,
        },
        {
          path: 'scripts/run.sh',
          content: Buffer.from('#!/bin/sh\necho ok\n').toString('base64'),
          encoding: 'base64',
          mode: 0o755,
        },
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('clears an earlier bundle when --from contains only SKILL.md', async () => {
    fs.writeFileSync(path.join(tmp, 'SKILL.md'), '# hello\n');
    let captured: { body?: string } = {};
    const cfg = { url: 'http://ex', token: 't' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      captured.body = init.body as string;
      return new Response(JSON.stringify({ name: 'x', version: 2, published: true }), { status: 201 });
    }) as unknown as typeof fetch;
    try {
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = () => true;
      try {
        await cmdPublish(cfg, { positional: ['x'], flags: { from: tmp } });
      } finally {
        process.stdout.write = origWrite;
      }
      expect(JSON.parse(captured.body!).referencesTar).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
