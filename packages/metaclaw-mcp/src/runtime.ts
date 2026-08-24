import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { createRedactor, readProtectedSecret, type Redactor } from '@xvirobotics/mcp-connector';

import { asMetaClawError, MetaClawError } from './errors.js';
import { MetaClawCostLedger } from './cost-ledger.js';
import { evaluateGates, type GateStatus } from './gates.js';
import { loadReleaseManifest, verifyReleaseIntegrity, type ReleaseManifest } from './integrity.js';
import { createLocalReadBudget, type LocalReadBudget } from './local-read.js';
import { loadMetaClawProfile, type MetaClawProfile } from './profile.js';
import { createHttpServiceClient, type MetaClawServiceClient } from './service-client.js';

/**
 * Everything this server holds for a session.
 *
 * Configuration — profile, manifest, endpoint — is resolved once at startup, and
 * a failure at any step means the process does not come up. That is the intended
 * failure mode for a native stdio entry: an entry that cannot be configured
 * correctly should disappear from the client's tool list, not appear and then
 * refuse every call. Its absence also removes only itself — ARC and Worker
 * Runner are separate processes with separate credentials and are unaffected.
 *
 * Client identity is not part of the product contract. Enabling this installed
 * command is the client-side decision; service authentication, model/provider
 * restrictions, release integrity, and cost bounds remain product-owned.
 */

export const ENV_PROFILE_FILE = 'METACLAW_MCP_PROFILE_FILE';
export const ENV_RELEASE_MANIFEST = 'METACLAW_MCP_RELEASE_MANIFEST';

export interface MetaClawRuntime {
  readonly profile: MetaClawProfile;
  readonly manifest: ReleaseManifest;
  readonly manifestPath: string;
  readonly gates: readonly GateStatus[];
  readonly costLedger: MetaClawCostLedger;
  readonly client: MetaClawServiceClient;
  readonly redact: Redactor;
  /** One shared local-filesystem budget for a complete tool invocation. */
  createLocalReadBudget(): LocalReadBudget;
  /** Refuse every tool if a managed profile artifact changed after startup. */
  assertConfigurationCurrent(): void;
}

export interface CreateRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export function createMetaClawRuntime(options: CreateRuntimeOptions = {}): MetaClawRuntime {
  // Startup reads credential files through the connector, whose errors belong
  // to its own domain. Callers of this package see one error vocabulary, so the
  // translation happens here rather than at each place a runtime is built.
  //
  // The redactor is created before the first secret is read and registers each
  // one as it arrives, so a startup failure part-way through — the exact moment
  // at which one secret is loaded and the next path is malformed — is redacted
  // with what has been read so far rather than with nothing.
  const secrets = createSecretRegistry();
  try {
    return buildRuntime(options, secrets);
  } catch (error) {
    throw asMetaClawError(error, secrets.redact);
  }
}

function buildRuntime(options: CreateRuntimeOptions, secrets: SecretRegistry): MetaClawRuntime {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());

  const profile = loadMetaClawProfile(requiredAbsolutePath(env, ENV_PROFILE_FILE));
  const manifestPath = requiredAbsolutePath(env, ENV_RELEASE_MANIFEST);
  const manifest = loadReleaseManifest(manifestPath);
  assertRuntimeReleasePairing(profile, manifest, manifestPath);
  assertRuntimeRootsDistinct(profile, manifest);

  const bearer = readProtectedSecret(profile.service.bearerFile, { label: 'MetaClaw service bearer' });
  secrets.register(bearer);
  const costLedger = new MetaClawCostLedger(profile.cost);
  const gates = evaluateGates(profile.gates).map((gate) => gate.id === 'MCLAW-COST-LEDGER'
    ? { ...gate, satisfied: true, evidence: 'mechanical:cost-ledger-v1' }
    : gate);
  const configurationDigests = new Map(
    [
      profile.sourcePath,
      profile.service.configFile,
      profile.service.authFile,
      profile.service.bearerFile,
      profile.rollback.initialSnapshot,
    ].map((target) => [target, stableFileDigest(target)]),
  );

  const runtime: MetaClawRuntime = {
    profile,
    manifest,
    manifestPath,
    gates,
    costLedger,
    redact: secrets.redact,
    createLocalReadBudget(): LocalReadBudget {
      return createLocalReadBudget({
        maxEntries: profile.limits.maxLocalEntries,
        maxBytes: profile.limits.maxLocalBytes,
        deadlineMs: profile.limits.localReadDeadlineMs,
        now,
      });
    },
    assertConfigurationCurrent(): void {
      let currentProfile: MetaClawProfile;
      try {
        currentProfile = loadMetaClawProfile(profile.sourcePath);
      } catch (error) {
        throw new MetaClawError('Managed profile failed re-validation after MCP startup', 'integrity_drift', {
          cause: error instanceof MetaClawError ? error.code : 'profile_unreadable',
        });
      }
      if (profileDocument(currentProfile) !== profileDocument(profile)) {
        throw new MetaClawError('Managed profile changed after MCP startup', 'integrity_drift');
      }
      for (const [target, expected] of configurationDigests) {
        let actual: string;
        try {
          actual = stableFileDigest(target);
        } catch {
          throw new MetaClawError('Managed profile artifact is missing or unsafe', 'integrity_drift', { target });
        }
        if (actual !== expected) {
          throw new MetaClawError('Managed profile artifact changed after MCP startup', 'integrity_drift', { target });
        }
      }
    },
    client: createHttpServiceClient({
      endpoint: profile.endpoint,
      bearer,
      redact: secrets.redact,
      maxRequestBytes: profile.limits.maxRequestBytes,
      maxResponseBytes: profile.limits.maxResponseBytes,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  };
  return runtime;
}


/** Integrity is re-read per call; the interesting drift happens while we run. */
export function currentIntegrity(
  runtime: MetaClawRuntime,
  budget: LocalReadBudget = runtime.createLocalReadBudget(),
): ReturnType<typeof verifyReleaseIntegrity> {
  const current = loadReleaseManifest(runtime.manifestPath);
  if (JSON.stringify(current) !== JSON.stringify(runtime.manifest)) {
    throw new MetaClawError('Release manifest changed after MCP startup', 'integrity_drift', {
      releaseId: runtime.manifest.releaseId,
    });
  }
  return verifyReleaseIntegrity(current, {
    maxEntries: runtime.profile.limits.maxLocalEntries,
    maxBytes: runtime.profile.limits.maxLocalBytes,
    deadlineMs: runtime.profile.limits.localReadDeadlineMs,
    budget,
  });
}

function assertRuntimeRootsDistinct(profile: MetaClawProfile, manifest: ReleaseManifest): void {
  const roots = [
    ['managed HOME', canonicalOrLiteral(profile.managedHome)],
    ['shared skills root', canonicalOrLiteral(profile.skills.root)],
    ['release root', canonicalOrLiteral(manifest.root)],
  ] as const;
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (pathsOverlap(roots[left][1], roots[right][1])) {
        throw new MetaClawError(
          `${roots[left][0]} and ${roots[right][0]} must be distinct in both directions`,
          'profile_invalid',
        );
      }
    }
  }
  const bearer = canonicalOrLiteral(profile.service.bearerFile);
  if (pathsOverlap(canonicalOrLiteral(manifest.root), bearer)) {
    throw new MetaClawError('Service bearer must not live inside the release root', 'profile_invalid');
  }
}

function assertRuntimeReleasePairing(profile: MetaClawProfile, manifest: ReleaseManifest, manifestPath: string): void {
  if (
    canonicalOrLiteral(profile.release.manifestPath) !== canonicalOrLiteral(manifestPath) ||
    profile.release.releaseId !== manifest.releaseId ||
    profile.release.official !== manifest.official
  ) {
    throw new MetaClawError('Managed profile is paired to a different release manifest', 'profile_invalid');
  }
  if (manifest.state === 'downstream_patched_candidate') {
    const claimed = profile.gates ?? {};
    const expectedEvidence: Readonly<Record<string, string>> = {
      'MCLAW-010': stableFileDigest(manifestPath),
      'MCLAW-011': manifest.provenance!.seriesSha256,
      'MCLAW-012': manifest.releaseId,
    };
    for (const [gate, evidence] of Object.entries(expectedEvidence)) {
      const entry = claimed[gate];
      if (
        entry?.satisfied === true &&
        typeof entry.evidence === 'string' &&
        entry.evidence.trim().length > 0 &&
        entry.evidence !== evidence
      ) {
        throw new MetaClawError(`${gate} profile evidence does not match the sealed candidate`, 'profile_invalid');
      }
    }
  }
  if (
    manifest.releaseId === '0.4.1+mcpsec.2-396ff44' &&
    (profile.service.identity.source !== 'health_body' || profile.service.identity.expect !== manifest.releaseId)
  ) {
    throw new MetaClawError('Downstream candidate requires an exact release identity pin', 'profile_invalid');
  }
  if (manifest.immutability) {
    const expectedExecutable = path.resolve(manifest.root, manifest.immutability.consoleScript);
    if (canonicalOrLiteral(profile.service.process.executable) !== canonicalOrLiteral(expectedExecutable)) {
      throw new MetaClawError('Managed process executable does not match the sealed console script', 'profile_invalid');
    }
  }
}

function canonicalOrLiteral(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    const resolved = path.resolve(value);
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonicalOrLiteral(parent), path.basename(resolved));
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const relative = path.relative(first, second);
  const reverse = path.relative(second, first);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative)) ||
    (!reverse.startsWith('..') && !path.isAbsolute(reverse))
  );
}

function stableFileDigest(target: string): string {
  const before = lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('not a regular file');
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  const after = lstatSync(target);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('changed during read');
  }
  return digest;
}

function profileDocument(profile: MetaClawProfile): string {
  const { endpoint: _endpoint, sourcePath: _sourcePath, ...document } = profile;
  return JSON.stringify(document);
}

interface SecretRegistry {
  readonly redact: Redactor;
  register(secret: string): void;
}

/**
 * A redactor whose secret set can grow.
 *
 * The wrapper remains stable while its registered product secrets grow, so the
 * client, transport, and error path always share the same redaction boundary.
 */
function createSecretRegistry(): SecretRegistry {
  const known = new Set<string>();
  let inner = createRedactor([]);
  const redact = ((value: unknown): string => inner(value)) as { (value: unknown): string; size: number };
  Object.defineProperty(redact, 'size', { get: () => inner.size, enumerable: true });
  return {
    redact: redact as Redactor,
    register(secret: string): void {
      if (typeof secret !== 'string' || secret.length === 0 || known.has(secret)) return;
      known.add(secret);
      inner = createRedactor([...known]);
    },
  };
}

function requiredAbsolutePath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MetaClawError(`Missing ${name}`, 'profile_invalid', { variable: name });
  }
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new MetaClawError(`${name} must be an absolute path`, 'profile_invalid', { variable: name });
  }
  return trimmed;
}
