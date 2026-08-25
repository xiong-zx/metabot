import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Per-turn capability leases.
 *
 * A capability token must reach a spawned server without passing through argv,
 * a generated MCP config, a prompt, or a log line, which leaves a private file
 * on disk. Three properties make that safe, and all three are structural rather
 * than conventional:
 *
 * - **Per-turn nonce.** Every lease gets a fresh random filename, so two turns
 *   in the same chat cannot collide and one turn cannot overwrite or read the
 *   other's credential by guessing a deterministic path.
 * - **Per-entry isolation.** One lease per server entry. Releasing or failing
 *   to create one entry's lease never disturbs another's, so a server that is
 *   misconfigured removes only itself.
 * - **Startup sweep.** A crash leaves credentials behind. Expiry is encoded in
 *   the filename so a later startup can delete stale leases exactly, without
 *   trusting an mtime that a restore or a copy may not have preserved.
 */

export class CapabilityLeaseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CapabilityLeaseError';
  }
}

export interface CapabilityLeaseInput {
  /** Absolute runtime root; the lease directory lives inside it. */
  runtimeRoot: string;
  /** Registered audience id; separates one server's leases from another's. */
  audience: string;
  /** Opaque per-turn scope, typically derived from bot name and chat id. */
  scope: string;
  /** Token bytes. Never logged, never echoed, never returned by this module. */
  token: string;
  /** Absolute epoch milliseconds at which the lease stops being valid. */
  expiresAt: number;
  /** Injectable only for deterministic collision/race tests. */
  nonce?: () => string;
}

export interface CapabilityLease {
  readonly path: string;
  readonly audience: string;
  readonly expiresAt: number;
  /** Idempotent. Removing one lease never touches another entry's. */
  release(): void;
}

export interface CapabilityLeaseSweepResult {
  readonly directory: string;
  readonly removed: string[];
  /** Entries left in place: unexpired, or not a regular file this uid owns. */
  readonly retained: string[];
}

const LEASE_DIR_SEGMENTS = ['data', 'mcp-capabilities'] as const;
const LEASE_SUFFIX = '.token';
const MAX_SCOPE_INPUT_LENGTH = 1_024;
const MAX_AUDIENCE_LENGTH = 64;

/**
 * Canonical, owner-checked, 0700 lease directory inside the runtime root.
 * Canonicalization happens before the containment check so a symlinked
 * scratch path cannot place credentials outside the root.
 */
export function resolveCapabilityLeaseDirectory(runtimeRoot: string): string {
  if (!path.isAbsolute(runtimeRoot)) {
    throw new CapabilityLeaseError('Runtime root must be absolute', 'RUNTIME_ROOT_NOT_ABSOLUTE');
  }
  const canonicalRoot = realpathSync(runtimeRoot);
  const directory = path.join(canonicalRoot, ...LEASE_DIR_SEGMENTS);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CapabilityLeaseError('Capability lease path is not a real directory', 'LEASE_DIR_UNSAFE');
  }
  if (process.getuid && info.uid !== process.getuid()) {
    throw new CapabilityLeaseError('Capability lease directory owner mismatch', 'LEASE_DIR_UNSAFE');
  }
  const canonicalDirectory = realpathSync(directory);
  if (!isWithin(canonicalRoot, canonicalDirectory)) {
    throw new CapabilityLeaseError('Capability lease directory escapes the runtime root', 'LEASE_DIR_UNSAFE');
  }
  chmodSync(canonicalDirectory, 0o700);
  return canonicalDirectory;
}

export function leaseCapabilityFile(input: CapabilityLeaseInput): CapabilityLease {
  if (input.token.length === 0) {
    throw new CapabilityLeaseError('Refusing to lease an empty capability', 'EMPTY_CAPABILITY');
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) {
    throw new CapabilityLeaseError('Capability lease expiry must be a positive integer', 'INVALID_EXPIRY');
  }
  const audience = safeSegment(input.audience);
  if (audience !== input.audience) {
    throw new CapabilityLeaseError('Capability lease audience is not a safe path segment', 'UNSAFE_AUDIENCE');
  }
  if (input.scope.length === 0 || input.scope.length > MAX_SCOPE_INPUT_LENGTH) {
    throw new CapabilityLeaseError('Capability lease scope is not a bounded identifier', 'UNSAFE_SCOPE');
  }
  const directory = resolveCapabilityLeaseDirectory(input.runtimeRoot);
  // The scope commonly contains bot and chat identifiers. A filename is an
  // observable diagnostic surface, so store a fixed digest rather than a
  // sanitized prefix that still discloses those identifiers.
  const scopeDigest = createHash('sha256').update(input.scope).digest('hex').slice(0, 24);
  const filePath = path.join(
    directory,
    `scope-${scopeDigest}-${audience}-${input.expiresAt}-${(input.nonce ?? randomUUID)()}${LEASE_SUFFIX}`,
  );

  // 'wx' rather than truncate: a name collision means something unexpected owns
  // that path, and overwriting it would hand this turn's credential to it.
  writeFileSync(filePath, input.token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(filePath, 0o600);
  const info = lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    rmSync(filePath, { force: true });
    throw new CapabilityLeaseError('Capability lease is not a regular file', 'LEASE_UNSAFE');
  }
  if (process.getuid && info.uid !== process.getuid()) {
    rmSync(filePath, { force: true });
    throw new CapabilityLeaseError('Capability lease owner mismatch', 'LEASE_UNSAFE');
  }

  let released = false;
  return {
    path: filePath,
    audience: input.audience,
    expiresAt: input.expiresAt,
    release: () => {
      if (released) return;
      released = true;
      rmSync(filePath, { force: true });
    },
  };
}

/**
 * Delete leases whose encoded expiry has passed.
 *
 * Run at startup, when no lease from this process exists yet. Anything left in
 * the directory belongs to a previous run that did not get to release it.
 * Files this uid does not own, symlinks, and non-regular nodes are retained
 * rather than deleted: the sweep is cleaning up after itself, not asserting
 * authority over paths it did not create.
 */
export function sweepExpiredCapabilityLeases(
  runtimeRoot: string,
  options: { now?: number } = {},
): CapabilityLeaseSweepResult {
  const now = options.now ?? Date.now();
  const directory = resolveCapabilityLeaseDirectory(runtimeRoot);
  const removed: string[] = [];
  const retained: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(LEASE_SUFFIX)) {
      retained.push(entry);
      continue;
    }
    const filePath = path.join(directory, entry);
    let info;
    try {
      info = lstatSync(filePath);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile() || (process.getuid && info.uid !== process.getuid())) {
      retained.push(entry);
      continue;
    }
    const expiresAt = parseLeaseExpiry(entry);
    if (expiresAt === undefined || expiresAt > now) {
      retained.push(entry);
      continue;
    }
    try {
      rmSync(filePath, { force: true });
      removed.push(entry);
    } catch {
      retained.push(entry);
    }
  }
  return { directory, removed, retained };
}

/** Parse only filenames emitted by this module; foreign lease grammars are retained. */
function parseLeaseExpiry(entry: string): number | undefined {
  const match = /^scope-[0-9a-f]{24}-[A-Za-z0-9_]{1,64}-([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.token$/.exec(entry);
  if (match === null) return undefined;
  const expiry = Number(match[1]);
  return Number.isSafeInteger(expiry) && expiry > 0 ? expiry : undefined;
}

function safeSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_AUDIENCE_LENGTH);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
