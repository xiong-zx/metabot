import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listCodexSessions } from '../src/engines/codex/session-lister.js';
import { workdirCodexHomePath } from '../src/engines/codex/codex-home.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import type { BotConfigBase } from '../src/config.js';

/**
 * `/resume` must read the same CODEX_HOME the bot writes to. A bot with
 * `codex.homeScope: workdir` (or an explicit `codex.env.CODEX_HOME`) records
 * its threads in an isolated home, so listing the global home shows nothing.
 */

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => mockLogger,
} as any;

const sender = {
  async sendCard() { return 'msg'; },
  async updateCard() { return true; },
  async sendQuestionCard() { return 'q'; },
  async updateQuestionCard() { return true; },
  async sendTextNotice() {},
  async sendText() {},
  async sendImageFile() { return true; },
  async sendLocalFile() { return true; },
  async downloadImage() { return false; },
  async downloadFile() { return false; },
} as any;

const tempDirs: string[] = [];
const priorHomesDir = process.env.METABOT_CODEX_HOMES_DIR;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (priorHomesDir === undefined) delete process.env.METABOT_CODEX_HOMES_DIR;
  else process.env.METABOT_CODEX_HOMES_DIR = priorHomesDir;
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Write a Codex rollout transcript into `<codexHome>/sessions/...`. */
function seedSession(codexHome: string, sessionId: string, cwd: string, message: string): void {
  const dir = join(codexHome, 'sessions', '2026', '07', '25');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } }),
  ];
  writeFileSync(join(dir, `rollout-${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

function makeCodexBridge(codex: BotConfigBase['codex']): any {
  const config = {
    name: 'test-bot',
    engine: 'codex',
    claude: {
      defaultWorkingDirectory: '/tmp',
      outputsBaseDir: '/tmp/metabot-test-outputs',
      downloadsDir: '/tmp/metabot-test-downloads',
      backend: 'pty',
    },
    persistentExecutor: { enabled: false },
    codex,
  } as BotConfigBase;
  return new MessageBridge(config, mockLogger, sender);
}

describe('listCodexSessions codexHome override', () => {
  it('reads the given home instead of the global one', () => {
    const workdir = makeTempDir('metabot-codex-workdir-');
    const globalHome = makeTempDir('metabot-codex-global-');
    const scopedHome = makeTempDir('metabot-codex-scoped-');
    seedSession(globalHome, 'global-session', workdir, 'from the global home');
    seedSession(scopedHome, 'scoped-session', workdir, 'from the workdir home');

    const sessions = listCodexSessions({ workingDirectory: workdir, codexHome: scopedHome });

    expect(sessions.map((s) => s.sessionId)).toEqual(['scoped-session']);
    expect(sessions[0].preview).toBe('from the workdir home');
  });

  it('still falls back to the global home when no override is given', () => {
    const workdir = makeTempDir('metabot-codex-workdir-');
    const globalHome = makeTempDir('metabot-codex-global-');
    seedSession(globalHome, 'global-session', workdir, 'from the global home');
    const priorCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = globalHome;
      const sessions = listCodexSessions({ workingDirectory: workdir });
      expect(sessions.map((s) => s.sessionId)).toEqual(['global-session']);
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
    }
  });
});

describe('MessageBridge Codex home resolution for /resume', () => {
  it('uses the per-workdir home when codex.homeScope is workdir', () => {
    const homesDir = makeTempDir('metabot-codex-homes-');
    process.env.METABOT_CODEX_HOMES_DIR = homesDir;
    const bridge = makeCodexBridge({ homeScope: 'workdir' });

    const resolved = bridge.resolveCodexHomeForListing('/work/proj');

    expect(resolved).toBe(workdirCodexHomePath('/work/proj'));
    expect(resolved.startsWith(homesDir)).toBe(true);
    // Listing is read-only: it must not create or seed a home as a side effect.
    expect(existsSync(resolved)).toBe(false);
  });

  it('prefers an explicit codex.env.CODEX_HOME over the workdir scope', () => {
    const bridge = makeCodexBridge({ homeScope: 'workdir', env: { CODEX_HOME: '/custom/codex-home' } });

    expect(bridge.resolveCodexHomeForListing('/work/proj')).toBe('/custom/codex-home');
  });

  it('returns undefined for the default global home', () => {
    expect(makeCodexBridge({ model: 'gpt-5.5' }).resolveCodexHomeForListing('/work/proj')).toBeUndefined();
    expect(makeCodexBridge(undefined).resolveCodexHomeForListing('/work/proj')).toBeUndefined();
  });
});
