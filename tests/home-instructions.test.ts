import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HOME_INSTRUCTIONS_MAX_BYTES,
  buildHomeInstructionsSection,
  isInsideDirectory,
  resolveMetabotHome,
} from '../src/engines/home-instructions.js';

const RULES = '# Host rules\n\nAlways branch from main before committing.\n';

let tmpRoot: string;
let metabotHome: string;
const originalHomeEnv = process.env.METABOT_HOME;

function makeLogger() {
  const debug: Array<[Record<string, unknown>, string]> = [];
  const warn: Array<[Record<string, unknown>, string]> = [];
  return {
    debug: (obj: Record<string, unknown>, msg: string) => void debug.push([obj, msg]),
    warn: (obj: Record<string, unknown>, msg: string) => void warn.push([obj, msg]),
    debugCalls: debug,
    warnCalls: warn,
  };
}

beforeEach(() => {
  // realpath so macOS /var → /private/var doesn't make containment checks lie.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-home-')));
  metabotHome = path.join(tmpRoot, 'metabot');
  fs.mkdirSync(metabotHome, { recursive: true });
  fs.writeFileSync(path.join(metabotHome, 'CLAUDE.md'), RULES);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalHomeEnv === undefined) delete process.env.METABOT_HOME;
  else process.env.METABOT_HOME = originalHomeEnv;
});

describe('buildHomeInstructionsSection', () => {
  it('injects $METABOT_HOME/CLAUDE.md when cwd is outside METABOT_HOME', () => {
    const cwd = path.join(tmpRoot, 'workdir');
    fs.mkdirSync(cwd);

    const section = buildHomeInstructionsSection({ cwd, metabotHome });

    expect(section).toBeDefined();
    expect(section).toContain('## MetaBot Host Instructions');
    expect(section).toContain(path.join(metabotHome, 'CLAUDE.md'));
    expect(section).toContain('Always branch from main before committing.');
  });

  it('skips injection when cwd is inside METABOT_HOME (engine auto-load covers it)', () => {
    const cwd = path.join(metabotHome, 'worktrees', 'feature-x');
    fs.mkdirSync(cwd, { recursive: true });

    expect(buildHomeInstructionsSection({ cwd, metabotHome })).toBeUndefined();
  });

  it('skips injection when cwd IS METABOT_HOME', () => {
    expect(buildHomeInstructionsSection({ cwd: metabotHome, metabotHome })).toBeUndefined();
  });

  it('does not treat a sibling with a shared prefix as being inside METABOT_HOME', () => {
    // The /root/metabot-foo vs /root/metabot trap: a naive startsWith would
    // wrongly skip injection here.
    const cwd = `${metabotHome}-foo`;
    fs.mkdirSync(cwd);

    const section = buildHomeInstructionsSection({ cwd, metabotHome });

    expect(section).toBeDefined();
    expect(section).toContain('Always branch from main before committing.');
  });

  it('skips (and debug-logs) when the instructions file is missing', () => {
    fs.rmSync(path.join(metabotHome, 'CLAUDE.md'));
    const logger = makeLogger();

    expect(buildHomeInstructionsSection({ cwd: tmpRoot, metabotHome, logger })).toBeUndefined();
    expect(logger.debugCalls.some(([, msg]) => msg.includes('No readable METABOT_HOME instructions'))).toBe(true);
    expect(logger.warnCalls).toHaveLength(0);
  });

  it('skips when METABOT_HOME itself does not exist', () => {
    expect(
      buildHomeInstructionsSection({ cwd: tmpRoot, metabotHome: path.join(tmpRoot, 'nope') }),
    ).toBeUndefined();
  });

  it('skips when the instructions file is empty or whitespace-only', () => {
    fs.writeFileSync(path.join(metabotHome, 'CLAUDE.md'), '   \n\n');
    expect(buildHomeInstructionsSection({ cwd: tmpRoot, metabotHome })).toBeUndefined();
  });

  it('truncates an oversized instructions file and warns', () => {
    const oversized = 'x'.repeat(HOME_INSTRUCTIONS_MAX_BYTES + 4096);
    fs.writeFileSync(path.join(metabotHome, 'CLAUDE.md'), oversized);
    const logger = makeLogger();

    const section = buildHomeInstructionsSection({ cwd: tmpRoot, metabotHome, logger });

    expect(section).toBeDefined();
    expect(section).toContain('[... truncated:');
    expect(section!.length).toBeLessThan(oversized.length);
    expect(logger.warnCalls.some(([, msg]) => msg.includes('exceeds the injection limit'))).toBe(true);
  });

  it('falls back to $METABOT_HOME from the environment when none is passed', () => {
    process.env.METABOT_HOME = metabotHome;
    const cwd = path.join(tmpRoot, 'elsewhere');
    fs.mkdirSync(cwd);

    const section = buildHomeInstructionsSection({ cwd });

    expect(section).toContain('Always branch from main before committing.');
  });

  it('falls back to process.cwd() when METABOT_HOME is unset', () => {
    delete process.env.METABOT_HOME;
    // process.cwd() is the repo root during tests, and the repo root ships a
    // CLAUDE.md — a cwd outside it must therefore receive an injection.
    const section = buildHomeInstructionsSection({ cwd: tmpRoot });

    expect(resolveMetabotHome()).toBe(path.resolve(process.cwd()));
    expect(section).toContain('## MetaBot Host Instructions');
  });
});

describe('isInsideDirectory', () => {
  it('matches the directory itself and its descendants', () => {
    expect(isInsideDirectory('/root/metabot', '/root/metabot')).toBe(true);
    expect(isInsideDirectory('/root/metabot/worktrees/x', '/root/metabot')).toBe(true);
  });

  it('rejects shared-prefix siblings and unrelated paths', () => {
    expect(isInsideDirectory('/root/metabot-foo', '/root/metabot')).toBe(false);
    expect(isInsideDirectory('/root/metabotfoo', '/root/metabot')).toBe(false);
    expect(isInsideDirectory('/root', '/root/metabot')).toBe(false);
    expect(isInsideDirectory('/opt/other', '/root/metabot')).toBe(false);
  });

  it('normalizes relative segments before comparing', () => {
    expect(isInsideDirectory('/root/metabot/../metabot-foo', '/root/metabot')).toBe(false);
    expect(isInsideDirectory('/root/metabot/a/../b', '/root/metabot')).toBe(true);
  });
});
