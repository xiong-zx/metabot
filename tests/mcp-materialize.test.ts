import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeExecutionMcp,
  sweepExpiredCapabilityFiles,
} from '../src/engines/mcp-materialize.js';

const roots: string[] = [];
const logger = { warn: vi.fn(), debug: vi.fn() };

afterEach(() => {
  logger.warn.mockClear();
  logger.debug.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A materialized entry must name a proxy that really exists inside the runtime
 * root, so the fixture installs the same executables an install would.
 */
function runtimeRoot(proxies = ['metabot-worker-runner-proxy']): string {
  // Canonical, because materialization canonicalizes the runtime root and macOS
  // reaches the temp directory through the /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'metabot-mcp-runtime-')));
  roots.push(root);
  for (const _proxy of proxies) {
    const script = path.join(root, 'packages', 'worker-runner-mcp', 'dist', 'proxy-cli.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o755 });
  }
  return root;
}

function input(root: string, patch: Record<string, unknown> = {}) {
  return {
    executionEnv: {
      METABOT_BOT_NAME: 'pm-codex',
      METABOT_CHAT_ID: 'oc-user',
      METABOT_WORKER_CAPABILITY: 'WORKER_TOKEN_SENTINEL',
    },
    bridgeEnv: {
      METABOT_WORKER_DAEMON_URL: 'http://127.0.0.1:9311/mcp',
    },
    runtimeRoot: root,
    engineName: 'codex' as const,
    botName: 'pm-codex',
    chatId: 'oc-user',
    logger,
    ...patch,
  };
}

describe('materializeExecutionMcp', () => {
  it('writes only 0600 token files under a 0700 runtime scratch directory and cleans them', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(input(root));
    expect(materialized?.entries.map((entry) => entry.name)).toEqual(['metabot-worker']);

    const tokenPaths = materialized!.entries.map((entry) => Object.values(entry.env).find((value) => value.endsWith('.token'))!);
    const scratchDir = path.dirname(tokenPaths[0]);
    expect(lstatSync(scratchDir).mode & 0o777).toBe(0o700);
    expect(tokenPaths.map((file) => lstatSync(file).mode & 0o777)).toEqual([0o600]);
    expect(tokenPaths.map((file) => readFileSync(file, 'utf8'))).toEqual(['WORKER_TOKEN_SENTINEL']);
    expect(JSON.stringify(materialized!.entries)).not.toContain('TOKEN_SENTINEL');

    materialized!.cleanup();
    materialized!.cleanup();
    expect(tokenPaths.every((file) => !existsSync(file))).toBe(true);
  });

  it('gives concurrent turns in one chat separate capability files that clean up independently', () => {
    const root = runtimeRoot();
    const turn = (capability: string) =>
      materializeExecutionMcp(input(root, {
        executionEnv: {
          METABOT_BOT_NAME: 'pm-codex',
          METABOT_CHAT_ID: 'oc-user',
          METABOT_WORKER_CAPABILITY: capability,
        },
        bridgeEnv: { METABOT_WORKER_DAEMON_URL: 'http://127.0.0.1:9311/mcp' },
      }))!;

    const first = turn('worker-token-one');
    const second = turn('worker-token-two');
    const firstPath = first.entries[0].env.METABOT_WORKER_PROXY_CAPABILITY_FILE;
    const secondPath = second.entries[0].env.METABOT_WORKER_PROXY_CAPABILITY_FILE;

    // The second turn must not overwrite the credential the first turn's
    // already-running proxy is reading, and the first cleanup must not delete
    // the second turn's credential.
    expect(secondPath).not.toBe(firstPath);
    expect(readFileSync(firstPath, 'utf8')).toBe('worker-token-one');
    expect(readFileSync(secondPath, 'utf8')).toBe('worker-token-two');

    first.cleanup();
    expect(existsSync(firstPath)).toBe(false);
    expect(readFileSync(secondPath, 'utf8')).toBe('worker-token-two');
    second.cleanup();
    expect(existsSync(secondPath)).toBe(false);
  });

  it('refuses to reuse a capability path instead of overwriting a live credential', () => {
    const root = runtimeRoot();
    const collide = () =>
      materializeExecutionMcp(input(root, {
        executionEnv: {
          METABOT_BOT_NAME: 'pm-codex',
          METABOT_CHAT_ID: 'oc-user',
          METABOT_WORKER_CAPABILITY: 'worker-token',
        },
        bridgeEnv: { METABOT_WORKER_DAEMON_URL: 'http://127.0.0.1:9311/mcp' },
        nonce: () => 'fixed-nonce',
        now: () => 1_000,
      }));

    const first = collide()!;
    expect(collide()).toBeUndefined();
    expect(readFileSync(first.entries[0].env.METABOT_WORKER_PROXY_CAPABILITY_FILE, 'utf8')).toBe('worker-token');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'metabot-worker', reason: expect.stringMatching(/already exists|EEXIST/i) }),
      expect.stringContaining('other external tools stay available'),
    );
    first.cleanup();
  });

  it('sweeps crash leftovers at startup while keeping material a live turn still needs', () => {
    const root = runtimeRoot();
    const live = materializeExecutionMcp(input(root))!;
    const scratchDir = path.join(root, 'data', 'mcp-capabilities');
    const leftover = path.join(scratchDir, 'crashed-turn-worker.token');
    writeFileSync(leftover, 'orphaned-token', { encoding: 'utf8', mode: 0o600 });
    const old = Date.now() - 3 * 60 * 60 * 1000;
    utimesSync(leftover, old / 1000, old / 1000);

    const swept = sweepExpiredCapabilityFiles(root, logger);

    expect(swept.removed).toEqual([leftover]);
    expect(existsSync(leftover)).toBe(false);
    for (const entry of live.entries) {
      const file = Object.values(entry.env).find((value) => value.endsWith('.token'))!;
      expect(existsSync(file)).toBe(true);
    }
    live.cleanup();
  });

  it('sweeps nothing when there is no scratch directory or no runtime root', () => {
    const root = runtimeRoot();
    expect(sweepExpiredCapabilityFiles(root, logger)).toEqual({ removed: [], kept: 0 });
    expect(sweepExpiredCapabilityFiles(path.join(root, 'missing'), logger)).toEqual({ removed: [], kept: 0 });
  });

  it('renders additive Claude config containing file paths but no token material or strict flag', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(input(root, { engineName: 'claude' }))!;
    const configPath = materialized.claudeMcpConfigPath!;
    const configText = readFileSync(configPath, 'utf8');
    const config = JSON.parse(configText);

    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    expect(Object.keys(config.mcpServers)).toEqual(['metabot-worker']);
    expect(configText).not.toContain('TOKEN_SENTINEL');
    expect(configText.toLowerCase()).not.toContain('strict');
    expect(config.mcpServers['metabot-worker'].env).toHaveProperty(
      'METABOT_WORKER_PROXY_CAPABILITY_FILE',
      expect.stringMatching(/worker-.*\.token$/),
    );
    materialized.cleanup();
    expect(existsSync(configPath)).toBe(false);
  });

  it('fails closed for Kimi, identity mismatch, Team chats, and missing C4 endpoint envs without writing token files', () => {
    const root = runtimeRoot();
    expect(materializeExecutionMcp(input(root, { engineName: 'kimi' }))).toBeUndefined();
    expect(materializeExecutionMcp(input(root, {
      executionEnv: {
        METABOT_BOT_NAME: 'different-bot',
        METABOT_CHAT_ID: 'oc-user',
        METABOT_WORKER_CAPABILITY: 'worker-token',
      },
    }))).toBeUndefined();
    expect(materializeExecutionMcp(input(root, {
      executionEnv: {
        METABOT_BOT_NAME: 'pm-codex',
        METABOT_CHAT_ID: 'teaminst:project:agent',
        METABOT_WORKER_CAPABILITY: 'worker-token',
      },
      chatId: 'teaminst:project:agent',
    }))).toBeUndefined();
    expect(materializeExecutionMcp(input(root, { bridgeEnv: {} }))).toBeUndefined();

    const scratchDir = path.join(root, 'data', 'mcp-capabilities');
    expect(existsSync(scratchDir) ? readdirSync(scratchDir) : []).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'kimi', reason: 'no per-session MCP surface' }),
      expect.stringContaining('fail closed'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'execution identity does not match this turn' }),
      expect.stringContaining('fail closed'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'worker', reason: 'daemon endpoint is not configured' }),
      expect.stringContaining('fails closed'),
    );
  });
});
