import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

import type { ArcRunRecord } from './contract.js';
import type { ArcRunStore } from './run-store.js';

export interface ArcTerminalCallbackEnvelope {
  contract_version: 'metabot.terminal-callback.v1';
  purpose: 'arc.terminal';
  event_id: string;
  bot_name: string;
  chat_id: string;
  status: ArcRunRecord['status'];
  finished_at: number;
  iat: number;
  authorizing_capability: string;
  payload: {
    run_id: string;
    project_id: string;
    project_root: string;
    artifact_path: string;
    output_status: ArcRunRecord['output_status'];
    error: ArcRunRecord['error'];
  };
}

export interface ArcTerminalNotifier {
  notify(envelope: ArcTerminalCallbackEnvelope): Promise<void>;
}

export interface HttpArcTerminalNotifierOptions {
  url: string;
  signingKey: KeyObject;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpArcTerminalNotifier implements ArcTerminalNotifier {
  private readonly url: URL;
  private readonly key: KeyObject;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpArcTerminalNotifierOptions) {
    this.url = new URL(options.url);
    if (!['http:', 'https:'].includes(this.url.protocol)) throw new Error('ARC callback URL must use HTTP or HTTPS');
    this.key = normalizePrivateKey(options.signingKey);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notify(envelope: ArcTerminalCallbackEnvelope): Promise<void> {
    const body = JSON.stringify(envelope);
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': envelope.event_id,
        'x-metabot-callback-signature': signArcTerminalCallback(body, this.key),
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`ARC terminal callback failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  }
}

export interface ArcTerminalNotifierServiceOptions {
  pollIntervalMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

/** Durable terminal outbox; it observes store state and is not inferred by the coordinator. */
export class ArcTerminalNotifierService {
  private readonly pollIntervalMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly store: ArcRunStore,
    private readonly notifier: ArcTerminalNotifier,
    options: ArcTerminalNotifierServiceOptions = {},
  ) {
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 250, 'pollIntervalMs', 10, 60_000);
    this.retryInitialMs = boundedInteger(options.retryInitialMs ?? 1_000, 'retryInitialMs', 1, 60_000);
    this.retryMaxMs = boundedInteger(options.retryMaxMs ?? 60_000, 'retryMaxMs', 1, 3_600_000);
    if (this.retryInitialMs > this.retryMaxMs) throw new Error('retryInitialMs cannot exceed retryMaxMs');
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.store.resetInterruptedNotifications(this.now());
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const due of this.store.listDueTerminalNotifications(this.now())) {
        const run = this.store.claimTerminalNotification(due.run_id, this.now());
        if (!run?.originator || !run.finished_at) continue;
        try {
          const authorizingCapability = this.store.getAuthorizingCapability(run.run_id);
          if (!authorizingCapability) throw new Error('ARC terminal callback requires its durable authorizing capability');
          await this.notifier.notify(terminalEnvelope(run, this.now(), authorizingCapability));
          this.store.markNotificationDelivered(run.run_id, this.now());
        } catch (error) {
          const attempts = this.store.getNotificationState(run.run_id).attempts;
          const delay = Math.min(this.retryInitialMs * 2 ** Math.min(Math.max(attempts - 1, 0), 20), this.retryMaxMs);
          this.store.markNotificationFailed(
            run.run_id,
            error instanceof Error ? error.message : String(error),
            this.now() + delay,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

export function terminalEnvelope(
  run: ArcRunRecord,
  iat: number,
  authorizingCapability: string,
): ArcTerminalCallbackEnvelope {
  if (!run.originator || !run.finished_at) throw new Error('Terminal ARC callback requires origin and finish time');
  const finishedAt = Date.parse(run.finished_at);
  if (!Number.isSafeInteger(finishedAt)) throw new Error('Terminal ARC callback finish time is invalid');
  if (!authorizingCapability) throw new Error('Terminal ARC callback requires an authorizing capability');
  return {
    contract_version: 'metabot.terminal-callback.v1',
    purpose: 'arc.terminal',
    event_id: `arc:${run.run_id}:terminal:v1`,
    bot_name: run.originator.bot_name,
    chat_id: run.originator.chat_id,
    status: run.status,
    finished_at: finishedAt,
    iat,
    authorizing_capability: authorizingCapability,
    payload: {
      run_id: run.run_id,
      project_id: run.project_id,
      project_root: run.project_root,
      artifact_path: run.artifact_path,
      output_status: run.output_status,
      error: run.error,
    },
  };
}

export function signArcTerminalCallback(body: string | Uint8Array, keyValue: KeyObject): string {
  return `ed25519:${cryptoSign(null, bodyBytes(body), normalizePrivateKey(keyValue)).toString('base64')}`;
}

export function verifyArcTerminalCallback(
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

function bodyBytes(body: string | Uint8Array): Buffer {
  return typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
}

function normalizePrivateKey(value: KeyObject): KeyObject {
  const key = value;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('ARC callback signing key must be an Ed25519 private key');
  }
  return key;
}

function normalizePublicKey(value: KeyObject): KeyObject {
  const key = value.type === 'public' ? value : createPublicKey(value);
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('ARC callback verification key must be an Ed25519 public key');
  }
  return key;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
