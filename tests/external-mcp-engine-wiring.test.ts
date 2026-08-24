import { describe, expect, it, vi } from 'vitest';

import { webBotFromJson, type BotConfigBase } from '../src/config.js';
import { ClaudeExecutor } from '../src/engines/claude/executor.js';
import { buildPtyClaudeArgs } from '../src/engines/claude/pty/pty-session.js';
import type { ResolvedExternalMcpServer } from '../src/mcp/external-server.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

const server: ResolvedExternalMcpServer = {
  name: 'example-server',
  command: '/opt/example/bin/example-mcp',
  args: ['--stdio'],
  env: { EXAMPLE_MODE: 'read-only' },
  approvalMode: 'writes',
  toolApprovals: {},
};

function config(): BotConfigBase {
  return {
    name: 'example-bot',
    engine: 'claude',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp',
      downloadsDir: '/tmp',
      backend: 'pty',
    },
  };
}

describe('external MCP engine wiring', () => {
  it('adds resolved servers to Claude SDK without replacing user or project MCP settings', () => {
    const options = (new ClaudeExecutor(config(), logger) as any).buildQueryOptions(
      '/tmp',
      undefined,
      new AbortController(),
      undefined,
      undefined,
      undefined,
      undefined,
      [server],
    );

    expect(options.settingSources).toEqual(['user', 'project']);
    expect(options.mcpServers).toEqual({
      'example-server': {
        command: server.command,
        args: ['--stdio'],
        env: { EXAMPLE_MODE: 'read-only' },
      },
    });
    expect(options).not.toHaveProperty('strictMcpConfig');
  });

  it('passes the private additive config to Claude CLI without strict mode', () => {
    const args = buildPtyClaudeArgs(
      {
        settingsPath: '/private/settings.json',
        mcpConfigPath: '/private/mcp.json',
        model: 'example-model',
      },
      'session-one',
    );
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/private/mcp.json');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('preserves the same descriptor on the normalized per-bot config', () => {
    const bot = webBotFromJson({
      name: 'example-bot',
      defaultWorkingDirectory: '/tmp',
      mcpServers: [
        {
          name: 'example-server',
          enabled: true,
          command: 'example-mcp',
          args: ['--stdio'],
          approvalMode: 'writes',
        },
      ],
    });
    expect(bot.mcpServers).toEqual([
      expect.objectContaining({ name: 'example-server', enabled: true, command: 'example-mcp' }),
    ]);
  });
});
