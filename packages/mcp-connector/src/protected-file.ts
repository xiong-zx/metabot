import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

import { ConnectorError } from './errors.js';

export interface ProtectedFileOptions {
  /**
   * Directory the file must resolve inside, after both the directory and the
   * file are canonicalized. Containment is checked on real paths so a symlink
   * cannot point a leased credential at something outside the runtime root.
   */
  containedIn?: string;
  /** Hard ceiling; a credential file is small and an oversized one is a fault. */
  maxBytes?: number;
  label?: string;
  /** Permitted mode bits. Credentials are 0600 and nothing else. */
  expectedMode?: number;
  /**
   * Full set of acceptable mode bits, when more than one is legitimate.
   * Takes precedence over `expectedMode`; see `PUBLIC_MATERIAL_MODES`.
   */
  allowedModes?: readonly number[];
}

const DEFAULT_MAX_BYTES = 16 * 1024;

/**
 * Modes a *public* file may legitimately carry.
 *
 * A verification key is not a secret, and demanding 0600 of one is not a
 * stricter check — it is a wrong check. An operator who provisions a public key
 * the ordinary way gets 0644, and a reader that refuses it fails closed on a
 * correctly-configured host while learning nothing about the threat that
 * matters. What matters for public material is that nobody else can *write* it,
 * so group- and other-writable modes are refused and the rest are accepted.
 */
export const PUBLIC_MATERIAL_MODES: readonly number[] = Object.freeze([
  0o400, 0o440, 0o444, 0o600, 0o640, 0o644,
]);

/**
 * Read a private credential file that another process leased for this one.
 *
 * Every check here exists because the file is a secret held on a shared
 * filesystem: refuse symlinks and non-regular files so the path cannot be
 * redirected, pin the owner and mode so another account cannot plant one,
 * re-stat the open descriptor so the path cannot be swapped between the check
 * and the read, and bound the size so a hostile file cannot exhaust memory.
 */
export function readProtectedFile(filePath: string, options: ProtectedFileOptions = {}): string {
  const label = options.label ?? 'credential file';
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowedModes = options.allowedModes ?? [options.expectedMode ?? 0o600];

  if (!path.isAbsolute(filePath)) {
    throw new ConnectorError(`${label} path must be absolute`, 'CREDENTIAL_UNSAFE');
  }

  const before = lstatOrThrow(filePath, label);
  assertProtectedStat(before, allowedModes, label);

  if (options.containedIn !== undefined) {
    assertContained(filePath, options.containedIn, label);
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(descriptor);
    assertProtectedStat(opened, allowedModes, label);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ConnectorError(`${label} was replaced while opening`, 'CREDENTIAL_UNSAFE');
    }
    if (opened.size > maxBytes) {
      throw new ConnectorError(`${label} exceeds ${maxBytes} bytes`, 'CREDENTIAL_TOO_LARGE');
    }
    // Read one byte past the ceiling so a file that grew between fstat and read
    // is reported as oversized instead of being silently truncated.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (read > maxBytes) {
      throw new ConnectorError(`${label} exceeds ${maxBytes} bytes`, 'CREDENTIAL_TOO_LARGE');
    }
    return buffer.subarray(0, read).toString('utf8');
  } catch (cause) {
    if (cause instanceof ConnectorError) throw cause;
    throw new ConnectorError(`Unable to read ${label}`, 'CREDENTIAL_UNSAFE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Read a single-line secret (capability token, service bearer). The value is
 * trimmed of surrounding whitespace only; an embedded newline means the file is
 * not what the caller thinks it is, so it is refused rather than silently cut.
 */
export function readProtectedSecret(filePath: string, options: ProtectedFileOptions = {}): string {
  const label = options.label ?? 'credential file';
  const raw = readProtectedFile(filePath, options);
  const value = raw.trim();
  if (value.length === 0) {
    throw new ConnectorError(`${label} is empty`, 'CREDENTIAL_EMPTY');
  }
  if (/[\r\n\0]/.test(value)) {
    throw new ConnectorError(`${label} contains more than one line`, 'CREDENTIAL_UNSAFE');
  }
  return value;
}

/**
 * Read public material — a verification key, not a secret.
 *
 * Same containment, symlink, owner, and size handling as a credential; only the
 * accepted mode set differs. Kept as its own entry point so the choice is
 * visible at the call site rather than buried in an options object.
 */
export function readProtectedPublicKey(filePath: string, options: ProtectedFileOptions = {}): string {
  return readProtectedFile(filePath, {
    ...options,
    label: options.label ?? 'verification key',
    allowedModes: options.allowedModes ?? PUBLIC_MATERIAL_MODES,
  });
}

function lstatOrThrow(filePath: string, label: string): Stats {
  try {
    return lstatSync(filePath);
  } catch (cause) {
    if (isMissingPathError(cause)) {
      throw new ConnectorError(`Missing ${label}`, 'CREDENTIAL_MISSING');
    }
    throw new ConnectorError(`Unreadable ${label}`, 'CREDENTIAL_UNSAFE');
  }
}

function assertProtectedStat(stat: Stats, allowedModes: readonly number[], label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ConnectorError(`${label} is not a regular file`, 'CREDENTIAL_UNSAFE');
  }
  const mode = stat.mode & 0o777;
  if (!allowedModes.includes(mode)) {
    throw new ConnectorError(
      `${label} permissions are ${mode.toString(8)}; expected ${allowedModes.map((value) => value.toString(8)).join(' or ')}`,
      'CREDENTIAL_UNSAFE',
    );
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) {
    throw new ConnectorError(`${label} is owned by uid ${stat.uid}`, 'CREDENTIAL_UNSAFE');
  }
}

function assertContained(filePath: string, containedIn: string, label: string): void {
  if (!path.isAbsolute(containedIn)) {
    throw new ConnectorError(`${label} containment root must be absolute`, 'CREDENTIAL_UNSAFE');
  }
  let root: string;
  let resolved: string;
  try {
    root = realpathSync(containedIn);
    resolved = realpathSync(filePath);
  } catch {
    throw new ConnectorError(`Unable to canonicalize ${label}`, 'CREDENTIAL_UNSAFE');
  }
  const relative = path.relative(root, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConnectorError(`${label} escapes its containment root`, 'CREDENTIAL_UNSAFE');
  }
}

function isMissingPathError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    'code' in cause &&
    (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
  );
}
