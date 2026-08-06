import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HttpCompletionNotifier, verifyTerminalCallback } from '../src/notifier.js';
import type { CompletionNotification } from '../src/types.js';

describe('HttpCompletionNotifier', () => {
  const signingKeys = generateKeyPairSync('ed25519');
  it('sends the stable event id as the HTTP idempotency key', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = new HttpCompletionNotifier({
      url: 'https://callback.example.test/workers',
      signingKey: signingKeys.privateKey,
      fetchImpl,
      now: () => 10,
    });

    await notifier.notify(notification());

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://callback.example.test/workers'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': 'worker:wrk-1:terminal:v1',
          'x-metabot-callback-signature': expect.stringMatching(/^ed25519:/),
        }),
      }),
    );
    const request = fetchImpl.mock.calls[0]?.[1];
    const body = request?.body as string;
    const signature = (request?.headers as Record<string, string>)['x-metabot-callback-signature'];
    expect(verifyTerminalCallback(body, signature, signingKeys.publicKey)).toBe(true);
    expect(verifyTerminalCallback(`${body} `, signature, signingKeys.publicKey)).toBe(false);
    const rotated = generateKeyPairSync('ed25519');
    expect(verifyTerminalCallback(body, signature, rotated.publicKey)).toBe(false);
    expect(verifyTerminalCallback(body, signature, [rotated.publicKey, signingKeys.publicKey])).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      contract_version: 'metabot.terminal-callback.v1',
      purpose: 'worker.terminal',
      event_id: 'worker:wrk-1:terminal:v1',
      iat: 10,
      authorizing_capability: 'signed-worker-capability',
    });
  });

  it('reports non-success callback responses with bounded detail', async () => {
    const notifier = new HttpCompletionNotifier({
      url: 'http://127.0.0.1/callback',
      signingKey: signingKeys.privateKey,
      fetchImpl: vi.fn(async () => new Response('receiver rejected event', { status: 409 })),
    });

    await expect(notifier.notify(notification())).rejects.toThrow('HTTP 409: receiver rejected event');
  });
});

function notification(): CompletionNotification {
  return {
    eventId: 'worker:wrk-1:terminal:v1',
    eventType: 'worker.terminal',
    authorizingCapability: 'signed-worker-capability',
    worker: {
      id: 'wrk-1',
      botName: 'bot-a',
      chatId: 'chat-a',
      workdir: '/tmp/work',
      engine: 'codex',
      dedupePolicy: { completedTtlMs: 1_000, retryTerminal: true },
      timeoutMs: 1_000,
      idleTimeoutMs: 500,
      recoveryPolicy: { restart: 'manual', idempotent: false },
      status: 'completed',
      launchCount: 1,
      recoveryCount: 0,
      createdAt: 1,
      finishedAt: 2,
      durationMs: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
      notificationState: 'sending',
      notificationAttempts: 1,
    },
  };
}
