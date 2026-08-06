import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import type { CompletionNotification, CompletionNotifier, TerminalCallbackEnvelope } from './types.js';

export interface HttpCompletionNotifierConfig {
  url: string;
  signingKey: KeyObject;
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
  private readonly signingKey: KeyObject;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(config: HttpCompletionNotifierConfig) {
    this.url = new URL(config.url);
    if (!['http:', 'https:'].includes(this.url.protocol)) {
      throw new Error(`Worker callback URL must use http or https: ${this.url.protocol}`);
    }
    this.signingKey = normalizePrivateKey(config.signingKey);
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async notify(notification: CompletionNotification): Promise<void> {
    if (!notification.authorizingCapability) {
      throw new Error('Worker terminal callback requires its durable authorizing capability');
    }
    const envelope: TerminalCallbackEnvelope<CompletionNotification['worker']> = {
      contract_version: 'metabot.terminal-callback.v1',
      purpose: 'worker.terminal',
      event_id: notification.eventId,
      bot_name: notification.worker.botName,
      chat_id: notification.worker.chatId,
      status: notification.worker.status,
      finished_at: notification.worker.finishedAt ?? notification.worker.createdAt,
      iat: this.now(),
      authorizing_capability: notification.authorizingCapability,
      payload: notification.worker,
    };
    const body = JSON.stringify(envelope);
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': notification.eventId,
        'x-metabot-callback-signature': signTerminalCallback(body, this.signingKey),
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

export function signTerminalCallback(body: string | Uint8Array, signingKey: KeyObject): string {
  const signature = cryptoSign(null, bodyBytes(body), normalizePrivateKey(signingKey)).toString('base64');
  return `ed25519:${signature}`;
}

export function verifyTerminalCallback(
  body: string | Uint8Array,
  signatureHeader: string,
  publicKeyValues: KeyObject | readonly KeyObject[],
): boolean {
  const match = /^ed25519:([A-Za-z0-9+/]+={0,2})$/.exec(signatureHeader);
  if (!match) return false;
  const signature = Buffer.from(match[1], 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== match[1]) return false;
  const publicKeys = Array.isArray(publicKeyValues) ? publicKeyValues : [publicKeyValues];
  return publicKeys.some((key) => cryptoVerify(null, bodyBytes(body), normalizePublicKey(key), signature));
}

export class NoopCompletionNotifier implements CompletionNotifier {
  async notify(_notification: CompletionNotification): Promise<void> {}
}

function bodyBytes(body: string | Uint8Array): Buffer {
  return typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
}

function normalizePrivateKey(value: KeyObject): KeyObject {
  const key = value;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Worker callback signing key must be an Ed25519 private key');
  }
  return key;
}

function normalizePublicKey(value: KeyObject): KeyObject {
  const key = value.type === 'public' ? value : createPublicKey(value);
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Worker callback verification key must be an Ed25519 public key');
  }
  return key;
}
