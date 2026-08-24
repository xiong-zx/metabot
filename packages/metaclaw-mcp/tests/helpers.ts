import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { GateEvidence } from '../src/gates.js';
import { METACLAW_GATES } from '../src/gates.js';

/**
 * Every fixture here is local: a temporary directory, a fake release tree, a
 * disposable Ed25519 keypair, and an injected fetch. Nothing in this suite
 * contacts a MetaClaw service, starts one, or reads the operator's real
 * `~/.metaclaw`, `~/.openclaw`, or `~/.metabot` state.
 */

const created: string[] = [];

export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) {
    makeDirectoriesWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeDirectoriesWritable(root: string): void {
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) makeDirectoriesWritable(path.join(root, name));
}

export interface Fixture {
  readonly root: string;
  readonly profilePath: string;
  readonly manifestPath: string;
  readonly bearerPath: string;
  readonly skillsRoot: string;
  readonly releaseRoot: string;
  readonly releaseFile: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface FixtureOptions {
  /** Gate evidence written into the profile. Default: every gate open. */
  gates?: Record<string, GateEvidence>;
  profileOverrides?: (profile: Record<string, any>) => Record<string, any>;
  manifestOverrides?: (manifest: Record<string, any>) => Record<string, any>;
}

export const ALL_GATES_SATISFIED: Record<string, GateEvidence> = Object.fromEntries(
  METACLAW_GATES.map((gate) => [gate.id, { satisfied: true, evidence: `__EXACT_FIXTURE_${gate.id}__` }]),
);

function exactFixtureGates(
  declared: Record<string, GateEvidence>,
  manifest: Record<string, any>,
  manifestPath: string,
): Record<string, GateEvidence> {
  return Object.fromEntries(
    Object.entries(declared).map(([id, evidence]) => {
      if (evidence.evidence !== `__EXACT_FIXTURE_${id}__`) return [id, evidence];
      const exact =
        id === 'MCLAW-010'
          ? createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
          : id === 'MCLAW-011'
            ? manifest.provenance.seriesSha256
            : id === 'MCLAW-012'
              ? manifest.releaseId
              : `fixture evidence for ${id}`;
      return [id, { ...evidence, evidence: exact }];
    }),
  );
}

export function createFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'metaclaw-mcp-fixture-'));
  created.push(root);

  const profileRoot = path.join(root, 'profile');
  const managedHome = path.join(profileRoot, 'home');
  const stateRoot = path.join(profileRoot, 'state');
  const releaseRoot = path.join(root, 'release');
  const skillsRoot = path.join(profileRoot, 'skills');
  const secretsRoot = path.join(profileRoot, 'secrets');
  const rollbackRoot = path.join(profileRoot, 'rollback');
  const configRoot = path.join(managedHome, '.metaclaw');
  for (const directory of [profileRoot, managedHome, stateRoot, skillsRoot, secretsRoot, rollbackRoot, configRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });

  const bearerPath = path.join(secretsRoot, 'service-bearer');
  writePrivate(bearerPath, 'fixture-service-bearer-value\n');
  const configPath = writePrivate(path.join(configRoot, 'config.yaml'), '{}\n');
  const authPath = writePrivate(path.join(configRoot, 'auth.json'), '{}\n');
  const snapshotBody = '{"state":"inactive"}\n';
  const snapshotPath = writePrivate(path.join(rollbackRoot, '0001-inactive.json'), snapshotBody);

  const sourceRoot = path.join(releaseRoot, 'source');
  const venvBin = path.join(releaseRoot, 'venv', 'bin');
  const wheelsRoot = path.join(releaseRoot, 'wheels');
  for (const directory of [sourceRoot, venvBin, wheelsRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const releaseFile = path.join(sourceRoot, 'metaclaw.py');
  const releaseBody = 'print("fixture release")\n';
  writeFileSync(releaseFile, releaseBody, { mode: 0o444 });
  const consolePath = path.join(venvBin, 'metaclaw');
  const consoleBody = '#!/usr/bin/env python3\n';
  writeFileSync(consolePath, consoleBody, { mode: 0o555 });
  const wheelPath = path.join(wheelsRoot, 'aiming_metaclaw-0.4.1-py3-none-any.whl');
  const wheelBody = 'fixture wheel\n';
  writeFileSync(wheelPath, wheelBody, { mode: 0o444 });
  const freezePath = path.join(releaseRoot, 'requirements.freeze.txt');
  const freezeBody = 'aiming-metaclaw==0.4.1\n';
  writeFileSync(freezePath, freezeBody, { mode: 0o444 });
  for (const directory of [sourceRoot, path.dirname(venvBin), venvBin, wheelsRoot, releaseRoot])
    chmodSync(directory, 0o555);

  const oldManifestPath = path.join(root, 'official-v0.4.1-manifest.json');
  const oldManifestBody = '{"release_id":"0.4.1-aea4f3382d56"}\n';
  writeFileSync(oldManifestPath, oldManifestBody, { mode: 0o600 });
  const releaseDigest = createHash('sha256').update(releaseBody).digest('hex');
  const consoleDigest = createHash('sha256').update(consoleBody).digest('hex');
  const wheelDigest = createHash('sha256').update(wheelBody).digest('hex');
  const freezeDigest = createHash('sha256').update(freezeBody).digest('hex');
  const series = JSON.parse(
    readFileSync(new URL('../release-tools/security-series.json', import.meta.url), 'utf8'),
  ) as Record<string, any>;

  const manifest = (options.manifestOverrides ?? ((value) => value))({
    schemaVersion: 1,
    releaseId: series.releaseId,
    product: 'MetaClaw',
    version: '0.4.1',
    official: false,
    state: 'downstream_patched_candidate',
    tag: 'v0.4.1',
    commit: series.candidateCommit,
    root: releaseRoot,
    files: [
      {
        path: 'source/metaclaw.py',
        sha256: releaseDigest,
        bytes: Buffer.byteLength(releaseBody),
        mode: '0444',
      },
      {
        path: 'venv/bin/metaclaw',
        sha256: consoleDigest,
        bytes: Buffer.byteLength(consoleBody),
        mode: '0555',
      },
      {
        path: 'wheels/aiming_metaclaw-0.4.1-py3-none-any.whl',
        sha256: wheelDigest,
        bytes: Buffer.byteLength(wheelBody),
        mode: '0444',
      },
      {
        path: 'requirements.freeze.txt',
        sha256: freezeDigest,
        bytes: Buffer.byteLength(freezeBody),
        mode: '0444',
      },
    ],
    directories: [
      { path: 'source', mode: '0555' },
      { path: 'venv', mode: '0555' },
      { path: 'venv/bin', mode: '0555' },
      { path: 'wheels', mode: '0555' },
    ],
    provenance: {
      official: false,
      class: 'downstream_patched_candidate',
      sourcePath: path.join(root, 'source-checkout'),
      upstream: {
        repository: series.repository,
        tag: series.tag,
        tagCommit: series.tagCommit,
        baseCommit: series.baseCommit,
        baseTree: series.baseTree,
      },
      patches: series.patches,
      seriesSha256: series.seriesSha256,
      resultTree: series.candidateTree,
      installedSourceSha256: createHash('sha256')
        .update(`source/metaclaw.py:${Buffer.byteLength(releaseBody)}:${releaseDigest}\n`)
        .digest('hex'),
    },
    build: {
      format: 'wheel',
      wheelFile: 'wheels/aiming_metaclaw-0.4.1-py3-none-any.whl',
      wheelSha256: wheelDigest,
      editable: false,
      sourceDateEpoch: 1,
    },
    dependencies: {
      freezeFile: 'requirements.freeze.txt',
      sha256: freezeDigest,
      entries: 1,
      pythonVersion: '3.11.0',
      source: { kind: 'pip_resolved' },
    },
    immutability: {
      mode: 'recursive_read_only',
      rootMode: '0555',
      roots: ['source', 'venv'],
      consoleScript: 'venv/bin/metaclaw',
    },
    integration: { package: '@xvirobotics/metaclaw-mcp', version: '0.1.0' },
    supersedes: {
      releaseId: '0.4.1-aea4f3382d56',
      manifestPath: oldManifestPath,
      manifestSha256: createHash('sha256').update(oldManifestBody).digest('hex'),
      reason:
        'Replaced append-only by the non-editable, recursively sealed official=false security candidate; old evidence is not rewritten.',
    },
    limitations: ['fixture is an unofficial downstream candidate'],
  });
  const manifestPath = path.join(root, 'release-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o444 });

  const profile = (options.profileOverrides ?? ((value) => value))({
    schemaVersion: 1,
    profileId: 'metaclaw-managed-fixture',
    profileRoot,
    activation: {
      state: 'inactive',
      bearer: 'placeholder',
      reason: 'fixture remains inactive',
    },
    managedHome,
    stateRoot,
    release: {
      manifestPath,
      releaseId: series.releaseId,
      official: false,
    },
    service: {
      endpoint: 'http://127.0.0.1:9412',
      bearerFile: bearerPath,
      configFile: configPath,
      authFile: authPath,
      allowedHosts: ['127.0.0.1', 'localhost'],
      identity: { source: 'health_body', field: 'release_id', expect: series.releaseId },
      upstreamBounds: {
        maxBodyBytes: 256 * 1024,
        maxConcurrentRequests: 1,
        queueWaitSeconds: 1,
        requestTimeoutSeconds: 60,
        submissionWaitSeconds: 5,
      },
      process: {
        pidFile: path.join(stateRoot, 'metaclaw-9412.pid'),
        identityFile: path.join(stateRoot, 'metaclaw-9412.identity.json'),
        executable: consolePath,
        workingDirectory: stateRoot,
        managedHome,
      },
    },
    model: { id: 'fixture-pinned-model', provider: 'fixture-provider' },
    cost: {
      ledgerFile: path.join(stateRoot, 'cost-ledger.json'),
      maxCalls: 100,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
      maxUsdMicros: 100_000_000,
      inputUsdMicrosPerMillion: 1_000_000,
      outputUsdMicrosPerMillion: 2_000_000,
    },
    skills: { root: skillsRoot, writer: 'arc', maxEntries: 100, maxFileBytes: 64 * 1024 },
    limits: {
      deadlineMs: 30_000,
      localReadDeadlineMs: 5_000,
      maxLocalEntries: 1_000,
      maxLocalBytes: 4 * 1024 * 1024,
      maxRequestBytes: 256 * 1024,
      maxResponseBytes: 512 * 1024,
      maxMessages: 20,
      maxPromptBytes: 64 * 1024,
      maxOutputTokens: 1_024,
    },
    pins: {
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
    },
    rollback: {
      snapshotsDir: rollbackRoot,
      initialSnapshot: snapshotPath,
      initialSnapshotSha256: createHash('sha256').update(snapshotBody).digest('hex'),
    },
    gates: exactFixtureGates(options.gates ?? {}, manifest, manifestPath),
  });
  const profilePath = path.join(profileRoot, 'profile.json');
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });

  return {
    root,
    profilePath,
    manifestPath,
    bearerPath,
    skillsRoot,
    releaseRoot,
    releaseFile,
    env: {
      METACLAW_MCP_PROFILE_FILE: profilePath,
      METACLAW_MCP_RELEASE_MANIFEST: manifestPath,
    },
  };
}

export function writePrivate(target: string, content: string): string {
  writeFileSync(target, content, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

export function writeSkill(skillsRoot: string, name: string, body: string): string {
  const directory = path.join(skillsRoot, name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'SKILL.md');
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface FakeService {
  readonly requests: RecordedRequest[];
  readonly fetchImpl: typeof fetch;
}

/** A local fake. No socket is opened and no MetaClaw process is contacted. */
export function fakeService(respond: (request: RecordedRequest) => Response | Promise<Response>): FakeService {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const record: RecordedRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(record);
    return respond(record);
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
