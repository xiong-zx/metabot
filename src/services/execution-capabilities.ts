import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchEnvelopeFingerprint,
  rulesPackChildGrantFingerprint,
  validateDispatchEnvelope,
  type RulesPackChildGrantV1,
  type RulesPackDispatchEnvelopeV1,
} from '@metabot/rulespack';
import {
  assertDistinctMcpServers,
  capabilityServers,
  loopbackProxyServers,
} from './mcp-registry.js';

export type ExecutionCapabilityPurpose = string;
export type TerminalCallbackPurpose = 'worker.terminal';
export type ExecutionCapabilityRole = 'pm' | 'user';

export const EXECUTION_CAPABILITY_TTL_MS = 60 * 60 * 1000;
export const TERMINAL_CALLBACK_MAX_SKEW_MS = 5 * 60 * 1000;
export const EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH = 200;
export const EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH = 500;

/**
 * One capability keypair and one callback keypair per registered server, so no
 * server holds a key that could verify another server's token. Derived from the
 * registry rather than listed here, so registering a server cannot silently
 * skip its own keys or reuse an existing audience's.
 */
const KEY_PREFIXES: readonly string[] = [
  ...capabilityServers().map((server) => `${server.id}-capability`),
  ...loopbackProxyServers().map((server) => `${server.id}-callback`),
];
type KeyPrefix = string;
const PRIVATE_KEY_MODES = [0o600] as const;
export const EXECUTION_PUBLIC_KEY_MODES = [0o400, 0o440, 0o444, 0o600, 0o640, 0o644] as const;
const DIRECTORY_MODES = [0o700] as const;

/**
 * Signed audience claim.
 *
 * Key separation alone cannot express audience: a verifier that trusts a key
 * has no way to tell what the issuer minted the token for. The claim states it,
 * and a `v3-audience` server refuses a token that omits it — a capability
 * minted before audiences existed would otherwise stay replayable for its whole
 * lifetime. Servers still on the v2.1 contract get no `aud`, because their
 * shipped verifiers reject any claim outside the original set.
 */
export interface ExecutionCapabilityClaims {
  v: 1;
  purpose: ExecutionCapabilityPurpose;
  role: ExecutionCapabilityRole;
  botName: string;
  chatId: string;
  exp: number;
}

interface LocalLifecycleCapabilityClaims extends Omit<ExecutionCapabilityClaims, 'role'> {
  role: 'admin';
}

/** Audience a server's tokens must carry, or undefined for the v2.1 contract. */
export function requiredCapabilityAudience(purpose: ExecutionCapabilityPurpose): string | undefined {
  const server = capabilityServers().find((entry) => entry.id === purpose);
  if (!server) throw new ExecutionCapabilityError(`Unknown execution capability purpose: ${purpose}`, 'UNKNOWN_PURPOSE');
  return undefined;
}

export interface KeyFileDiagnostic {
  path: string;
  exists: boolean;
  isSymlink?: boolean;
  nodeType?: string;
  nodeTypeOk?: boolean;
  mode?: number;
  ownerUid?: number;
  ownerMatches?: boolean;
  permissionsOk?: boolean;
  error?: string;
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
  assertDistinctMcpServers();
  const existingDirectory = lstatIfPresent(keysDir, 'key directory');
  if (existingDirectory) {
    assertTrustedStat(existingDirectory, DIRECTORY_MODES, 'key directory', 'directory');
  } else {
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    chmodSync(keysDir, 0o700);
    assertTrustedPath(keysDir, DIRECTORY_MODES, 'key directory', 'directory');
  }

  for (const name of KEY_PREFIXES) {
    const privatePath = join(keysDir, `${name}.key`);
    const publicPath = join(keysDir, `${name}.pub`);
    const previousPath = join(keysDir, `${name}.pub.prev`);
    const privateStat = lstatIfPresent(privatePath, `${name} private key`);
    const publicStat = lstatIfPresent(publicPath, `${name} public key`);
    const previousStat = lstatIfPresent(previousPath, `${name} previous public key`);
    if (privateStat) assertTrustedStat(privateStat, PRIVATE_KEY_MODES, `${name} private key`, 'regular-file');
    if (publicStat) assertTrustedStat(publicStat, EXECUTION_PUBLIC_KEY_MODES, `${name} public key`, 'regular-file');
    if (previousStat) assertTrustedStat(previousStat, EXECUTION_PUBLIC_KEY_MODES, `${name} previous public key`, 'regular-file');
    const privateExists = !!privateStat;
    const publicExists = !!publicStat;
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
    assertTrustedPath(privatePath, PRIVATE_KEY_MODES, `${name} private key`, 'regular-file');
    assertTrustedPath(publicPath, EXECUTION_PUBLIC_KEY_MODES, `${name} public key`, 'regular-file');
    assertPairMatches(privatePath, publicPath, name);
  }
  assertDistinctKeyMaterial(keysDir);
  return inspectExecutionKeyDirectory(keysDir);
}

/**
 * Startup guard against cross-audience key reuse.
 *
 * If two audiences share verification material, each one's verifier accepts the
 * other's signatures and the audience claim becomes the only thing separating
 * them — and one of the two may not even check it. Independent rotation also
 * stops being possible: retiring one audience's key would silently retire the
 * other's. Refuse at provisioning time rather than discovering it when a token
 * crosses.
 *
 * Comparison is on the canonical SPKI DER encoding, so the same key stored with
 * different PEM whitespace or line endings still collides.
 */
export function assertDistinctKeyMaterial(keysDir = resolveExecutionKeysDir()): void {
  const owners = new Map<string, string>();
  for (const name of KEY_PREFIXES) {
    for (const candidate of [join(keysDir, `${name}.pub`), join(keysDir, `${name}.pub.prev`)]) {
      if (!lstatIfPresent(candidate, `${name} verification key`)) continue;
      const fingerprint = canonicalPublicKeyFingerprint(
        readTrustedKeyFile(candidate, `${name} verification key`, EXECUTION_PUBLIC_KEY_MODES),
        `${name} verification key`,
      );
      const existing = owners.get(fingerprint);
      if (existing !== undefined && existing !== name) {
        throw new ExecutionCapabilityError(
          `Execution keys ${existing} and ${name} share verification material`,
          'CROSS_AUDIENCE_KEY_REUSE',
        );
      }
      owners.set(fingerprint, name);
    }
  }
}

export function inspectExecutionKeyDirectory(keysDir = resolveExecutionKeysDir()): ExecutionKeyDirectoryDiagnostic {
  const directory = inspectPath(keysDir, DIRECTORY_MODES, 'directory');
  const pairs = KEY_PREFIXES.map((name): KeyPairDiagnostic => {
    const privatePath = join(keysDir, `${name}.key`);
    const publicPath = join(keysDir, `${name}.pub`);
    const previousPath = join(keysDir, `${name}.pub.prev`);
    const privateKey = inspectPath(privatePath, PRIVATE_KEY_MODES, 'regular-file');
    const publicKey = inspectPath(publicPath, EXECUTION_PUBLIC_KEY_MODES, 'regular-file');
    const previousPublicKey = inspectPath(previousPath, EXECUTION_PUBLIC_KEY_MODES, 'regular-file');
    let pairMatches = false;
    let error: string | undefined;
    if (isSafeDiagnostic(directory) && isSafeDiagnostic(privateKey) && isSafeDiagnostic(publicKey)) {
      try {
        assertPairMatches(privatePath, publicPath, name);
        pairMatches = true;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const previousOk = !previousPublicKey.exists
      || isSafeDiagnostic(previousPublicKey);
    const ok = directory.nodeTypeOk === true
      && directory.permissionsOk === true
      && directory.ownerMatches !== false
      && isSafeDiagnostic(privateKey)
      && isSafeDiagnostic(publicKey)
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
      && directory.nodeTypeOk === true
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
    requiredCapabilityAudience(input.purpose);
    return this.signCapability({
      v: 1,
      purpose: input.purpose,
      role: input.role,
      botName: requireClaim(input.botName, 'botName', EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH),
      chatId: requireClaim(input.chatId, 'chatId', EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH),
      exp: now + ttlMs,
    });
  }

  /**
   * Mint the fixed local-operator principal used only for daemon health and
   * lifecycle reads. Engine sessions never call this path and continue to be
   * limited to pm/user capabilities through issue().
   */
  issueLocalLifecycleAdmin(
    purpose: ExecutionCapabilityPurpose,
    ttlMs = 2 * 60 * 1000,
    now = Date.now(),
  ): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(now + ttlMs)) {
      throw new ExecutionCapabilityError('Lifecycle capability ttlMs is invalid', 'INVALID_TTL');
    }
    requiredCapabilityAudience(purpose);
    return this.signCapability({
      v: 1,
      purpose,
      role: 'admin',
      botName: 'metabot-local-lifecycle',
      chatId: 'local:daemon-lifecycle',
      exp: now + ttlMs,
    });
  }

  /** Sign a non-secret, capability-bound grant for the Worker proxy only. */
  issueRulesPackChildGrant(
    capability: string,
    parent: RulesPackDispatchEnvelopeV1,
    now = Date.now(),
  ): RulesPackChildGrantV1 {
    validateDispatchEnvelope(parent, {
      audience: parent.audience,
      target: parent.target,
      now: new Date(now).toISOString(),
    });
    const claims = this.verify(capability, {
      purpose: 'worker',
      botName: parent.target.bot,
      chatId: parent.target.chatId,
      now,
    });
    const parentExpiry = Date.parse(parent.expiresAt);
    if (!Number.isFinite(parentExpiry) || parentExpiry <= now) {
      throw new ExecutionCapabilityError('RulesPack parent dispatch has expired', 'CAPABILITY_EXPIRED');
    }
    const unsigned: Omit<RulesPackChildGrantV1, 'signature'> = {
      schemaVersion: 1,
      purpose: 'worker',
      grantId: `rulespack-child-${randomUUID()}`,
      capabilityDigest: executionCapabilityDigest(capability),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(parentExpiry, claims.exp)).toISOString(),
      depth: 1,
      parentEnvelopeFingerprint: dispatchEnvelopeFingerprint(parent),
      parent,
      constraints: {
        hostId: parent.target.hostId,
        bot: parent.target.bot,
        chatId: parent.target.chatId,
        ...(parent.target.projectId ? { projectId: parent.target.projectId } : {}),
      },
    };
    return {
      ...unsigned,
      signature: {
        scheme: 'ed25519',
        value: cryptoSign(
          null,
          Buffer.from(rulesPackChildGrantFingerprint(unsigned)),
          this.loadPrivateKey(capabilityPrefix('worker')),
        ).toString('base64url'),
      },
    };
  }

  private signCapability(claims: ExecutionCapabilityClaims | LocalLifecycleCapabilityClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const privateKey = this.loadPrivateKey(capabilityPrefix(claims.purpose));
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
    const expectedBotName = requireCanonicalClaim(
      expected.botName,
      'expected botName',
      EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH,
    );
    const expectedChatId = requireCanonicalClaim(
      expected.chatId,
      'expected chatId',
      EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH,
    );
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
      !isCanonicalBoundedClaim(claims.botName, EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH)
      || !isCanonicalBoundedClaim(claims.chatId, EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH)
    ) {
      throw new ExecutionCapabilityError('Invalid execution capability claims', 'INVALID_CLAIMS');
    }
    // Checked before role and scope, so a token minted for another server is
    // refused on identity alone even though the same issuer signed it.
    if (
      claims.v !== 1
      || claims.purpose !== expected.purpose
      || (claims.role !== 'pm' && claims.role !== 'user')
      || claims.botName !== expectedBotName
      || claims.chatId !== expectedChatId
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

  private loadPrivateKey(prefix: KeyPrefix): string {
    const privatePath = join(this.keysDir, `${prefix}.key`);
    const publicPath = join(this.keysDir, `${prefix}.pub`);
    assertTrustedPath(this.keysDir, DIRECTORY_MODES, 'key directory', 'directory');
    const privateKey = readTrustedKeyFile(privatePath, `${prefix} private key`, PRIVATE_KEY_MODES);
    const publicKey = readTrustedKeyFile(publicPath, `${prefix} public key`, EXECUTION_PUBLIC_KEY_MODES);
    assertPairContents(privateKey, publicKey, prefix);
    return privateKey;
  }

  private loadPublicKeys(prefix: KeyPrefix): string[] {
    assertTrustedPath(this.keysDir, DIRECTORY_MODES, 'key directory', 'directory');
    const currentPath = join(this.keysDir, `${prefix}.pub`);
    const previousPath = join(this.keysDir, `${prefix}.pub.prev`);
    const previousStat = lstatIfPresent(previousPath, `${prefix} previous verification key`);
    if (previousStat) {
      assertTrustedStat(previousStat, EXECUTION_PUBLIC_KEY_MODES, `${prefix} previous verification key`, 'regular-file');
    }
    return [
      readTrustedKeyFile(currentPath, `${prefix} verification key`, EXECUTION_PUBLIC_KEY_MODES),
      ...(previousStat
        ? [readTrustedKeyFile(previousPath, `${prefix} previous verification key`, EXECUTION_PUBLIC_KEY_MODES)]
        : []),
    ];
  }
}

export function executionCapabilityDigest(capability: string): string {
  return `sha256:${createHash('sha256').update(capability).digest('hex')}`;
}

function capabilityPrefix(purpose: ExecutionCapabilityPurpose): KeyPrefix {
  const server = capabilityServers().find((entry) => entry.id === purpose);
  if (!server) throw new ExecutionCapabilityError(`Unknown execution capability purpose: ${purpose}`, 'UNKNOWN_PURPOSE');
  return `${server.id}-capability`;
}

function callbackPrefix(purpose: TerminalCallbackPurpose): KeyPrefix {
  const id = purpose.slice(0, purpose.indexOf('.'));
  const descriptor = loopbackProxyServers().find((entry) => entry.id === id);
  if (!descriptor) {
    throw new ExecutionCapabilityError(`Unknown terminal callback purpose: ${purpose}`, 'UNKNOWN_PURPOSE');
  }
  return `${descriptor.id}-callback`;
}

function canonicalPublicKeyFingerprint(value: string, label: string): string {
  try {
    return createPublicKey(value).export({ type: 'spki', format: 'der' }).toString('base64');
  } catch (cause) {
    throw new ExecutionCapabilityError(
      `Invalid ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'INVALID_PUBLIC_KEY',
    );
  }
}

function requireClaim(value: string, name: string, maxLength: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new ExecutionCapabilityError(`Missing ${name}`, 'INVALID_CLAIMS');
  if (normalized.length > maxLength) {
    throw new ExecutionCapabilityError(
      `${name} exceeds ${maxLength} characters`,
      'INVALID_CLAIMS',
    );
  }
  return normalized;
}

function requireCanonicalClaim(value: string, name: string, maxLength: number): string {
  const normalized = requireClaim(value, name, maxLength);
  if (normalized !== value) {
    throw new ExecutionCapabilityError(`${name} is not canonical`, 'INVALID_CLAIMS');
  }
  return value;
}

function isCanonicalBoundedClaim(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim();
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function assertPairMatches(privatePath: string, publicPath: string, name: string): void {
  try {
    assertPairContents(
      readTrustedKeyFile(privatePath, `${name} private key`, PRIVATE_KEY_MODES),
      readTrustedKeyFile(publicPath, `${name} public key`, EXECUTION_PUBLIC_KEY_MODES),
      name,
    );
  } catch (cause) {
    if (cause instanceof ExecutionCapabilityError) throw cause;
    throw new ExecutionCapabilityError(
      `Invalid ${name} keypair: ${cause instanceof Error ? cause.message : String(cause)}`,
      'KEY_PAIR_MISMATCH',
    );
  }
}

function assertPairContents(privateKey: string, publicKey: string, name: string): void {
  try {
    const challenge = Buffer.from('metabot-ed25519-keypair-check-v1');
    const signature = cryptoSign(null, challenge, privateKey);
    if (!cryptoVerify(null, challenge, publicKey, signature)) {
      throw new Error('public/private keys do not correspond');
    }
  } catch (cause) {
    throw new ExecutionCapabilityError(
      `Invalid ${name} keypair: ${cause instanceof Error ? cause.message : String(cause)}`,
      'KEY_PAIR_MISMATCH',
    );
  }
}

type ExpectedNodeType = 'directory' | 'regular-file';

function assertTrustedPath(
  path: string,
  allowedModes: readonly number[],
  label: string,
  expectedType: ExpectedNodeType,
): Stats {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (cause) {
    throw new ExecutionCapabilityError(
      `Missing or unreadable ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'KEYS_UNAVAILABLE',
    );
  }
  assertTrustedStat(stat, allowedModes, label, expectedType);
  return stat;
}

function assertTrustedStat(
  stat: Stats,
  allowedModes: readonly number[],
  label: string,
  expectedType: ExpectedNodeType,
): void {
  const nodeTypeOk = expectedType === 'directory' ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !nodeTypeOk) {
    throw new ExecutionCapabilityError(
      `Unsafe ${label} node type: expected ${expectedType}, got ${nodeTypeName(stat)}`,
      'UNSAFE_KEY_NODE_TYPE',
    );
  }
  const actualMode = stat.mode & 0o777;
  if (!allowedModes.includes(actualMode)) {
    throw new ExecutionCapabilityError(
      `Unsafe ${label} permissions: expected ${allowedModes.map((mode) => mode.toString(8)).join(' or ')}, got ${actualMode.toString(8)}`,
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

function inspectPath(
  path: string,
  allowedModes: readonly number[],
  expectedType: ExpectedNodeType,
): KeyFileDiagnostic {
  try {
    const stat = lstatSync(path);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const mode = stat.mode & 0o777;
    const isSymlink = stat.isSymbolicLink();
    const nodeType = nodeTypeName(stat);
    const nodeTypeOk = !isSymlink
      && (expectedType === 'directory' ? stat.isDirectory() : stat.isFile());
    return {
      path,
      exists: true,
      isSymlink,
      nodeType,
      nodeTypeOk,
      mode,
      ownerUid: stat.uid,
      ownerMatches: currentUid === undefined || stat.uid === currentUid,
      permissionsOk: allowedModes.includes(mode),
    };
  } catch (cause) {
    if (isMissingPathError(cause)) return { path, exists: false };
    return {
      path,
      exists: true,
      nodeTypeOk: false,
      permissionsOk: false,
      ownerMatches: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function readTrustedKeyFile(path: string, label: string, allowedModes: readonly number[]): string {
  const before = assertTrustedPath(path, allowedModes, label, 'regular-file');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(descriptor);
    assertTrustedStat(opened, allowedModes, label, 'regular-file');
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new ExecutionCapabilityError(
        `Unsafe ${label} path changed while opening`,
        'UNSAFE_KEY_PATH_CHANGED',
      );
    }
    return readFileSync(descriptor, 'utf8');
  } catch (cause) {
    if (cause instanceof ExecutionCapabilityError) throw cause;
    throw keyReadError(label, cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function lstatIfPresent(path: string, label: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (cause) {
    if (isMissingPathError(cause)) return undefined;
    throw keyReadError(label, cause);
  }
}

function isSafeDiagnostic(value: KeyFileDiagnostic): boolean {
  return value.exists
    && value.nodeTypeOk === true
    && value.permissionsOk === true
    && value.ownerMatches !== false;
}

function nodeTypeName(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'symbolic-link';
  if (stat.isFile()) return 'regular-file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  return 'unknown';
}

function isMissingPathError(cause: unknown): boolean {
  return cause instanceof Error
    && 'code' in cause
    && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');
}

function keyReadError(label: string, cause: unknown): ExecutionCapabilityError {
  return new ExecutionCapabilityError(
    `Unable to load ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
    'KEYS_UNAVAILABLE',
  );
}
