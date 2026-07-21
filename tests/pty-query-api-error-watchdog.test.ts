import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Footer claude renders while the model is streaming. */
const RUNNING_FOOTER = '✽ Thinking… (esc to interrupt)';
/** Footer once claude is back at the prompt. */
const IDLE_FOOTER = '❯ ';
/** The line claude prints when it gives up on the upstream request. */
const ABORT_LINE = 'API Error: Connection closed mid-response.';

/**
 * The two views the watchdog reads. `ring` is the append-log of everything the
 * PTY ever emitted (spinner frames included, which is why it is useless for
 * liveness); `screen` is the rendered viewport, i.e. what is on screen NOW.
 */
let ring = '';
let screen = '';

function setScreen(body: string, footer: string) {
  screen = `${body}\n${footer}`;
  ring += `${body}\n${footer}\n`;
}

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

const scannerDrain = vi.hoisted(() => vi.fn((): Array<Record<string, unknown>> => []));

vi.mock('../src/engines/claude/pty/pty-session.js', () => ({
  createPtyClaudeSession: vi.fn(() => fakeSession),
}));

vi.mock('../src/engines/claude/pty/jsonl-scanner.js', () => ({
  createJsonlScanner: vi.fn(() => ({
    drainPending: scannerDrain,
    stop: vi.fn(),
    async *[Symbol.asyncIterator]() {
      // Aborted mid-stream: claude never writes a terminating record.
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

function start() {
  const { hookBridge, fireTurnComplete } = createHookBridge();
  const query = ptyQuery({
    prompt: onePromptThenWait('hello'),
    options: { cwd: '/tmp', logger, hookBridge: hookBridge as any },
  });
  return { query, iterator: query[Symbol.asyncIterator](), fireTurnComplete };
}

async function expectStillOpen(pending: Promise<unknown>) {
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe('ptyQuery API-error watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.METABOT_CLAUDE_API_ERROR_IDLE_MS = '3000';
    ring = '';
    screen = '';
    setScreen('working on it', RUNNING_FOOTER);
    fakeSession.snapshot.mockReset();
    fakeSession.snapshot.mockImplementation(() => ring);
    fakeSession.screen.mockReset();
    fakeSession.screen.mockImplementation(() => screen);
    fakeSession.typePrompt.mockReset();
    fakeSession.typePrompt.mockImplementation(async () => {});
    fakeSession.interrupt.mockReset();
    fakeSession.interrupt.mockImplementation(async () => {});
    scannerDrain.mockReset();
    scannerDrain.mockImplementation(() => []);
  });

  afterEach(() => {
    delete process.env.METABOT_CLAUDE_API_ERROR_IDLE_MS;
    vi.useRealTimers();
  });

  it('closes a turn claude aborted mid-stream without firing Stop', async () => {
    const { query, iterator } = start();
    const next = iterator.next();

    await vi.advanceTimersByTimeAsync(2_000);
    // Claude gives up on the upstream request and drops back to the prompt. The
    // ring still carries the spinner frames from a second ago — the watchdog
    // must not be fooled by them.
    setScreen(ABORT_LINE, IDLE_FOOTER);
    await vi.advanceTimersByTimeAsync(6_000);

    const result = await next;
    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({ type: 'result', subtype: 'error', is_error: true });
    expect(String((result.value as any).result)).toContain(ABORT_LINE);
    expect(String((result.value as any).result)).toContain('aborted this turn mid-response');

    await query.dispose?.();
  });

  it('holds the turn open while the model is still streaming', async () => {
    const { query, iterator } = start();
    const next = iterator.next();

    // Error line on screen but "esc to interrupt" is still up: claude is
    // retrying, not dead. Closing here would truncate a live answer.
    setScreen(ABORT_LINE, RUNNING_FOOTER);
    await vi.advanceTimersByTimeAsync(30_000);

    await expectStillOpen(next);
    await query.dispose?.();
    await expect(next).resolves.toMatchObject({ done: true });
  });

  it('ignores an API error line that was already on screen before the prompt', async () => {
    // A previous turn's error, still in the ring, must not close this turn.
    setScreen(ABORT_LINE, RUNNING_FOOTER);
    const { query, iterator } = start();
    const next = iterator.next();

    await vi.advanceTimersByTimeAsync(2_000);
    setScreen('all done', IDLE_FOOTER); // idle, but no NEW error line
    await vi.advanceTimersByTimeAsync(30_000);

    await expectStillOpen(next);
    await query.dispose?.();
    await expect(next).resolves.toMatchObject({ done: true });
  });

  it('lets the Stop hook win when the answer merely quotes an API error', async () => {
    const { query, iterator, fireTurnComplete } = start();
    const next = iterator.next();

    // A turn *about* this bug prints the error text inside its answer, then
    // completes normally. The quote is not at the start of a line, and Stop
    // lands long before the idle window elapses.
    await vi.advanceTimersByTimeAsync(1_000);
    setScreen(`The card wedged because of "${ABORT_LINE}"`, IDLE_FOOTER);
    scannerDrain.mockImplementationOnce(() => [
      { type: 'user', message: { content: 'hello' } },
      {
        type: 'assistant',
        parentToolUseID: null,
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'completed normally' }],
        },
      },
    ]);
    fireTurnComplete();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(next).resolves.toMatchObject({ value: { type: 'user' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'assistant' } });
    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({ type: 'result', subtype: 'success', is_error: false });

    // The watchdog must not follow up with a second, contradictory result.
    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(30_000);
    await expectStillOpen(second);

    await query.dispose?.();
    await expect(second).resolves.toMatchObject({ done: true });
  });
});
