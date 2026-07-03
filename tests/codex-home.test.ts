import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkdirCodexHome, workdirHomeSlug } from '../src/engines/codex/codex-home.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as any;

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prior[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('workdirHomeSlug', () => {
  it('is stable, readable, and collision-safe', () => {
    const slug = workdirHomeSlug('/root/projects/ideaA');
    expect(slug).toBe(workdirHomeSlug('/root/projects/ideaA'));
    expect(slug).toMatch(/^ideaA-[0-9a-f]{8}$/);
    expect(workdirHomeSlug('/other/place/ideaA')).not.toBe(slug);
  });
});

describe('prepareWorkdirCodexHome', () => {
  it('creates one home per workdir and seeds auth/config from the global home', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-home-test-'));
    const globalHome = join(tmp, 'global-codex');
    mkdirSync(globalHome, { recursive: true });
    writeFileSync(join(globalHome, 'auth.json'), '{"token":"v1"}');
    writeFileSync(join(globalHome, 'config.toml'), 'model = "gpt-5.4"\n');

    try {
      withEnv({ CODEX_HOME: globalHome, METABOT_CODEX_HOMES_DIR: join(tmp, 'homes') }, () => {
        const homeA = prepareWorkdirCodexHome(join(tmp, 'ideaA'), noopLogger);
        const homeB = prepareWorkdirCodexHome(join(tmp, 'ideaB'), noopLogger);
        expect(homeA).not.toBe(homeB);
        expect(readFileSync(join(homeA, 'auth.json'), 'utf-8')).toContain('v1');
        expect(readFileSync(join(homeA, 'config.toml'), 'utf-8')).toContain('gpt-5.4');
        expect(existsSync(join(homeB, 'auth.json'))).toBe(true);
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('re-seeds when the global copy is newer but keeps a newer home copy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-home-test-'));
    const globalHome = join(tmp, 'global-codex');
    mkdirSync(globalHome, { recursive: true });
    writeFileSync(join(globalHome, 'auth.json'), '{"token":"v1"}');

    try {
      withEnv({ CODEX_HOME: globalHome, METABOT_CODEX_HOMES_DIR: join(tmp, 'homes') }, () => {
        const home = prepareWorkdirCodexHome(join(tmp, 'idea'), noopLogger);

        writeFileSync(join(globalHome, 'auth.json'), '{"token":"v2"}');
        const future = new Date(Date.now() + 5000);
        utimesSync(join(globalHome, 'auth.json'), future, future);
        prepareWorkdirCodexHome(join(tmp, 'idea'), noopLogger);
        expect(readFileSync(join(home, 'auth.json'), 'utf-8')).toContain('v2');

        writeFileSync(join(home, 'auth.json'), '{"token":"home-refreshed"}');
        const later = new Date(Date.now() + 10000);
        utimesSync(join(home, 'auth.json'), later, later);
        prepareWorkdirCodexHome(join(tmp, 'idea'), noopLogger);
        expect(readFileSync(join(home, 'auth.json'), 'utf-8')).toContain('home-refreshed');
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
