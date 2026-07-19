/**
 * Regression: the PTY backend must receive the MCP servers.
 *
 * `ptyOptions` in persistent-executor is built field-by-field, so any field not
 * explicitly named there is silently dropped. `mcpServers` WAS being dropped:
 * the SDK branch got it via `queryOptions`, the PTY branch got nothing. Net
 * effect on a live deployment — claude-engine bots ran with zero metabot MCP
 * tools (no worker_dispatch / remind_me), while codex-engine bots (which read
 * ~/.codex/config.toml, a path metabot does not control) worked fine. Nothing
 * failed loudly; the tools were just absent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ptyQueryMock = vi.hoisted(() => vi.fn(() => {
  async function* emptyStream() {}
  return emptyStream();
}));

vi.mock('../src/engines/claude/pty/pty-query.js', () => ({
  ptyQuery: ptyQueryMock,
}));

// Pin the resolved servers so the assertion does not depend on whatever
// ~/.claude/settings.json happens to hold on the machine running the suite.
const FAKE_SERVERS = {
  'worker-manager': {
    command: 'bash',
    args: ['-lc', 'exec node "$METABOT_HOME/dist/mcp/worker-manager-mcp.js"'],
    env: { METABOT_HOME: '/root/metabot', METABOT_BOT_NAME: 'research-pm' },
  },
};

vi.mock('../src/engines/claude/executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engines/claude/executor.js')>()),
  loadMcpServersWithApiContext: vi.fn(() => FAKE_SERVERS),
}));

import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

afterEach(() => {
  ptyQueryMock.mockClear();
});

describe('PersistentClaudeExecutor MCP servers', () => {
  it('forwards the resolved MCP servers to the PTY backend', async () => {
    const exec = new PersistentClaudeExecutor({
      cwd: '/tmp',
      logger,
      idleTimeoutMs: 0,
      backend: 'pty',
      apiContext: { botName: 'research-pm', chatId: 'oc_123' },
    });

    await exec.start();

    expect(ptyQueryMock).toHaveBeenCalledTimes(1);
    const call = ptyQueryMock.mock.calls[0][0] as any;
    expect(call.options.mcpServers).toEqual(FAKE_SERVERS);
  });
});
