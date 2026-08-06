import type { CompletionNotification, CompletionNotifier } from './types.js';

export interface HttpCompletionNotifierConfig {
  url: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Small injected callback adapter. The stable event id is sent both in the
 * body and as Idempotency-Key so a receiver can safely collapse retries after
 * a process crash between HTTP success and the local SQLite commit.
 */
export class HttpCompletionNotifier implements CompletionNotifier {
  private readonly url: URL;
  private readonly bearerToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpCompletionNotifierConfig) {
    this.url = new URL(config.url);
    if (!['http:', 'https:'].includes(this.url.protocol)) {
      throw new Error(`Worker callback URL must use http or https: ${this.url.protocol}`);
    }
    this.bearerToken = config.bearerToken;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async notify(notification: CompletionNotification): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': notification.eventId,
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`Worker completion callback failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  }
}

export class NoopCompletionNotifier implements CompletionNotifier {
  async notify(_notification: CompletionNotification): Promise<void> {}
}
