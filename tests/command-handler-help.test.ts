import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandHandler } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';

/**
 * /help is the single user-discoverable entry point for "what can this bot
 * do?". When new top-level commands ship — particularly Claude Code
 * built-ins that pass through (/goal, /background) — /help must mention
 * them or users have no way to find them short of reading the source.
 *
 * Test guards against the recurring regression: a major feature ships but
 * is invisible because /help wasn't updated. Treat a missing entry here
 * as a release blocker, not a doc oversight.
 */

interface RecordedNotice {
  chatId: string;
  title:  string;
  content: string;
  color?: string;
}

function buildHandler(workdir = '/tmp') {
  const notices: RecordedNotice[] = [];
  const session = {
    sessionId: undefined,
    workingDirectory: '/tmp',
    lastUsed: Date.now(),
    cumulativeTokens: 0,
    cumulativeCostUsd: 0,
    cumulativeDurationMs: 0,
  };
  const sender = {
    sendCard:        async () => undefined,
    updateCard:      async () => true,
    sendTextNotice:  async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText:        async () => {},
    sendImageFile:   async () => true,
    sendLocalFile:   async () => true,
    downloadImage:   async () => true,
    downloadFile:    async () => true,
  };
  const audit = { log: () => {} } as any;
  const handler = new CommandHandler(
    {
      name: 'test-bot',
      engine: 'claude',
      claude: { model: 'claude-fable-5', defaultWorkingDirectory: workdir },
    } as any,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender as any,
    {
      getSession: () => session,
      setSessionEngine: () => {},
      setSessionModel: (_chatId: string, model: string | undefined) => { session.model = model; },
    } as any,
    {} as any, // memoryClient — not touched
    audit,
    () => undefined, // getRunningTask
    () => {},        // stopTask
    () => 0,         // clearQueue — /help doesn't touch the queue
    async () => {},  // releaseExecutor
    () => [],        // listSessions
    async () => {},  // applyResume
    async () => {},  // runBytheway
  );
  return { handler, notices };
}

function helpMessage(): IncomingMessage {
  return {
    messageId:  'm1',
    chatId:     'c1',
    chatType:   'p2p',
    userId:     'u1',
    text:       '/help',
    timestamp:  Date.now(),
    isBotMentioned: true,
  } as IncomingMessage;
}

describe('CommandHandler /help', () => {
  it('returns true and sends a notice on /help', async () => {
    const { handler, notices } = buildHandler();
    const handled = await handler.handle(helpMessage());
    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Help');
  });

  it('lists every bot-side command users can run', async () => {
    const { handler, notices } = buildHandler();
    await handler.handle(helpMessage());
    const body = notices[0].content;
    for (const cmd of ['/reset', '/stop', '/status', '/model', '/resume', '/cat', '/ls', '/memory', '/sync', '/help']) {
      expect(body, `help body missing ${cmd}`).toContain(cmd);
    }
  });

  // Regression — /goal and /background are Claude Code built-ins that pass
  // through to the agent. They are the user-visible surface for Agent Teams
  // continuity and background tasks; not mentioning them = users never find
  // them. Do not delete this assertion.
  it('mentions Claude Code passthrough commands /goal and /background (regression)', async () => {
    const { handler, notices } = buildHandler();
    await handler.handle(helpMessage());
    const body = notices[0].content;
    expect(body, '/goal must appear in /help').toContain('/goal');
    expect(body, '/background must appear in /help').toContain('/background');
  });

  it('returns false for non-slash messages so they reach the agent', async () => {
    const { handler } = buildHandler();
    const handled = await handler.handle({ ...helpMessage(), text: 'hello' });
    expect(handled).toBe(false);
  });

  it('handles /cat and /ls directly against the bot working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-command-'));
    try {
      mkdirSync(join(dir, 'subdir'));
      writeFileSync(join(dir, 'note.txt'), 'alpha\nbeta\n');
      const { handler, notices } = buildHandler(dir);

      expect(await handler.handle({ ...helpMessage(), text: '/cat note.txt 2 2' })).toBe(true);
      expect(notices.at(-1)?.title).toContain('note.txt');
      expect(notices.at(-1)?.content).toContain('2 | beta');

      expect(await handler.handle({ ...helpMessage(), text: '/ls .' })).toBe(true);
      expect(notices.at(-1)?.content).toContain('[dir]  subdir/');
      expect(notices.at(-1)?.content).toContain('[file] note.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists Fable 5 as the default Claude model option', async () => {
    const { handler, notices } = buildHandler();
    await handler.handle({ ...helpMessage(), text: '/model list' });
    const body = notices[0].content;
    expect(body).toContain('claude-fable-5');
    expect(body).toContain('Fable 5');
    expect(body).toContain('native 1M context');
  });
});
