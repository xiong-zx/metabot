import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { TrustedPrincipal, TrustedPrincipalRole } from './types.js';
import { normalizeTrustedPrincipal } from './service.js';
import { WorkerRunnerError } from './types.js';

export const LOCAL_CAPABILITY_VERSION = 1 as const;
export type LocalCapabilityPurpose = 'worker' | 'arc';

export interface LocalCapabilityClaims {
  v: typeof LOCAL_CAPABILITY_VERSION;
  purpose: LocalCapabilityPurpose;
  role: TrustedPrincipalRole;
  botName: string;
  chatId: string;
  exp: number;
}

/** Ed25519 verifier for the frozen Phase B v2.1 connection capability. */
export class LocalCapabilityVerifier {
  private readonly publicKeys: KeyObject[];

  constructor(
    publicKeys: readonly KeyObject[],
    readonly purpose: LocalCapabilityPurpose,
    private readonly now: () => number = Date.now,
  ) {
    if (publicKeys.length < 1 || publicKeys.length > 2) {
      throw new Error('Capability verification requires one current and at most one previous public key');
    }
    this.publicKeys = publicKeys.map((key) => normalizePublicKey(key, `${purpose} capability`));
  }

  verify(token: string): { claims: LocalCapabilityClaims; principal: TrustedPrincipal } {
    const [payload, signature, extra] = typeof token === 'string' ? token.split('.') : [];
    if (
      !payload ||
      !signature ||
      extra !== undefined ||
      token.length > 4_096 ||
      !isBase64Url(payload) ||
      !isBase64Url(signature)
    ) {
      throw forbidden('Missing or invalid local capability');
    }
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (
      signatureBytes.length !== 64 ||
      signatureBytes.toString('base64url') !== signature ||
      !this.publicKeys.some((key) => cryptoVerify(null, Buffer.from(payload), key, signatureBytes))
    ) {
      throw forbidden('Local capability signature is invalid');
    }

    let value: unknown;
    try {
      const decoded = Buffer.from(payload, 'base64url');
      if (decoded.length > 2_048 || decoded.toString('base64url') !== payload) throw new Error('invalid payload');
      value = JSON.parse(decoded.toString('utf8')) as unknown;
    } catch {
      throw forbidden('Local capability payload is invalid');
    }
    const claims = validateClaims(value, this.purpose, this.now());
    const principal = normalizeTrustedPrincipal({
      role: claims.role,
      botName: claims.botName,
      chatId: claims.chatId,
    });
    if (principal.botName !== claims.botName || principal.chatId !== claims.chatId) {
      throw forbidden('Local capability principal is not normalized');
    }
    return { claims, principal };
  }
}

/** Test/Bridge-contract helper. Daemon production code never receives this private key. */
export function issueLocalCapability(
  privateKeyValue: KeyObject,
  claims: LocalCapabilityClaims,
): string {
  validateClaims(claims, claims.purpose);
  const privateKey = normalizePrivateKey(privateKeyValue, `${claims.purpose} capability`);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = cryptoSign(null, Buffer.from(payload), privateKey).toString('base64url');
  return `${payload}.${signature}`;
}

export function readPublicKeyFile(filePath: string, label: string): KeyObject {
  return normalizePublicKey(readBoundedKeyFile(filePath, label), label);
}

export function readPrivateKeyFile(filePath: string, label: string): KeyObject {
  return normalizePrivateKey(readBoundedKeyFile(filePath, label), label);
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

export function assertDistinctKeys(
  capabilityPublicKeys: readonly KeyObject[],
  callbackPrivateKey: KeyObject,
  labels: [string, string],
): void {
  const challenge = Buffer.from('metabot-ed25519-purpose-separation-v1');
  const signature = cryptoSign(null, challenge, normalizePrivateKey(callbackPrivateKey, labels[1]));
  if (capabilityPublicKeys.some((key) => cryptoVerify(null, challenge, normalizePublicKey(key, labels[0]), signature))) {
    throw new Error(`${labels[0]} and ${labels[1]} must use distinct keypairs`);
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

function validateClaims(value: unknown, purpose: LocalCapabilityPurpose, now?: number): LocalCapabilityClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw forbidden('Local capability claims are invalid');
  const claims = value as Partial<LocalCapabilityClaims>;
  const expectedKeys = ['botName', 'chatId', 'exp', 'purpose', 'role', 'v'];
  if (Object.keys(claims).sort().join(',') !== expectedKeys.join(',')) {
    throw forbidden('Local capability claims do not match the v2.1 contract');
  }
  if (claims.v !== LOCAL_CAPABILITY_VERSION || claims.purpose !== purpose) {
    throw forbidden('Local capability has the wrong version or purpose');
  }
  if (!Number.isSafeInteger(claims.exp) || (claims.exp as number) < 1 || (now !== undefined && (claims.exp as number) <= now)) {
    throw forbidden('Local capability is expired or has an invalid expiry');
  }
  const principal = normalizeTrustedPrincipal({
    role: claims.role as TrustedPrincipalRole,
    botName: claims.botName ?? '',
    chatId: claims.chatId ?? '',
  });
  if (principal.botName !== claims.botName || principal.chatId !== claims.chatId) {
    throw forbidden('Local capability principal is not normalized');
  }
  return claims as LocalCapabilityClaims;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function forbidden(message: string): WorkerRunnerError {
  return new WorkerRunnerError(message, 'FORBIDDEN');
}
