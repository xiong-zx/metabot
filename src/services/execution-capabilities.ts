import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ExecutionCapabilityPurpose = 'worker' | 'arc';
export type TerminalCallbackPurpose = 'worker.terminal' | 'arc.terminal';
export type ExecutionCapabilityRole = 'pm' | 'user';

export const EXECUTION_CAPABILITY_TTL_MS = 60 * 60 * 1000;
export const TERMINAL_CALLBACK_MAX_SKEW_MS = 5 * 60 * 1000;

const KEY_PREFIXES = [
  'worker-capability',
  'arc-capability',
  'worker-callback',
  'arc-callback',
] as const;
type KeyPrefix = typeof KEY_PREFIXES[number];

export interface ExecutionCapabilityClaims {
  v: 1;
  purpose: ExecutionCapabilityPurpose;
  role: ExecutionCapabilityRole;
  botName: string;
  chatId: string;
  exp: number;
}

export interface KeyFileDiagnostic {
  path: string;
  exists: boolean;
  mode?: number;
  ownerUid?: number;
  ownerMatches?: boolean;
  permissionsOk?: boolean;
}

export interface KeyPairDiagnostic {
  name: KeyPrefix;
  privateKey: KeyFileDiagnostic;
  publicKey: KeyFileDiagnostic;
  previousPublicKey: KeyFileDiagnostic;
  pairMatches: boolean;
  error?: string;
  ok: boolean;
}

export interface ExecutionKeyDirectoryDiagnostic {
  path: string;
  directory: KeyFileDiagnostic;
  pairs: KeyPairDiagnostic[];
  ok: boolean;
  trustModel: 'tofu-same-uid-scope-hygiene';
}

export class ExecutionCapabilityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ExecutionCapabilityError';
  }
}

/**
 * Phase B keys are TOFU host state. Modes and ownership reduce accidents but
 * are not a boundary against arbitrary code running under the same OS uid.
 */
export function resolveExecutionKeysDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.METABOT_KEYS_DIR?.trim() || join(homedir(), '.metabot', 'keys');
}

/** Create all missing keypairs without ever replacing existing key material. */
export function provisionExecutionKeyPairs(keysDir = resolveExecutionKeysDir()): ExecutionKeyDirectoryDiagnostic {
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  chmodSync(keysDir, 0o700);
  assertTrustedPath(keysDir, 0o700, 'key directory');

  for (const name of KEY_PREFIXES) {
    const privatePath = join(keysDir, `${name}.key`);
    const publicPath = join(keysDir, `${name}.pub`);
    const privateExists = existsSync(privatePath);
    const publicExists = existsSync(publicPath);
    if (privateExists !== publicExists) {
      throw new ExecutionCapabilityError(
        `Refusing to replace incomplete ${name} keypair`,
        'INCOMPLETE_KEY_PAIR',
      );
    }
    if (!privateExists) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
        flag: 'wx',
        mode: 0o600,
      });
      writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    assertTrustedPath(privatePath, 0o600, `${name} private key`);
    assertTrustedPath(publicPath, 0o600, `${name} public key`);
    assertPairMatches(privatePath, publicPath, name);
  }
  return inspectExecutionKeyDirectory(keysDir);
}

export function inspectExecutionKeyDirectory(keysDir = resolveExecutionKeysDir()): ExecutionKeyDirectoryDiagnostic {
  const directory = inspectPath(keysDir, 0o700);
  const pairs = KEY_PREFIXES.map((name): KeyPairDiagnostic => {
    const privatePath = join(keysDir, `${name}.key`);
    const publicPath = join(keysDir, `${name}.pub`);
    const previousPath = join(keysDir, `${name}.pub.prev`);
    const privateKey = inspectPath(privatePath, 0o600);
    const publicKey = inspectPath(publicPath, 0o600);
    const previousPublicKey = inspectPath(previousPath, 0o600);
    let pairMatches = false;
    let error: string | undefined;
    if (privateKey.exists && publicKey.exists) {
      try {
        assertPairMatches(privatePath, publicPath, name);
        pairMatches = true;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const previousOk = !previousPublicKey.exists
      || (previousPublicKey.permissionsOk === true && previousPublicKey.ownerMatches !== false);
    const ok = directory.permissionsOk === true
      && directory.ownerMatches !== false
      && privateKey.permissionsOk === true
      && privateKey.ownerMatches !== false
      && publicKey.permissionsOk === true
      && publicKey.ownerMatches !== false
      && previousOk
      && pairMatches;
    return {
      name,
      privateKey,
      publicKey,
      previousPublicKey,
      pairMatches,
      ...(error ? { error } : {}),
      ok,
    };
  });
  return {
    path: keysDir,
    directory,
    pairs,
    ok: directory.exists
      && directory.permissionsOk === true
      && directory.ownerMatches !== false
      && pairs.every((pair) => pair.ok),
    trustModel: 'tofu-same-uid-scope-hygiene',
  };
}

/** Bridge-side issuer and verifier for worker/ARC connection capabilities. */
export class ExecutionCapabilityService {
  constructor(private readonly keysDir = resolveExecutionKeysDir()) {}

  issue(
    input: Omit<ExecutionCapabilityClaims, 'v' | 'exp'> & { ttlMs?: number },
    now = Date.now(),
  ): string {
    if (input.role !== 'pm' && input.role !== 'user') {
      throw new ExecutionCapabilityError('Only pm/user execution principals may receive a capability', 'ROLE_DENIED');
    }
    const ttlMs = input.ttlMs ?? EXECUTION_CAPABILITY_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new ExecutionCapabilityError('Capability ttlMs must be a positive integer', 'INVALID_TTL');
    }
    const claims: ExecutionCapabilityClaims = {
      v: 1,
      purpose: input.purpose,
      role: input.role,
      botName: requireClaim(input.botName, 'botName'),
      chatId: requireClaim(input.chatId, 'chatId'),
      exp: now + ttlMs,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const privateKey = this.loadPrivateKey(capabilityPrefix(input.purpose));
    const signature = cryptoSign(null, Buffer.from(payload), privateKey).toString('base64url');
    return `${payload}.${signature}`;
  }

  verify(
    token: string,
    expected: {
      purpose: ExecutionCapabilityPurpose;
      botName: string;
      chatId: string;
      ignoreExpiry?: boolean;
      now?: number;
    },
  ): ExecutionCapabilityClaims {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !isBase64Url(payload) || !isBase64Url(signature)) {
      throw new ExecutionCapabilityError('Invalid execution capability', 'INVALID_CAPABILITY');
    }
    const signatureBytes = Buffer.from(signature, 'base64url');
    const verified = this.loadPublicKeys(capabilityPrefix(expected.purpose))
      .some((key) => cryptoVerify(null, Buffer.from(payload), key, signatureBytes));
    if (!verified) {
      throw new ExecutionCapabilityError('Invalid execution capability signature', 'INVALID_SIGNATURE');
    }
    let claims: ExecutionCapabilityClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ExecutionCapabilityClaims;
    } catch {
      throw new ExecutionCapabilityError('Invalid execution capability claims', 'INVALID_CLAIMS');
    }
    if (
      claims.v !== 1
      || claims.purpose !== expected.purpose
      || (claims.role !== 'pm' && claims.role !== 'user')
      || claims.botName !== expected.botName
      || claims.chatId !== expected.chatId
    ) {
      throw new ExecutionCapabilityError('Execution capability scope mismatch', 'CAPABILITY_SCOPE_MISMATCH');
    }
    if (!Number.isSafeInteger(claims.exp)) {
      throw new ExecutionCapabilityError('Invalid execution capability expiry', 'INVALID_CLAIMS');
    }
    if (!expected.ignoreExpiry && claims.exp <= (expected.now ?? Date.now())) {
      throw new ExecutionCapabilityError('Execution capability has expired', 'CAPABILITY_EXPIRED');
    }
    return claims;
  }

  verifyTerminalCallbackSignature(
    rawBody: Buffer,
    signatureHeader: string,
    purpose: TerminalCallbackPurpose,
  ): void {
    const match = /^ed25519:([A-Za-z0-9+/]+={0,2})$/.exec(signatureHeader);
    if (!match) {
      throw new ExecutionCapabilityError('Invalid terminal callback signature header', 'INVALID_CALLBACK_SIGNATURE');
    }
    const signature = Buffer.from(match[1], 'base64');
    const verified = this.loadPublicKeys(callbackPrefix(purpose))
      .some((key) => cryptoVerify(null, rawBody, key, signature));
    if (!verified) {
      throw new ExecutionCapabilityError('Invalid terminal callback signature', 'INVALID_CALLBACK_SIGNATURE');
    }
  }

  /** Test/daemon-contract helper; the Bridge runtime never calls this method. */
  signTerminalCallback(rawBody: Buffer, purpose: TerminalCallbackPurpose): string {
    const privateKey = this.loadPrivateKey(callbackPrefix(purpose));
    return `ed25519:${cryptoSign(null, rawBody, privateKey).toString('base64')}`;
  }

  private loadPrivateKey(prefix: KeyPrefix): KeyObject {
    const privatePath = join(this.keysDir, `${prefix}.key`);
    const publicPath = join(this.keysDir, `${prefix}.pub`);
    assertTrustedPath(this.keysDir, 0o700, 'key directory');
    assertTrustedPath(privatePath, 0o600, `${prefix} private key`);
    assertTrustedPath(publicPath, 0o600, `${prefix} public key`);
    assertPairMatches(privatePath, publicPath, prefix);
    try {
      return readFileSync(privatePath, 'utf8') as unknown as KeyObject;
    } catch (cause) {
      throw keyReadError(prefix, cause);
    }
  }

  private loadPublicKeys(prefix: KeyPrefix): KeyObject[] {
    assertTrustedPath(this.keysDir, 0o700, 'key directory');
    const paths = [join(this.keysDir, `${prefix}.pub`), join(this.keysDir, `${prefix}.pub.prev`)]
      .filter((path) => existsSync(path));
    if (paths.length === 0) {
      throw new ExecutionCapabilityError(`Missing ${prefix} verification key`, 'KEYS_UNAVAILABLE');
    }
    return paths.map((path) => {
      assertTrustedPath(path, 0o600, `${prefix} verification key`);
      return readFileSync(path, 'utf8') as unknown as KeyObject;
    });
  }
}

function capabilityPrefix(purpose: ExecutionCapabilityPurpose): KeyPrefix {
  return purpose === 'worker' ? 'worker-capability' : 'arc-capability';
}

function callbackPrefix(purpose: TerminalCallbackPurpose): KeyPrefix {
  return purpose === 'worker.terminal' ? 'worker-callback' : 'arc-callback';
}

function requireClaim(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ExecutionCapabilityError(`Missing ${name}`, 'INVALID_CLAIMS');
  return normalized;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function assertPairMatches(privatePath: string, publicPath: string, name: string): void {
  try {
    const challenge = Buffer.from('metabot-ed25519-keypair-check-v1');
    const signature = cryptoSign(null, challenge, readFileSync(privatePath, 'utf8'));
    if (!cryptoVerify(null, challenge, readFileSync(publicPath, 'utf8'), signature)) {
      throw new Error('public/private keys do not correspond');
    }
  } catch (cause) {
    throw new ExecutionCapabilityError(
      `Invalid ${name} keypair: ${cause instanceof Error ? cause.message : String(cause)}`,
      'KEY_PAIR_MISMATCH',
    );
  }
}

function assertTrustedPath(path: string, expectedMode: number, label: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch (cause) {
    throw new ExecutionCapabilityError(
      `Missing or unreadable ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'KEYS_UNAVAILABLE',
    );
  }
  const actualMode = stat.mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new ExecutionCapabilityError(
      `Unsafe ${label} permissions: expected ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`,
      'UNSAFE_KEY_PERMISSIONS',
    );
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new ExecutionCapabilityError(
      `Unexpected ${label} owner uid ${stat.uid}; expected ${currentUid}`,
      'UNSAFE_KEY_OWNER',
    );
  }
}

function inspectPath(path: string, expectedMode: number): KeyFileDiagnostic {
  if (!existsSync(path)) return { path, exists: false };
  try {
    const stat = statSync(path);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const mode = stat.mode & 0o777;
    return {
      path,
      exists: true,
      mode,
      ownerUid: stat.uid,
      ownerMatches: currentUid === undefined || stat.uid === currentUid,
      permissionsOk: mode === expectedMode,
    };
  } catch {
    return { path, exists: true, permissionsOk: false, ownerMatches: false };
  }
}

function keyReadError(prefix: string, cause: unknown): ExecutionCapabilityError {
  return new ExecutionCapabilityError(
    `Unable to load ${prefix} key: ${cause instanceof Error ? cause.message : String(cause)}`,
    'KEYS_UNAVAILABLE',
  );
}
