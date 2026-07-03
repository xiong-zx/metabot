import { afterEach, describe, expect, it, vi } from 'vitest';

const ptyQueryMock = vi.hoisted(() => vi.fn(() => {
  async function* emptyStream() {}
  return emptyStream();
}));

vi.mock('../src/engines/claude/pty/pty-query.js', () => ({
  ptyQuery: ptyQueryMock,
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

describe('PersistentClaudeExecutor runtime env', () => {
  it('passes MetaBot bot/chat context into the PTY Claude process env', async () => {
    const exec = new PersistentClaudeExecutor({
      cwd: '/tmp',
      logger,
      idleTimeoutMs: 0,
      backend: 'pty',
      apiContext: {
        botName: 'research-pm',
        chatId: 'oc_123',
        groupId: 'group_456',
      },
    });

    await exec.start();

    expect(ptyQueryMock).toHaveBeenCalledTimes(1);
    const call = ptyQueryMock.mock.calls[0][0] as any;
    expect(call.options.env).toMatchObject({
      METABOT_BOT_NAME: 'research-pm',
      METABOT_CHAT_ID: 'oc_123',
      METABOT_GROUP_ID: 'group_456',
    });
  });
});
