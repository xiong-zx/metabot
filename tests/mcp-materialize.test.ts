import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeExecutionMcp } from '../src/engines/mcp-materialize.js';

const roots: string[] = [];
const logger = { warn: vi.fn(), debug: vi.fn() };

afterEach(() => {
  logger.warn.mockClear();
  logger.debug.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'metabot-mcp-runtime-'));
  roots.push(root);
  return root;
}

function input(root: string, patch: Record<string, unknown> = {}) {
  return {
    executionEnv: {
      METABOT_BOT_NAME: 'pm-codex',
      METABOT_CHAT_ID: 'oc-user',
      METABOT_WORKER_CAPABILITY: 'WORKER_TOKEN_SENTINEL',
      METABOT_ARC_CAPABILITY: 'ARC_TOKEN_SENTINEL',
    },
    bridgeEnv: {
      METABOT_WORKER_DAEMON_URL: 'http://127.0.0.1:9311/mcp',
      METABOT_ARC_DAEMON_URL: 'http://127.0.0.1:9312/mcp',
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
    expect(materialized?.entries.map((entry) => entry.name)).toEqual(['metabot-worker', 'metabot-arc']);

    const tokenPaths = materialized!.entries.map((entry) => Object.values(entry.env).find((value) => value.endsWith('.token'))!);
    const scratchDir = path.dirname(tokenPaths[0]);
    expect(lstatSync(scratchDir).mode & 0o777).toBe(0o700);
    expect(tokenPaths.map((file) => lstatSync(file).mode & 0o777)).toEqual([0o600, 0o600]);
    expect(tokenPaths.map((file) => readFileSync(file, 'utf8'))).toEqual([
      'WORKER_TOKEN_SENTINEL',
      'ARC_TOKEN_SENTINEL',
    ]);
    expect(JSON.stringify(materialized!.entries)).not.toContain('TOKEN_SENTINEL');

    materialized!.cleanup();
    materialized!.cleanup();
    expect(tokenPaths.every((file) => !existsSync(file))).toBe(true);
  });

  it('atomically rewrites stable file paths on capability rotation without a release race', () => {
    const root = runtimeRoot();
    const first = materializeExecutionMcp(input(root, {
      executionEnv: {
        METABOT_BOT_NAME: 'pm-codex',
        METABOT_CHAT_ID: 'oc-user',
        METABOT_WORKER_CAPABILITY: 'worker-token-one',
      },
      bridgeEnv: { METABOT_WORKER_DAEMON_URL: 'http://127.0.0.1:9311/mcp' },
    }))!;
    const firstPath = first.entries[0].env.METABOT_WORKER_PROXY_CAPABILITY_FILE;
    const second = materializeExecutionMcp(input(root, {
      executionEnv: {
        METABOT_BOT_NAME: 'pm-codex',
        METABOT_CHAT_ID: 'oc-user',
        METABOT_WORKER_CAPABILITY: 'worker-token-two',
      },
      bridgeEnv: { METABOT_WORKER_DAEMON_URL: 'http://127.0.0.1:9311/mcp' },
    }))!;
    const secondPath = second.entries[0].env.METABOT_WORKER_PROXY_CAPABILITY_FILE;

    expect(secondPath).toBe(firstPath);
    expect(readFileSync(secondPath, 'utf8')).toBe('worker-token-two');
    first.cleanup();
    expect(readFileSync(secondPath, 'utf8')).toBe('worker-token-two');
    second.cleanup();
    expect(existsSync(secondPath)).toBe(false);
  });

  it('renders additive Claude config containing file paths but no token material or strict flag', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(input(root, { engineName: 'claude' }))!;
    const configPath = materialized.claudeMcpConfigPath!;
    const configText = readFileSync(configPath, 'utf8');
    const config = JSON.parse(configText);

    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    expect(Object.keys(config.mcpServers)).toEqual(['metabot-worker', 'metabot-arc']);
    expect(configText).not.toContain('TOKEN_SENTINEL');
    expect(configText.toLowerCase()).not.toContain('strict');
    expect(config.mcpServers['metabot-worker'].env).toHaveProperty(
      'METABOT_WORKER_PROXY_CAPABILITY_FILE',
      expect.stringMatching(/worker\.token$/),
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
