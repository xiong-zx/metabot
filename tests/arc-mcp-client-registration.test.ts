import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildExecutionMcpEntries, toSdkMcpServers } from '../src/engines/mcp-entries.js';
import { materializeExecutionMcp } from '../src/engines/mcp-materialize.js';

/**
 * ARC-005. MetaBot, Codex, and Claude each reach the independent ARC MCP server
 * directly: same entry name, same loopback endpoint, same audience-bound
 * capability file, no intermediate product gateway, and no dependency on any
 * other research product.
 */

const roots: string[] = [];
const logger = { warn: vi.fn(), debug: vi.fn() };

const ARC_ENDPOINT = 'http://127.0.0.1:9312/mcp';
const WORKER_ENDPOINT = 'http://127.0.0.1:9311/mcp';

afterEach(() => {
  logger.warn.mockClear();
  logger.debug.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeRoot(proxies = ['metabot-worker-runner-proxy', 'metabot-arc-proxy']): string {
  // Canonical, because materialization canonicalizes the runtime root and macOS
  // reaches the temp directory through the /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'metabot-arc-registration-')));
  roots.push(root);
  for (const proxy of proxies) {
    const script = proxy === 'metabot-worker-runner-proxy'
      ? path.join(root, 'packages', 'worker-runner-mcp', 'dist', 'proxy-cli.js')
      : path.join(root, 'packages', 'arc-mcp', 'dist', 'proxy-cli.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o755 });
  }
  return root;
}

function input(root: string, patch: Record<string, unknown> = {}) {
  return {
    executionEnv: {
      METABOT_BOT_NAME: 'pm',
      METABOT_CHAT_ID: 'oc-user',
      METABOT_WORKER_CAPABILITY: 'WORKER_TOKEN_SENTINEL',
      METABOT_ARC_CAPABILITY: 'ARC_TOKEN_SENTINEL',
    },
    bridgeEnv: {
      METABOT_WORKER_DAEMON_URL: WORKER_ENDPOINT,
      METABOT_ARC_DAEMON_URL: ARC_ENDPOINT,
    },
    runtimeRoot: root,
    engineName: 'codex' as const,
    botName: 'pm',
    chatId: 'oc-user',
    logger,
    ...patch,
  };
}

describe('direct ARC MCP registration', () => {
  it('gives Codex and Claude the same metabot-arc server on the same capability', () => {
    const root = runtimeRoot();
    const codex = materializeExecutionMcp(input(root, { engineName: 'codex' }))!;
    const claude = materializeExecutionMcp(input(root, { engineName: 'claude' }))!;
    try {
      const codexArc = codex.entries.find((entry) => entry.name === 'metabot-arc')!;
      const claudeArc = claude.entries.find((entry) => entry.name === 'metabot-arc')!;
      // Identical server, endpoint, and credential. The capability *file paths*
      // differ by design: each turn leases its own, so one client's cleanup can
      // never revoke another client's live session.
      expect(codexArc.command).toBe(claudeArc.command);
      expect(codexArc.args).toEqual(claudeArc.args);
      expect(codexArc.env.METABOT_ARC_PROXY_URL).toBe(claudeArc.env.METABOT_ARC_PROXY_URL);
      expect(codexArc.env.METABOT_ARC_PROXY_CAPABILITY_FILE).not.toBe(
        claudeArc.env.METABOT_ARC_PROXY_CAPABILITY_FILE,
      );
      expect(readFileSync(codexArc.env.METABOT_ARC_PROXY_CAPABILITY_FILE, 'utf8')).toBe(
        readFileSync(claudeArc.env.METABOT_ARC_PROXY_CAPABILITY_FILE, 'utf8'),
      );
      expect(realpathSync(codexArc.command)).toBe(realpathSync(process.execPath));
      expect(codexArc.args).toEqual([path.join(root, 'packages', 'arc-mcp', 'dist', 'proxy-cli.js')]);
      expect(codexArc.env.METABOT_ARC_PROXY_URL).toBe(ARC_ENDPOINT);

      // Claude additionally receives a file, but it must describe the same server.
      const config = JSON.parse(readFileSync(claude.claudeMcpConfigPath!, 'utf8')) as {
        mcpServers: Record<string, { command: string; env: Record<string, string> }>;
      };
      expect(config.mcpServers['metabot-arc']).toEqual({
        command: claudeArc.command,
        args: claudeArc.args,
        env: claudeArc.env,
      });
      expect(toSdkMcpServers(codex.entries)['metabot-arc']).toEqual({
        command: config.mcpServers['metabot-arc'].command,
        args: codexArc.args,
        env: {
          ...config.mcpServers['metabot-arc'].env,
          METABOT_ARC_PROXY_CAPABILITY_FILE: codexArc.env.METABOT_ARC_PROXY_CAPABILITY_FILE,
        },
      });
    } finally {
      codex.cleanup();
      claude.cleanup();
    }
  });

  it('reaches the ARC daemon directly rather than through any product gateway', () => {
    const root = runtimeRoot();
    const entries = buildExecutionMcpEntries({
      executionEnv: {
        METABOT_BOT_NAME: 'pm',
        METABOT_CHAT_ID: 'oc-user',
        METABOT_ARC_CAPABILITY: 'ARC_TOKEN_SENTINEL',
      },
      bridgeEnv: { METABOT_ARC_DAEMON_URL: ARC_ENDPOINT },
      runtimeRoot: root,
      capabilityFiles: { arc: path.join(root, 'arc.token') },
    });
    expect(entries.map((entry) => entry.name)).toEqual(['metabot-arc']);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/research-stack|metaclaw|gateway|proxy-router/i);
    expect(entries[0].command).toBe(process.execPath);
    expect(entries[0].args).toEqual([path.join(root, 'packages', 'arc-mcp', 'dist', 'proxy-cli.js')]);
  });

  it('keeps the capability out of argv and in a private per-turn file', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(input(root))!;
    try {
      const arc = materialized.entries.find((entry) => entry.name === 'metabot-arc')!;
      expect(JSON.stringify(arc.args)).not.toContain('ARC_TOKEN_SENTINEL');
      expect(arc.env.METABOT_ARC_PROXY_URL).not.toContain('ARC_TOKEN_SENTINEL');
      const tokenFile = arc.env.METABOT_ARC_PROXY_CAPABILITY_FILE;
      expect(readFileSync(tokenFile, 'utf8')).toBe('ARC_TOKEN_SENTINEL');
      materialized.cleanup();
      // Per-turn: the leased material is gone once the turn released it.
      expect(() => readFileSync(tokenFile, 'utf8')).toThrow();
    } finally {
      materialized.cleanup();
    }
  });

  it('keeps ARC available when the Worker Runner proxy is not installed', () => {
    const root = runtimeRoot(['metabot-arc-proxy']);
    const materialized = materializeExecutionMcp(input(root))!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['metabot-arc']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'metabot-worker' }),
        expect.stringContaining('other external tools stay available'),
      );
    } finally {
      materialized.cleanup();
    }
  });

  it('keeps Worker Runner available when the ARC proxy is not installed', () => {
    const root = runtimeRoot(['metabot-worker-runner-proxy']);
    const materialized = materializeExecutionMcp(input(root))!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['metabot-worker']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'metabot-arc' }),
        expect.stringContaining('other external tools stay available'),
      );
    } finally {
      materialized.cleanup();
    }
  });

  it('drops ARC alone when its daemon endpoint is not loopback HTTP', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(
      input(root, { bridgeEnv: { METABOT_WORKER_DAEMON_URL: WORKER_ENDPOINT, METABOT_ARC_DAEMON_URL: 'https://arc.example.com/mcp' } }),
    )!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['metabot-worker']);
    } finally {
      materialized.cleanup();
    }
  });

  it('refuses a proxy path that escapes the runtime root', () => {
    const root = runtimeRoot(['metabot-worker-runner-proxy']);
    const outside = mkdtempSync(path.join(tmpdir(), 'metabot-arc-outside-'));
    roots.push(outside);
    const stray = path.join(outside, 'metabot-arc-proxy');
    writeFileSync(stray, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
    const arcProxy = path.join(root, 'packages', 'arc-mcp', 'dist', 'proxy-cli.js');
    mkdirSync(path.dirname(arcProxy), { recursive: true });
    symlinkSync(stray, arcProxy);

    const materialized = materializeExecutionMcp(input(root))!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['metabot-worker']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'metabot-arc', reason: expect.stringMatching(/escapes the runtime root/i) }),
        expect.any(String),
      );
    } finally {
      materialized.cleanup();
    }
  });

  it('produces no ARC entry for a bot that did not opt in', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(
      input(root, {
        executionEnv: {
          METABOT_BOT_NAME: 'pm',
          METABOT_CHAT_ID: 'oc-user',
          METABOT_WORKER_CAPABILITY: 'WORKER_TOKEN_SENTINEL',
        },
      }),
    )!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['metabot-worker']);
    } finally {
      materialized.cleanup();
    }
  });
});
