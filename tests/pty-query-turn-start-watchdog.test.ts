import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeSession = vi.hoisted(() => ({
  interrupt: vi.fn(async () => {}),
  typePrompt: vi.fn(async () => {}),
  snapshot: vi.fn(() => '❯ '),
  screen: vi.fn(() => ''),
  sendKeys: vi.fn(),
  ready: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  jsonlPath: '/tmp/metabot-fake-claude.jsonl',
  sessionId: 'sess-test',
}));

const scannerDrain = vi.hoisted(() => vi.fn((): Array<Record<string, unknown>> => []));

vi.mock('../src/engines/claude/pty/pty-session.js', () => ({
  createPtyClaudeSession: vi.fn(() => fakeSession),
}));

vi.mock('../src/engines/claude/pty/jsonl-scanner.js', () => ({
  createJsonlScanner: vi.fn(() => ({
    drainPending: scannerDrain,
    stop: vi.fn(),
    async *[Symbol.asyncIterator]() {
      // No assistant/system records: this simulates a prompt that never
      // actually started a model turn after PTY submission.
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

function createHookBridge() {
  let onTurnComplete: (() => void) | undefined;
  return {
    hookBridge: {
      writeSettings: vi.fn(async () => '/tmp/metabot-fake-settings.json'),
      onTurnComplete: vi.fn((cb: () => void) => {
        onTurnComplete = cb;
      }),
      dispose: vi.fn(async () => {}),
    },
    fireTurnComplete() {
      onTurnComplete?.();
    },
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

describe('ptyQuery turn-start watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.METABOT_CLAUDE_TURN_START_TIMEOUT_MS = '50';
    fakeSession.interrupt.mockReset();
    fakeSession.interrupt.mockImplementation(async () => {});
    fakeSession.typePrompt.mockReset();
    fakeSession.typePrompt.mockImplementation(async () => {});
    fakeSession.snapshot.mockReset();
    fakeSession.snapshot.mockImplementation(() => '❯ ');
    fakeSession.screen.mockReset();
    fakeSession.screen.mockImplementation(() => '');
    scannerDrain.mockReset();
    scannerDrain.mockImplementation(() => []);
  });

  afterEach(() => {
    delete process.env.METABOT_CLAUDE_TURN_START_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it('closes a non-slash prompt that never starts a model turn', async () => {
    const { hookBridge } = createHookBridge();
    const query = ptyQuery({
      prompt: onePromptThenWait('hello'),
      options: {
        cwd: '/tmp',
        logger,
        hookBridge: hookBridge as any,
      },
    });

    const iterator = query[Symbol.asyncIterator]();
    const next = iterator.next();

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await next;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'result',
      subtype: 'error',
      is_error: true,
    });
    expect(String((result.value as any).result)).toContain('did not start a model turn');
    expect(fakeSession.interrupt).toHaveBeenCalled();

    await query.dispose?.();
  });

  it('does not accept a historical append-log running marker as turn-start proof', async () => {
    fakeSession.snapshot.mockImplementation(() => 'old output\nEsc to interrupt\n❯ ');
    fakeSession.screen.mockImplementation(() => '❯ ');
    const { hookBridge } = createHookBridge();
    const query = ptyQuery({
      prompt: onePromptThenWait('hello'),
      options: { cwd: '/tmp', logger, hookBridge: hookBridge as any },
    });

    const next = query[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(next).resolves.toMatchObject({
      value: { type: 'result', subtype: 'error', is_error: true },
    });
    await query.dispose?.();
  });

  it('flushes a queued final assistant before the synthetic result', async () => {
    const { hookBridge, fireTurnComplete } = createHookBridge();
    scannerDrain.mockImplementationOnce(() => [
      {
        type: 'user',
        sessionId: 'sess-test',
        message: { content: 'hello' },
      },
      {
        type: 'assistant',
        sessionId: 'sess-test',
        parentToolUseID: null,
        message: {
          model: 'claude-fable-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'final answer' }],
        },
      },
    ]);
    const query = ptyQuery({
      prompt: onePromptThenWait('hello'),
      options: { cwd: '/tmp', logger, hookBridge: hookBridge as any },
    });
    const iterator = query[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(1);
    expect(fakeSession.typePrompt).toHaveBeenCalledWith('hello');
    fireTurnComplete();
    await vi.advanceTimersByTimeAsync(1);

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'user' } });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'final answer' }] },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'result' } });
    await query.dispose?.();
  });

  it('ignores a late Stop hook after the turn-start watchdog closes with error', async () => {
    const { hookBridge, fireTurnComplete } = createHookBridge();
    const query = ptyQuery({
      prompt: onePromptThenWait('hello'),
      options: {
        cwd: '/tmp',
        logger,
        hookBridge: hookBridge as any,
      },
    });

    const iterator = query[Symbol.asyncIterator]();
    const first = iterator.next();

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await first;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'result',
      subtype: 'error',
      is_error: true,
    });

    fireTurnComplete();
    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(1_000);

    let settled = false;
    second.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await query.dispose?.();
    await expect(second).resolves.toMatchObject({ done: true });
  });

  it('keeps the watchdog error authoritative when Stop fires during interrupt', async () => {
    const { hookBridge, fireTurnComplete } = createHookBridge();
    fakeSession.interrupt.mockImplementationOnce(async () => {
      fireTurnComplete();
    });
    const query = ptyQuery({
      prompt: onePromptThenWait('hello'),
      options: {
        cwd: '/tmp',
        logger,
        hookBridge: hookBridge as any,
      },
    });

    const iterator = query[Symbol.asyncIterator]();
    const first = iterator.next();

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await first;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'result',
      subtype: 'error',
      is_error: true,
    });
    expect(String((result.value as any).result)).toContain('did not start a model turn');

    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(1_000);

    let settled = false;
    second.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await query.dispose?.();
    await expect(second).resolves.toMatchObject({ done: true });
  });
});
