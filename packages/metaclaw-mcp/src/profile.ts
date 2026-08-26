import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { parseLoopbackHttpEndpoint, ConnectorError } from '@xvirobotics/mcp-connector';

import { MetaClawError } from './errors.js';

/**
 * The managed service profile.
 *
 * Official MetaClaw defaults are not safe defaults for this product: upstream
 * ships `mode=auto` and `skills.auto_evolve=true`, and its launcher rewrites
 * global OpenClaw state on every start. A safe client-side intent does not
 * change any of that. So the profile does not *describe* the service, it
 * *pins* it, and every pin below must be present and exactly equal. A missing
 * pin is a failure, not a default — the whole point is that a profile written
 * against a future upstream version cannot silently omit a control that
 * upstream has not added yet.
 *
 * Endpoint, model, bearer file, and skills root all live here rather than in
 * the environment, so a caller cannot redirect this server at another service
 * or another model by setting a variable.
 */

export const REQUIRED_PROFILE_PINS: Readonly<Record<string, string | boolean>> = Object.freeze({
  mode: 'skills_only',
  'skills.auto_evolve': false,
  'memory.enabled': false,
  'scheduler.enabled': false,
  'rl.enabled': false,
  'wechat.enabled': false,
  'openclaw.autoconfigure': false,
  'record.enabled': false,
  'proxy.host': '127.0.0.1',
  'proxy.expose_admin_routes': false,
  'proxy.expose_memory_routes': false,
});

const absolutePath = z.string().refine((value) => path.isAbsolute(value), {
  message: 'must be an absolute path',
});

const positiveInt = z.number().int().positive();
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;

/**
 * How this server establishes that the process answering the managed port is
 * the release it thinks it is.
 *
 * `health_body` names exactly one scalar field and exactly one expected value.
 * One field, named in advance, is the difference between verifying an identity
 * and reading whatever a stranger on a local port chose to send: an unpinned
 * probe response is attacker-shaped free-form JSON, and treating it as release
 * identity would let anything that binds the port declare what it is.
 *
 * `unpinned` is the honest alternative, not the convenient one. It must state
 * why no pin exists, and every result it produces is marked unverified rather
 * than quietly reported as identity.
 */
const endpointIdentitySchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('unpinned'),
      reason: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      source: z.literal('health_body'),
      field: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
      expect: z.string().min(1).max(200),
    })
    .strict(),
]);

export type EndpointIdentityPin = z.infer<typeof endpointIdentitySchema>;

const gateEvidenceSchema = z
  .object({
    satisfied: z.boolean(),
    evidence: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const mclaw014ExternalEvidenceSchema = z
  .object({
    manifestPath: absolutePath,
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    releaseId: z.string().min(1).max(200),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    sourceTree: z.string().regex(/^[0-9a-f]{40}$/),
    patchSeriesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    assuranceSchema: z.literal('metabot.autoresearchclaw.assurance.v1'),
  })
  .strict();

export const metaClawProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().min(1).max(120),
    profileRoot: absolutePath,
    activation: z
      .object({
        state: z.literal('inactive'),
        bearer: z.literal('placeholder'),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    /** Independent state root. A separate port alone does not isolate config,
     * auth, PID, scheduler, or memory state, because all of it lives in HOME. */
    managedHome: absolutePath,
    stateRoot: absolutePath,
    release: z
      .object({
        manifestPath: absolutePath,
        releaseId: z.string().min(1).max(200),
        official: z.literal(false),
      })
      .strict(),
    service: z
      .object({
        endpoint: z.string().min(1),
        bearerFile: absolutePath,
        configFile: absolutePath,
        authFile: absolutePath,
        allowedHosts: z
          .array(z.enum(['127.0.0.1', 'localhost']))
          .min(1)
          .max(2),
        /** Required, so declining to pin is a decision someone wrote down. */
        identity: endpointIdentitySchema,
        upstreamBounds: z
          .object({
            maxBodyBytes: positiveInt.max(4 * 1024 * 1024),
            maxConcurrentRequests: positiveInt.max(128),
            queueWaitSeconds: positiveInt.max(600),
            requestTimeoutSeconds: positiveInt.max(600),
            submissionWaitSeconds: positiveInt.max(600),
          })
          .strict(),
        process: z
          .object({
            pidFile: absolutePath,
            identityFile: absolutePath,
            executable: absolutePath,
            workingDirectory: absolutePath,
            managedHome: absolutePath,
          })
          .strict(),
      })
      .strict(),
    model: z
      .object({
        id: z.string().min(1).max(200),
        provider: z.string().min(1).max(120),
      })
      .strict(),
    cost: z
      .object({
        ledgerFile: absolutePath,
        maxCalls: positiveInt,
        maxInputTokens: positiveInt,
        maxOutputTokens: positiveInt,
        maxUsdMicros: positiveInt,
        inputUsdMicrosPerMillion: positiveInt,
        outputUsdMicrosPerMillion: positiveInt,
      })
      .strict(),
    skills: z
      .object({
        root: absolutePath,
        writer: z.literal('arc'),
        maxEntries: positiveInt.max(10_000),
        maxFileBytes: positiveInt.max(4 * 1024 * 1024),
      })
      .strict(),
    limits: z
      .object({
        deadlineMs: positiveInt.max(10 * 60 * 1000),
        localReadDeadlineMs: positiveInt.max(10 * 60 * 1000),
        maxLocalEntries: positiveInt.max(100_000),
        maxLocalBytes: positiveInt.max(2 * 1024 * 1024 * 1024),
        maxRequestBytes: positiveInt.max(4 * 1024 * 1024),
        maxResponseBytes: positiveInt.max(8 * 1024 * 1024),
        maxMessages: positiveInt.max(500),
        maxPromptBytes: positiveInt.max(4 * 1024 * 1024),
        maxOutputTokens: positiveInt.max(200_000),
      })
      .strict(),
    pins: z.record(z.string(), z.union([z.string(), z.boolean()])),
    rollback: z
      .object({
        snapshotsDir: absolutePath,
        initialSnapshot: absolutePath,
        initialSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    externalEvidence: z
      .object({
        'MCLAW-014': mclaw014ExternalEvidenceSchema,
      })
      .strict()
      .optional(),
    gates: z.record(z.string(), gateEvidenceSchema).optional(),
  })
  .strict();

export type MetaClawProfileInput = z.infer<typeof metaClawProfileSchema>;

export interface MetaClawProfile extends MetaClawProfileInput {
  /** Path the profile was read from, for provenance. */
  readonly sourcePath: string;
  readonly endpoint: URL;
}

export interface ProfilePinReport {
  readonly key: string;
  readonly expected: string | boolean;
  readonly actual: string | boolean | null;
  readonly ok: boolean;
}

export function inspectProfilePins(pins: Readonly<Record<string, string | boolean>>): ProfilePinReport[] {
  return Object.entries(REQUIRED_PROFILE_PINS).map(([key, expected]) => {
    const actual = Object.prototype.hasOwnProperty.call(pins, key) ? pins[key] : null;
    return { key, expected, actual: actual ?? null, ok: actual === expected };
  });
}

export function loadMetaClawProfile(profilePath: string): MetaClawProfile {
  if (!path.isAbsolute(profilePath)) {
    throw new MetaClawError('Profile path must be absolute', 'profile_invalid', { profilePath });
  }
  let info;
  try {
    info = lstatSync(profilePath);
  } catch {
    throw new MetaClawError('Managed profile is missing or unreadable', 'profile_invalid', { profilePath });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new MetaClawError('Managed profile is not a regular file', 'profile_invalid', { profilePath });
  }
  if (info.size > MAX_PROFILE_BYTES) {
    throw new MetaClawError('Managed profile exceeds its startup byte bound', 'profile_invalid', {
      maxBytes: MAX_PROFILE_BYTES,
    });
  }
  if (process.getuid && info.uid !== process.getuid()) {
    throw new MetaClawError('Managed profile is owned by another user', 'profile_invalid', { profilePath });
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new MetaClawError('Managed profile must have mode 0600', 'profile_invalid', { profilePath });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch {
    throw new MetaClawError('Managed profile is not valid JSON', 'profile_invalid', { profilePath });
  }

  const result = metaClawProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new MetaClawError('Managed profile does not match the pinned schema', 'profile_invalid', {
      profilePath,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const profile = result.data;

  const failedPins = inspectProfilePins(profile.pins).filter((pin) => !pin.ok);
  if (failedPins.length > 0) {
    throw new MetaClawError('Managed profile is missing or contradicts a required pin', 'profile_invalid', {
      profilePath,
      failedPins,
    });
  }

  let endpoint: URL;
  try {
    endpoint = parseLoopbackHttpEndpoint(profile.service.endpoint, 'service endpoint');
  } catch (cause) {
    throw new MetaClawError(
      cause instanceof ConnectorError ? cause.message : 'Managed profile endpoint is unusable',
      'profile_invalid',
      { profilePath },
    );
  }
  if (!profile.service.allowedHosts.includes(endpoint.hostname as '127.0.0.1' | 'localhost')) {
    throw new MetaClawError('Managed endpoint host is not present in the exact allowed_hosts pin', 'profile_invalid', {
      profilePath,
    });
  }

  assertDistinctRoots(profile, profilePath);
  assertContainedProfilePaths(profile, profilePath);
  assertProfilePermissions(profile, profilePath);

  return { ...profile, sourcePath: profilePath, endpoint };
}

/**
 * The managed HOME must not contain the shared skills root, and the bearer must
 * not live inside the skills root. Both would let a directory that ARC writes,
 * or that a reader walks, reach state it has no business touching.
 */
function assertDistinctRoots(profile: MetaClawProfileInput, profilePath: string): void {
  const managedHome = canonicalOrLiteral(profile.managedHome);
  const skillsRoot = canonicalOrLiteral(profile.skills.root);
  const bearerFile = canonicalOrLiteral(profile.service.bearerFile);
  if (pathsOverlap(skillsRoot, bearerFile)) {
    throw new MetaClawError('Service bearer must not live inside the shared skills root', 'profile_invalid', {
      profilePath,
    });
  }
  if (pathsOverlap(managedHome, skillsRoot)) {
    throw new MetaClawError(
      'Managed HOME and shared skills root must be distinct in both directions',
      'profile_invalid',
      {
        profilePath,
      },
    );
  }
}

function assertContainedProfilePaths(profile: MetaClawProfileInput, profilePath: string): void {
  const profileRoot = canonicalOrLiteral(profile.profileRoot);
  if (path.dirname(canonicalOrLiteral(profilePath)) !== profileRoot) {
    throw new MetaClawError('Managed profile root must be the profile file parent', 'profile_invalid', { profilePath });
  }
  const contained = [
    ['managed HOME', profile.managedHome],
    ['state root', profile.stateRoot],
    ['service bearer', profile.service.bearerFile],
    ['MetaClaw config', profile.service.configFile],
    ['MetaClaw auth', profile.service.authFile],
    ['PID file', profile.service.process.pidFile],
    ['process identity file', profile.service.process.identityFile],
    ['cost ledger', profile.cost.ledgerFile],
    ['process working directory', profile.service.process.workingDirectory],
    ['shared skills root', profile.skills.root],
    ['rollback snapshots', profile.rollback.snapshotsDir],
    ['initial rollback snapshot', profile.rollback.initialSnapshot],
  ] as const;
  for (const [label, target] of contained) {
    if (!isWithin(profileRoot, canonicalOrLiteral(target))) {
      throw new MetaClawError(`${label} must be contained by the managed profile root`, 'profile_invalid', {
        profilePath,
      });
    }
  }
  if (canonicalOrLiteral(profile.service.process.managedHome) !== canonicalOrLiteral(profile.managedHome)) {
    throw new MetaClawError('Process identity HOME must equal managed HOME', 'profile_invalid', { profilePath });
  }
  const allowedHosts = new Set(profile.service.allowedHosts);
  if (allowedHosts.size !== profile.service.allowedHosts.length) {
    throw new MetaClawError('Managed profile allowed_hosts must be unique', 'profile_invalid', { profilePath });
  }
}

function assertProfilePermissions(profile: MetaClawProfileInput, profilePath: string): void {
  for (const [label, directory] of [
    ['profile root', profile.profileRoot],
    ['managed HOME', profile.managedHome],
    ['state root', profile.stateRoot],
    ['shared skills root', profile.skills.root],
    ['process working directory', profile.service.process.workingDirectory],
    ['rollback snapshots', profile.rollback.snapshotsDir],
  ] as const) {
    assertMode(directory, label, 'directory', 0o700, profilePath);
  }
  for (const [label, file] of [
    ['service bearer', profile.service.bearerFile],
    ['MetaClaw config', profile.service.configFile],
    ['MetaClaw auth', profile.service.authFile],
    ['initial rollback snapshot', profile.rollback.initialSnapshot],
  ] as const) {
    assertMode(file, label, 'file', 0o600, profilePath);
  }
}

function assertMode(
  target: string,
  label: string,
  kind: 'file' | 'directory',
  mode: number,
  profilePath: string,
): void {
  let info;
  try {
    info = lstatSync(target);
  } catch {
    throw new MetaClawError(`${label} is missing or unreadable`, 'profile_invalid', { profilePath });
  }
  const kindMatches = kind === 'file' ? info.isFile() : info.isDirectory();
  if (info.isSymbolicLink() || !kindMatches || (info.mode & 0o777) !== mode) {
    throw new MetaClawError(`${label} must be a ${mode.toString(8).padStart(4, '0')} ${kind}`, 'profile_invalid', {
      profilePath,
    });
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || isWithin(first, second) || isWithin(second, first);
}

/**
 * Canonicalize consistently whether or not the path exists yet.
 *
 * A bearer file or skills root may legitimately be absent while a profile is
 * being prepared. Falling back to `path.resolve` alone would compare a
 * canonical root against a non-canonical child — on macOS, `/private/var`
 * against `/var` — and silently conclude they are unrelated, which is the one
 * answer these containment checks must never give by accident.
 */
function canonicalOrLiteral(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    const resolved = path.resolve(value);
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonicalOrLiteral(parent), path.basename(resolved));
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
