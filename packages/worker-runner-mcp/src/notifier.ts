import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CompletionNotification, CompletionNotifier, TerminalCallbackEnvelope } from './types.js';

export interface HttpCompletionNotifierConfig {
  url: string;
  signingKey: Uint8Array;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Small injected callback adapter. The stable event id is sent both in the
 * body and as Idempotency-Key so a receiver can safely collapse retries after
 * a process crash between HTTP success and the local SQLite commit.
 */
export class HttpCompletionNotifier implements CompletionNotifier {
  private readonly url: URL;
  private readonly signingKey: Buffer;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(config: HttpCompletionNotifierConfig) {
    this.url = new URL(config.url);
    if (!['http:', 'https:'].includes(this.url.protocol)) {
      throw new Error(`Worker callback URL must use http or https: ${this.url.protocol}`);
    }
    this.signingKey = Buffer.from(config.signingKey);
    if (this.signingKey.length < 32) throw new Error('Worker callback signing key must contain at least 32 bytes');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async notify(notification: CompletionNotification): Promise<void> {
    const envelope: TerminalCallbackEnvelope<CompletionNotification['worker']> = {
      contract_version: 'metabot.terminal-callback.v1',
      purpose: 'worker.terminal',
      event_id: notification.eventId,
      bot_name: notification.worker.botName,
      chat_id: notification.worker.chatId,
      status: notification.worker.status,
      finished_at: notification.worker.finishedAt ?? notification.worker.createdAt,
      iat: this.now(),
      payload: notification.worker,
    };
    const body = JSON.stringify(envelope);
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': notification.eventId,
        'x-metabot-callback-signature': signTerminalCallback(body, this.signingKey, 'worker.terminal'),
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`Worker completion callback failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  }
}

export function signTerminalCallback(
  body: string | Uint8Array,
  signingKey: Uint8Array,
  purpose: TerminalCallbackEnvelope['purpose'],
): string {
  const key = Buffer.from(signingKey);
  if (key.length < 32) throw new Error('Terminal callback signing key must contain at least 32 bytes');
  const signature = createHmac('sha256', key)
    .update(`metabot.terminal-callback.v1\0${purpose}\0`)
    .update(body)
    .digest('base64url');
  return `v1=${signature}`;
}

export function verifyTerminalCallback(
  body: string | Uint8Array,
  signatureHeader: string,
  signingKey: Uint8Array,
  purpose: TerminalCallbackEnvelope['purpose'],
): boolean {
  const expected = Buffer.from(signTerminalCallback(body, signingKey, purpose));
  const supplied = Buffer.from(signatureHeader);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export class NoopCompletionNotifier implements CompletionNotifier {
  async notify(_notification: CompletionNotification): Promise<void> {}
}
