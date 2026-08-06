import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import { ArcError } from './errors.js';
import {
  normalizeArcPrincipal,
  type ArcTrustedPrincipal,
  type ArcTrustedRole,
} from './server.js';

interface ArcCapabilityClaims {
  v: 1;
  purpose: 'arc';
  role: ArcTrustedRole;
  bot_name: string;
  chat_id: string;
  issued_at: number;
  expires_at: number;
  nonce?: string;
}

export class ArcCapabilityAuthority {
  private readonly key: Buffer;

  constructor(key: Uint8Array, private readonly now: () => number = Date.now) {
    this.key = Buffer.from(key);
    if (this.key.length < 32) throw new Error('ARC capability key must contain at least 32 bytes');
  }

  issue(principal: ArcTrustedPrincipal, options: { ttlMs: number; nonce?: string }): string {
    const normalized = normalizeArcPrincipal(principal);
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error('Capability ttlMs must be an integer between 1 and 86400000');
    }
    const issuedAt = this.now();
    const claims: ArcCapabilityClaims = {
      v: 1,
      purpose: 'arc',
      role: normalized.role,
      bot_name: normalized.botName,
      chat_id: normalized.chatId,
      issued_at: issuedAt,
      expires_at: issuedAt + options.ttlMs,
      ...(options.nonce ? { nonce: bounded(options.nonce, 'nonce', 200) } : {}),
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${encoded}.${this.mac(encoded)}`;
  }

  verify(token: string): { claims: ArcCapabilityClaims; principal: ArcTrustedPrincipal } {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4_096) {
      throw denied('Missing or invalid ARC capability');
    }
    const pieces = token.split('.');
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw denied('Malformed ARC capability');
    const [encoded, suppliedMac] = pieces as [string, string];
    const expected = Buffer.from(this.mac(encoded));
    const supplied = Buffer.from(suppliedMac);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw denied('ARC capability signature is invalid');
    }
    let claims: ArcCapabilityClaims;
    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      if (decoded.length > 2_048) throw new Error('payload too large');
      claims = JSON.parse(decoded) as ArcCapabilityClaims;
    } catch {
      throw denied('ARC capability payload is invalid');
    }
    if (claims.v !== 1 || claims.purpose !== 'arc') throw denied('ARC capability has the wrong version or purpose');
    if (!Number.isSafeInteger(claims.issued_at) || !Number.isSafeInteger(claims.expires_at)) {
      throw denied('ARC capability timestamps are invalid');
    }
    const now = this.now();
    if (claims.issued_at > now + 30_000 || claims.expires_at <= now || claims.expires_at <= claims.issued_at) {
      throw denied('ARC capability is expired or not yet valid');
    }
    const principal = normalizeArcPrincipal({
      role: claims.role,
      botName: claims.bot_name,
      chatId: claims.chat_id,
    });
    return { claims, principal };
  }

  private mac(encoded: string): string {
    return createHmac('sha256', this.key).update(`metabot.local-capability.v1\0arc\0${encoded}`).digest('base64url');
  }
}

export function readArcSecretFile(filePath: string, label: string): Buffer {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group or other access`);
  }
  const value = readFileSync(filePath);
  if (value.length < 32 || value.length > 4_096) throw new Error(`${label} must contain 32-4096 bytes`);
  return value;
}

export function readArcCapabilityFile(filePath: string): string {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ARC capability file must be regular and non-symlink');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('ARC capability file permissions must not grant group or other access');
  }
  const value = readFileSync(filePath, 'utf8').trim();
  if (value.length < 20 || value.length > 4_096 || value.includes('\0')) {
    throw new Error('ARC capability file is invalid');
  }
  return value;
}

export function assertArcDistinctKeys(a: Uint8Array, b: Uint8Array): void {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length === right.length && timingSafeEqual(left, right)) {
    throw new Error('ARC capability and callback signing keys must be distinct');
  }
}

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must contain 1-${max} characters`);
  return normalized;
}

function denied(message: string): ArcError {
  return new ArcError('scope_denied', message);
}
