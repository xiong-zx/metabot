import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { TrustedPrincipal, TrustedPrincipalRole } from './types.js';
import { normalizeTrustedPrincipal } from './service.js';
import { WorkerRunnerError } from './types.js';

export const LOCAL_CAPABILITY_VERSION = 1 as const;
export type LocalCapabilityPurpose = 'worker-runner' | 'arc';

export interface LocalCapabilityClaims {
  v: typeof LOCAL_CAPABILITY_VERSION;
  purpose: LocalCapabilityPurpose;
  role: TrustedPrincipalRole;
  bot_name: string;
  chat_id: string;
  issued_at: number;
  expires_at: number;
  nonce?: string;
}

export class LocalCapabilityAuthority {
  private readonly key: Buffer;

  constructor(
    key: Uint8Array,
    readonly purpose: LocalCapabilityPurpose,
    private readonly now: () => number = Date.now,
  ) {
    this.key = normalizeKey(key, `${purpose} capability`);
  }

  issue(
    principal: TrustedPrincipal,
    options: { ttlMs: number; nonce?: string },
  ): string {
    const normalized = normalizeTrustedPrincipal(principal);
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error('Capability ttlMs must be an integer between 1 and 86400000');
    }
    const issuedAt = this.now();
    const claims: LocalCapabilityClaims = {
      v: LOCAL_CAPABILITY_VERSION,
      purpose: this.purpose,
      role: normalized.role,
      bot_name: normalized.botName,
      chat_id: normalized.chatId,
      issued_at: issuedAt,
      expires_at: issuedAt + options.ttlMs,
      ...(options.nonce ? { nonce: normalizeBounded(options.nonce, 'nonce', 200) } : {}),
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${encoded}.${this.mac(encoded)}`;
  }

  verify(token: string): { claims: LocalCapabilityClaims; principal: TrustedPrincipal } {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4_096) {
      throw forbidden('Missing or invalid local capability');
    }
    const pieces = token.split('.');
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw forbidden('Malformed local capability');
    const [encoded, suppliedMac] = pieces as [string, string];
    const expectedMac = this.mac(encoded);
    const expected = Buffer.from(expectedMac);
    const supplied = Buffer.from(suppliedMac);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw forbidden('Local capability signature is invalid');
    }

    let claims: LocalCapabilityClaims;
    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      if (decoded.length > 2_048) throw new Error('payload too large');
      claims = JSON.parse(decoded) as LocalCapabilityClaims;
    } catch {
      throw forbidden('Local capability payload is invalid');
    }
    if (claims.v !== LOCAL_CAPABILITY_VERSION || claims.purpose !== this.purpose) {
      throw forbidden('Local capability has the wrong version or purpose');
    }
    if (!Number.isSafeInteger(claims.issued_at) || !Number.isSafeInteger(claims.expires_at)) {
      throw forbidden('Local capability timestamps are invalid');
    }
    const now = this.now();
    if (claims.issued_at > now + 30_000 || claims.expires_at <= now || claims.expires_at <= claims.issued_at) {
      throw forbidden('Local capability is expired or not yet valid');
    }
    const principal = normalizeTrustedPrincipal({
      role: claims.role,
      botName: claims.bot_name,
      chatId: claims.chat_id,
    });
    return { claims, principal };
  }

  private mac(encoded: string): string {
    return createHmac('sha256', this.key)
      .update(`metabot.local-capability.v1\0${this.purpose}\0${encoded}`)
      .digest('base64url');
  }
}

export function readSecretFile(filePath: string, label: string): Buffer {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group or other access`);
  }
  const value = readFileSync(filePath);
  if (value.length < 32) throw new Error(`${label} must contain at least 32 bytes`);
  if (value.length > 4_096) throw new Error(`${label} must contain at most 4096 bytes`);
  return value;
}

export function readCapabilityTokenFile(filePath: string, label: string): string {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group or other access`);
  }
  const token = readFileSync(filePath, 'utf8').trim();
  if (token.length < 20 || token.length > 4_096 || token.includes('\0')) {
    throw new Error(`${label} does not contain a bounded capability token`);
  }
  return token;
}

export function assertDistinctKeys(first: Uint8Array, second: Uint8Array, labels: [string, string]): void {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  if (a.length === b.length && timingSafeEqual(a, b)) {
    throw new Error(`${labels[0]} and ${labels[1]} must use distinct keys`);
  }
}

function normalizeKey(value: Uint8Array, label: string): Buffer {
  const key = Buffer.from(value);
  if (key.length < 32) throw new Error(`${label} key must contain at least 32 bytes`);
  return key;
}

function normalizeBounded(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${name} must contain 1-${max} characters`);
  return normalized;
}

function forbidden(message: string): WorkerRunnerError {
  return new WorkerRunnerError(message, 'FORBIDDEN');
}
