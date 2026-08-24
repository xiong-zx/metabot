import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';
import { sendFinalCardWithRetry } from '../src/bridge/final-delivery.js';
import type { CardUpdateOutcome, IMessageSender } from '../src/bridge/message-sender.interface.js';
import type { CardState } from '../src/types.js';

afterEach(() => {
  vi.useRealTimers();
});

const state: CardState = {
  status: 'complete',
  userPrompt: 'show todos',
  responseText: 'Complete result',
  toolCalls: [],
};

function makeHarness(outcomes: CardUpdateOutcome[], replacementMessageId?: string) {
  const updateCard = vi.fn(async () => outcomes.shift() ?? { ok: true });
  const sendCard = vi.fn(async () => replacementMessageId);
  const sendText = vi.fn(async () => {});
  const sender = {
    updateCard,
    sendCard,
    sendText,
    sendTextNotice: vi.fn(),
    sendImageFile: vi.fn(async () => true),
    sendLocalFile: vi.fn(async () => true),
    downloadImage: vi.fn(async () => false),
    downloadFile: vi.fn(async () => false),
  } as unknown as IMessageSender;
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as any;
  const sessionManager = {
    addUsage: vi.fn(),
    getSession: vi.fn(() => ({ cumulativeCostUsd: 0 })),
  } as any;
  return { sender, updateCard, sendCard, sendText, logger, sessionManager };
}

function deliver(harness: ReturnType<typeof makeHarness>, deliveryState: CardState = state) {
  return sendFinalCardWithRetry({
    sender: harness.sender,
    config: { name: 'test', engine: 'claude' } as BotConfigBase,
    logger: harness.logger,
    sessionManager: harness.sessionManager,
    messageId: 'om_running',
    state: { ...deliveryState },
    chatId: 'oc_test',
  });
}

describe('sendFinalCardWithRetry', () => {
  it('does not retry a structural 4xx payload and terminally updates the original card with safe rendering', async () => {
    const harness = makeHarness([
      { ok: false, category: 'payload', retryable: false, httpStatus: 400, providerCode: 230099 },
      { ok: true },
    ]);

    await expect(deliver(harness)).resolves.toMatchObject({
      status: 'updated_safe',
      normalAttempts: 1,
      originalCardTerminal: true,
    });
    expect(harness.updateCard).toHaveBeenCalledTimes(2);
    expect(harness.updateCard.mock.calls[1][2]).toEqual({ safeTerminal: true });
    expect(harness.sendCard).not.toHaveBeenCalled();
    expect(harness.sendText).not.toHaveBeenCalled();
  });

  it('retries a transient 5xx with bounded backoff', async () => {
    vi.useFakeTimers();
    const harness = makeHarness([
      { ok: false, category: 'transient', retryable: true, httpStatus: 504 },
      { ok: true },
    ]);

    const pending = deliver(harness);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({
      status: 'updated',
      normalAttempts: 2,
      originalCardTerminal: true,
    });
    expect(harness.updateCard).toHaveBeenCalledTimes(2);
  });

  it('sends a complete safe card that explicitly supersedes an unpatchable Running card', async () => {
    const failure = { ok: false, category: 'payload', retryable: false, httpStatus: 400 } as const;
    const harness = makeHarness([failure, failure], 'om_replacement');

    await expect(deliver(harness)).resolves.toMatchObject({
      status: 'superseded',
      originalCardTerminal: false,
      replacementMessageId: 'om_replacement',
    });
    expect(harness.sendCard).toHaveBeenCalledTimes(1);
    expect(harness.sendCard.mock.calls[0][1].responseText).toContain('supersedes an earlier Running card');
    expect(harness.sendCard.mock.calls[0][1].responseText).toContain('Complete result');
    expect(harness.sendCard.mock.calls[0][2]).toEqual({ safeTerminal: true });
    expect(harness.sendText).not.toHaveBeenCalled();
  });

  it('uses ordered text chunks as the last fallback without truncating the result', async () => {
    const failure = { ok: false, category: 'payload', retryable: false, httpStatus: 400 } as const;
    const harness = makeHarness([failure, failure]);
    const longResult = `${'x'.repeat(5000)}END-MARKER`;

    await expect(deliver(harness, { ...state, responseText: longResult })).resolves.toMatchObject({
      status: 'text_fallback',
      originalCardTerminal: false,
    });
    expect(harness.sendText.mock.calls.length).toBeGreaterThan(1);
    const joined = harness.sendText.mock.calls.map(([_, text]) => text).join('');
    expect(joined).toContain('END-MARKER');
    expect(joined).toContain('supersedes the earlier Running card');
  });

  it('reports reconciliation when the platform confirms that the last text fallback failed', async () => {
    const failure = { ok: false, category: 'payload', retryable: false, httpStatus: 400 } as const;
    const harness = makeHarness([failure, failure]);
    harness.sendText.mockResolvedValueOnce(false);

    await expect(deliver(harness)).resolves.toMatchObject({
      status: 'reconciliation_required',
      originalCardTerminal: false,
    });
  });
});
