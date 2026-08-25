import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';
import { ClaudeExecutor } from '../src/engines/claude/executor.js';
import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';
import { buildPtyClaudeArgs } from '../src/engines/claude/pty/pty-session.js';
import type { McpEntry } from '../src/engines/mcp-entries.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const entries: McpEntry[] = [
  {
    name: 'metabot-worker',
    command: '/runtime/node_modules/.bin/metabot-worker-runner-proxy',
    args: [],
    env: {
      METABOT_WORKER_PROXY_URL: 'http://127.0.0.1:9311/mcp',
      METABOT_WORKER_PROXY_CAPABILITY_FILE: '/runtime/data/mcp-capabilities/worker.token',
    },
    codexToolsApprovalMode: 'approve',
  },
];

function config(): BotConfigBase {
  return {
    name: 'claude-test',
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

describe('Claude additive MCP configuration', () => {
  it('adds MCP servers to the legacy SDK query while preserving user/project settings', () => {
    const options = (new ClaudeExecutor(config(), logger) as any).buildQueryOptions(
      '/tmp',
      undefined,
      new AbortController(),
      undefined,
      undefined,
      undefined,
      entries,
    );

    expect(options.settingSources).toEqual(['user', 'project']);
    expect(options.mcpServers).toEqual({
      'metabot-worker': {
        command: entries[0].command,
        args: [],
        env: entries[0].env,
      },
    });
    expect(options).not.toHaveProperty('strictMcpConfig');
  });

  it('passes only the private config path to the persistent PTY argv and never enables strict mode', () => {
    const args = buildPtyClaudeArgs({
      settingsPath: '/runtime/data/settings.json',
      mcpConfigPath: '/runtime/data/mcp-capabilities/claude-mcp.json',
      appendSystemPromptFile: '/runtime/data/system-prompt.md',
      model: 'claude-opus-4-8',
    }, 'session-one');

    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/runtime/data/mcp-capabilities/claude-mcp.json');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).toContain('--append-system-prompt-file');
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/runtime/data/system-prompt.md');
    expect(args.join(' ')).not.toContain('CAPABILITY_TOKEN_SENTINEL');
  });

  it('pins the persistent SDK and PTY call sites to additive MCP without a strict option', () => {
    const persistentSource = readFileSync(
      new URL('../src/engines/claude/persistent-executor.ts', import.meta.url),
      'utf8',
    );
    expect(persistentSource).toContain('...toSdkMcpServers(this.options.mcpEntries ?? [])');
    expect(persistentSource).toContain('...toClaudeMcpServers(this.options.mcpServers ?? [])');
    expect(persistentSource).toContain('mcpConfigPath: this.options.mcpConfigPath');
    expect(persistentSource).not.toContain('strictMcpConfig');
    expect(persistentSource).not.toContain('--strict-mcp-config');
  });

  it('cleans persistent capability material exactly once when the executor closes', () => {
    const cleanup = vi.fn();
    const executor = new PersistentClaudeExecutor({
      cwd: '/tmp',
      logger,
      idleTimeoutMs: 0,
      mcpEntries: entries,
      mcpConfigPath: '/runtime/data/mcp-capabilities/claude-mcp.json',
      mcpCleanup: cleanup,
    });

    (executor as any).transition('closed');
    (executor as any).transition('closed');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
