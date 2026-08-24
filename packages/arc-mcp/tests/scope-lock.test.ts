import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { ArcCoordinator } from '../src/coordinator.js';
import { ARC_INPUT_CONTRACT_VERSION, type ArcExecutionInput, validateArcExecutionInput } from '../src/contract.js';
import { ArcRunStore } from '../src/run-store.js';
import { ArcProjectScope } from '../src/scope-policy.js';
import { FakeArcRunner } from './fake-runner.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const cleanupDirectories: string[] = [];
const cleanupStores: ArcRunStore[] = [];

afterEach(() => {
  for (const store of cleanupStores.splice(0)) store.close();
  for (const directory of cleanupDirectories.splice(0)) removeDirectory(directory);
});

function executionInput(projectId: string, projectRoot: string, runId: string): ArcExecutionInput {
  return validateArcExecutionInput({
    contract_version: ARC_INPUT_CONTRACT_VERSION,
    project_id: projectId,
    run_id: runId,
    objective: `Scope fixture for ${runId}.`,
    project_root: projectRoot,
    artifact_path: `.metabot-arc/runs/${runId}/output.json`,
    requested_at: new Date().toISOString(),
  });
}

describe('ARC project scope and data-directory ownership', () => {
  it('fails closed without roots and hides runs outside the fixed server scope', async () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const projectA = projectDirectory(temporary, 'project-a');
    const projectB = projectDirectory(temporary, 'project-b');
    const artifacts = new ArcArtifactStore();
    expect(() => new ArcProjectScope(artifacts, { allowedProjectRoots: [] })).toThrowError(
      expect.objectContaining({ code: 'scope_not_configured' }),
    );

    const store = new ArcRunStore(path.join(temporary, 'state'));
    cleanupStores.push(store);
    for (const [projectId, projectRoot, runId] of [
      ['project-a', projectA, 'run-a'],
      ['project-b', projectB, 'run-b'],
    ] as const) {
      store.createRun({
        runId,
        projectId,
        projectRoot,
        objective: `Scope fixture for ${runId}.`,
        idempotencyKey: `request-${runId}`,
        requestFingerprint: `fingerprint-${runId}`,
        artifactPath: `.metabot-arc/runs/${runId}/output.json`,
        executionInput: executionInput(projectId, projectRoot, runId),
        now: new Date().toISOString(),
      });
    }
    const coordinator = new ArcCoordinator(store, artifacts, new FakeArcRunner(), {
      scope: new ArcProjectScope(artifacts, {
        allowedProjectRoots: [projectA],
        fixedProjectId: 'project-a',
      }),
    });

    expect(coordinator.list({})).toEqual([expect.objectContaining({ run_id: 'run-a' })]);
    expect(() => coordinator.get({ run_id: 'run-b' })).toThrowError(expect.objectContaining({ code: 'scope_denied' }));
    await expect(coordinator.cancel({ run_id: 'run-b' })).rejects.toMatchObject({
      code: 'scope_denied',
    });
    await expect(coordinator.pause({ run_id: 'run-b' })).rejects.toMatchObject({
      code: 'scope_denied',
    });
    await expect(coordinator.resume({ run_id: 'run-b' })).rejects.toMatchObject({
      code: 'scope_denied',
    });
    await expect(
      coordinator.start({
        project_id: 'project-b',
        project_root: projectB,
        objective: 'Must be denied.',
        idempotency_key: 'denied',
      }),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(
      coordinator.start({
        project_id: 'project-a',
        project_root: projectB,
        objective: 'A matching project ID cannot expand the root scope.',
        idempotency_key: 'denied-root',
      }),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    expect(() => coordinator.list({ project_id: 'project-b' })).toThrowError(
      expect.objectContaining({ code: 'scope_denied' }),
    );
  });

  it('rejects a second live owner and releases the lock on close', () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const dataDir = path.join(temporary, 'state');
    const first = new ArcRunStore(dataDir);
    expect(() => new ArcRunStore(dataDir)).toThrowError(
      expect.objectContaining({
        code: 'data_dir_locked',
        details: expect.objectContaining({ ownerState: 'live' }),
      }),
    );
    first.close();
    const replacement = new ArcRunStore(dataDir);
    cleanupStores.push(replacement);
  });

  it('archives a verifiably stale local owner with diagnostics', () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const dataDir = path.join(temporary, 'state');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, '.arc-mcp.lock'),
      `${JSON.stringify({
        instance_id: randomUUID(),
        pid: 2_000_000_000,
        hostname: hostname(),
        started_at: new Date(0).toISOString(),
      })}\n`,
      'utf8',
    );
    const store = new ArcRunStore(dataDir);
    cleanupStores.push(store);
    expect(store.lock.staleLocks).toHaveLength(1);
    expect(store.lock.staleLocks[0]?.owner.pid).toBe(2_000_000_000);
    expect(existsSync(store.lock.staleLocks[0]!.archivePath)).toBe(true);
  });

  it('rejects a filesystem root as state or project scope', () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    expect(() => new ArcRunStore(filesystemRoot)).toThrowError(expect.objectContaining({ code: 'invalid_contract' }));
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const rootAlias = path.join(temporary, 'root-alias');
    symlinkSync(filesystemRoot, rootAlias, 'dir');
    expect(() => new ArcRunStore(rootAlias)).toThrowError(expect.objectContaining({ code: 'invalid_contract' }));
    const artifacts = new ArcArtifactStore();
    expect(() => new ArcProjectScope(artifacts, { allowedProjectRoots: [filesystemRoot] })).toThrowError(
      expect.objectContaining({ code: 'scope_not_configured' }),
    );
  });
});
