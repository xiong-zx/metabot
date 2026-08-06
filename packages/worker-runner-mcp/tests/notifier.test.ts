import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  HttpCompletionNotifier,
  verifyTerminalCallback,
  WORKER_TERMINAL_CALLBACK_MAX_BYTES,
} from '../src/notifier.js';
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
      bot_name: 'bot-a',
      chat_id: 'chat-a',
      status: 'completed',
      finished_at: 2,
      iat: 10,
      authorizing_capability: 'signed-worker-capability',
      payload: {
        id: 'wrk-1',
        label: 'focused-test',
        engine: 'codex',
        status: 'completed',
        exitCode: 0,
        durationMs: 1,
      },
    });
  });

  it('keeps maximum-length worker identifiers and labels below the explicit callback bound', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = new HttpCompletionNotifier({
      url: 'https://callback.example.test/workers',
      signingKey: signingKeys.privateKey,
      fetchImpl,
    });
    const id = 'i'.repeat(200);
    const label = '界'.repeat(200);

    await notifier.notify({
      ...notification(),
      eventId: `worker:${id}:terminal:v1`,
      botName: 'b'.repeat(200),
      chatId: 'c'.repeat(500),
      worker: { ...notification().worker, id, label },
    });

    const body = fetchImpl.mock.calls[0]?.[1]?.body as string;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(WORKER_TERMINAL_CALLBACK_MAX_BYTES);
    expect(JSON.parse(body).payload).toEqual({
      id,
      label,
      engine: 'codex',
      status: 'completed',
      exitCode: 0,
      durationMs: 1,
    });
  });

  it('fails closed before HTTP when a future envelope exceeds the callback bound', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = new HttpCompletionNotifier({
      url: 'https://callback.example.test/workers',
      signingKey: signingKeys.privateKey,
      fetchImpl,
    });

    await expect(
      notifier.notify({
        ...notification(),
        authorizingCapability: 'x'.repeat(WORKER_TERMINAL_CALLBACK_MAX_BYTES),
      }),
    ).rejects.toThrow(`exceeds ${WORKER_TERMINAL_CALLBACK_MAX_BYTES} bytes`);
    expect(fetchImpl).not.toHaveBeenCalled();
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
    botName: 'bot-a',
    chatId: 'chat-a',
    finishedAt: 2,
    authorizingCapability: 'signed-worker-capability',
    worker: {
      id: 'wrk-1',
      label: 'focused-test',
      engine: 'codex',
      status: 'completed',
      exitCode: 0,
      durationMs: 1,
    },
  };
}
