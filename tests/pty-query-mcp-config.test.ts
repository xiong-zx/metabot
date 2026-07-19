/**
 * Regression: ptyQuery must materialize `options.mcpServers` into a config file
 * and hand its path to the session as `mcpConfigPath`.
 *
 * The CLI does NOT read MCP servers out of the --settings json we already
 * generate — only from --mcp-config / .mcp.json / ~/.claude.json. So servers
 * that merely reach ptyQuery are still invisible to the spawned `claude` unless
 * they get written to their own file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeSession = vi.hoisted(() => ({
  interrupt: vi.fn(async () => {}),
  typePrompt: vi.fn(async () => {}),
  snapshot: vi.fn(() => ''),
  screen: vi.fn(() => ''),
  sendKeys: vi.fn(),
  ready: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  jsonlPath: '/tmp/metabot-fake-claude.jsonl',
  sessionId: 'sess-test',
}));

const createPtyClaudeSessionMock = vi.hoisted(() => vi.fn(() => fakeSession));

vi.mock('../src/engines/claude/pty/pty-session.js', () => ({
  createPtyClaudeSession: createPtyClaudeSessionMock,
}));

vi.mock('../src/engines/claude/pty/jsonl-scanner.js', () => ({
  createJsonlScanner: vi.fn(() => ({
    drainPending: vi.fn(() => []),
    stop: vi.fn(),
    async *[Symbol.asyncIterator]() {
      // Never yields — we only care about what boot did.
    },
  })),
}));

import { ptyQuery } from '../src/engines/claude/pty/pty-query.js';
import type { PtyUserMessage } from '../src/engines/claude/pty/contract.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

const MCP_CONFIG_PATH = '/tmp/metabot-fake-mcp-config.json';

const SERVERS = {
  'worker-manager': { command: 'bash', args: ['-lc', 'exec node server.js'] },
};

function createHookBridge() {
  return {
    writeSettings: vi.fn(async () => '/tmp/metabot-fake-settings.json'),
    writeMcpConfig: vi.fn(async () => MCP_CONFIG_PATH),
    onTurnComplete: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

async function* onePromptThenWait(text: string): AsyncIterable<PtyUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: 'input-session',
  };
  await new Promise(() => {});
}

/** Kick off a query and let the async boot block run to completion. */
async function boot(extraOptions: Record<string, unknown>) {
  const hookBridge = createHookBridge();
  const query = ptyQuery({
    prompt: onePromptThenWait('hello'),
    options: { cwd: '/tmp', logger, hookBridge: hookBridge as any, ...extraOptions },
  });
  void query[Symbol.asyncIterator]();
  await new Promise((resolve) => setImmediate(resolve));
  return { hookBridge, query };
}

describe('ptyQuery --mcp-config wiring', () => {
  beforeEach(() => {
    createPtyClaudeSessionMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes an MCP config and passes its path to the session', async () => {
    const { hookBridge } = await boot({ mcpServers: SERVERS });

    expect(hookBridge.writeMcpConfig).toHaveBeenCalledWith(SERVERS);
    expect(createPtyClaudeSessionMock).toHaveBeenCalledTimes(1);
    const sessionOpts = createPtyClaudeSessionMock.mock.calls[0][0] as any;
    expect(sessionOpts.mcpConfigPath).toBe(MCP_CONFIG_PATH);
  });

  it('skips the config entirely when there are no servers', async () => {
    const { hookBridge } = await boot({});

    expect(hookBridge.writeMcpConfig).not.toHaveBeenCalled();
    const sessionOpts = createPtyClaudeSessionMock.mock.calls[0][0] as any;
    expect(sessionOpts.mcpConfigPath).toBeUndefined();
  });

  it('treats an empty server map as nothing to expose', async () => {
    const { hookBridge } = await boot({ mcpServers: {} });

    expect(hookBridge.writeMcpConfig).not.toHaveBeenCalled();
    const sessionOpts = createPtyClaudeSessionMock.mock.calls[0][0] as any;
    expect(sessionOpts.mcpConfigPath).toBeUndefined();
  });
});
