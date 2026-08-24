import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import { ArcError } from './errors.js';
import {
  normalizeArcPrincipal,
  type ArcTrustedPrincipal,
  type ArcTrustedRole,
} from './server.js';

/**
 * The only audience this server accepts.
 *
 * Every MCP server in the workspace verifies its own audience before it
 * evaluates any scope, so a capability minted for another product can never be
 * replayed here even if it was signed by the same issuer.
 */
export const ARC_CAPABILITY_AUDIENCE = 'arc' as const;

export interface ArcCapabilityClaims {
  v: 1;
  purpose: 'arc';
  /**
   * Mandatory audience. A capability minted for another product server, or
   * minted before audiences existed, is refused: the issuer and this verifier
   * moved to the audience contract together, and a legacy token stays valid for
   * up to an hour, so continuing to accept one would only hold the replay
   * window open.
   */
  aud: typeof ARC_CAPABILITY_AUDIENCE;
  role: ArcTrustedRole;
  botName: string;
  chatId: string;
  exp: number;
}

export class ArcCapabilityVerifier {
  private readonly publicKeys: KeyObject[];

  constructor(publicKeys: readonly KeyObject[], private readonly now: () => number = Date.now) {
    if (publicKeys.length < 1 || publicKeys.length > 2) {
      throw new Error('ARC capability verification requires one current and at most one previous public key');
    }
    this.publicKeys = publicKeys.map((key) => normalizePublicKey(key, 'ARC capability'));
  }

  verify(token: string): { claims: ArcCapabilityClaims; principal: ArcTrustedPrincipal } {
    const [payload, signature, extra] = typeof token === 'string' ? token.split('.') : [];
    if (
      !payload ||
      !signature ||
      extra !== undefined ||
      token.length > 4_096 ||
      !isBase64Url(payload) ||
      !isBase64Url(signature)
    ) {
      throw denied('Missing or invalid ARC capability');
    }
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (
      signatureBytes.length !== 64 ||
      signatureBytes.toString('base64url') !== signature ||
      !this.publicKeys.some((key) => cryptoVerify(null, Buffer.from(payload), key, signatureBytes))
    ) {
      throw denied('ARC capability signature is invalid');
    }
    let value: unknown;
    try {
      const decoded = Buffer.from(payload, 'base64url');
      if (decoded.length > 2_048 || decoded.toString('base64url') !== payload) throw new Error('invalid payload');
      value = JSON.parse(decoded.toString('utf8')) as unknown;
    } catch {
      throw denied('ARC capability payload is invalid');
    }
    const claims = validateClaims(value, this.now());
    const principal = normalizeArcPrincipal({ role: claims.role, botName: claims.botName, chatId: claims.chatId });
    if (principal.botName !== claims.botName || principal.chatId !== claims.chatId) {
      throw denied('ARC capability principal is not normalized');
    }
    return { claims, principal };
  }
}

/** Test/Bridge-contract helper. The ARC daemon never receives this private key. */
export function issueArcCapability(privateKeyValue: KeyObject, claims: ArcCapabilityClaims): string {
  validateClaims(claims);
  const privateKey = normalizePrivateKey(privateKeyValue, 'ARC capability');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${cryptoSign(null, Buffer.from(payload), privateKey).toString('base64url')}`;
}

export function readArcPublicKeyFile(filePath: string, label: string): KeyObject {
  return normalizePublicKey(readBoundedKeyFile(filePath, label), label);
}

export function readArcPrivateKeyFile(filePath: string, label: string): KeyObject {
  return normalizePrivateKey(readBoundedKeyFile(filePath, label), label);
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

export function assertArcDistinctKeys(capabilityPublicKeys: readonly KeyObject[], callbackPrivateKey: KeyObject): void {
  const challenge = Buffer.from('metabot-ed25519-purpose-separation-v1');
  const signature = cryptoSign(null, challenge, normalizePrivateKey(callbackPrivateKey, 'ARC callback'));
  if (capabilityPublicKeys.some((key) => cryptoVerify(null, challenge, normalizePublicKey(key, 'ARC capability'), signature))) {
    throw new Error('ARC capability and callback signing must use distinct keypairs');
  }
}

function readBoundedKeyFile(filePath: string, label: string): Buffer {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group or other access`);
  }
  const value = readFileSync(filePath);
  if (value.length < 64 || value.length > 4_096) throw new Error(`${label} must contain 64-4096 bytes`);
  return value;
}

function normalizePublicKey(value: KeyObject | string | Buffer, label: string): KeyObject {
  try {
    let key: KeyObject;
    if (typeof value === 'string' || Buffer.isBuffer(value)) key = createPublicKey(value);
    else key = value;
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 public key');
    return key;
  } catch (cause) {
    throw new Error(`${label} must contain an Ed25519 public key`, { cause });
  }
}

function normalizePrivateKey(value: KeyObject | string | Buffer, label: string): KeyObject {
  try {
    let key: KeyObject;
    if (typeof value === 'string' || Buffer.isBuffer(value)) key = createPrivateKey(value);
    else key = value;
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
    return key;
  } catch (cause) {
    throw new Error(`${label} must contain an Ed25519 private key`, { cause });
  }
}

function validateClaims(value: unknown, now?: number): ArcCapabilityClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw denied('ARC capability claims are invalid');
  const claims = value as Partial<ArcCapabilityClaims>;
  const actualKeys = Object.keys(claims).sort().join(',');
  const expectedKeys = ['aud', 'botName', 'chatId', 'exp', 'purpose', 'role', 'v'].join(',');
  if (actualKeys !== expectedKeys) {
    throw denied('ARC capability claims do not match the v3 contract');
  }
  if (claims.v !== 1 || claims.purpose !== 'arc') throw denied('ARC capability has the wrong version or purpose');
  // Checked before any role or scope evaluation, so another server's capability
  // is refused on identity alone.
  if (claims.aud !== ARC_CAPABILITY_AUDIENCE) {
    throw denied('ARC capability was minted for another audience');
  }
  if (!Number.isSafeInteger(claims.exp) || (claims.exp as number) < 1 || (now !== undefined && (claims.exp as number) <= now)) {
    throw denied('ARC capability is expired or has an invalid expiry');
  }
  const principal = normalizeArcPrincipal({
    role: claims.role as ArcTrustedRole,
    botName: claims.botName ?? '',
    chatId: claims.chatId ?? '',
  });
  if (principal.botName !== claims.botName || principal.chatId !== claims.chatId) {
    throw denied('ARC capability principal is not normalized');
  }
  return claims as ArcCapabilityClaims;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function denied(message: string): ArcError {
  return new ArcError('scope_denied', message);
}
