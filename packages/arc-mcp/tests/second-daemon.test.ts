import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ArcRunStore } from '../src/run-store.js';
import { createArcRuntime } from '../src/runtime.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const require = createRequire(import.meta.url);
const secondRuntime = fileURLToPath(new URL('./fixtures/second-runtime.ts', import.meta.url));
const fakeRunnerModule = fileURLToPath(new URL('./fixtures/lock-runner.mjs', import.meta.url));

const roots: string[] = [];

function trackedRoot(): string {
  const root = temporaryDirectory('arc-second-daemon-');
  roots.push(root);
  return root;
}

function environment(dataDir: string, projectRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARC_MCP_DATA_DIR: dataDir,
    ARC_MCP_PROJECT_ROOTS: JSON.stringify([projectRoot]),
    ARC_MCP_RUNNER_MODULE: fakeRunnerModule,
    ARC_MCP_RELEASE_ROOT: '',
  };
}

function runSecondDaemon(env: NodeJS.ProcessEnv): { status: number | null; result: Record<string, unknown> } {
  const child = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(require.resolve('tsx')).href, secondRuntime],
    { encoding: 'utf8', env, timeout: 30_000 },
  );
  const line = child.stdout.trim().split('\n').at(-1) ?? '';
  return { status: child.status, result: JSON.parse(line) as Record<string, unknown> };
}

afterEach(() => {
  for (const root of roots.splice(0)) removeDirectory(root);
});

/**
 * ARC's durable run ownership is only safe while exactly one process writes the
 * lifecycle database. These tests prove that invariant against a genuinely
 * separate operating-system process, not just a second object in this one.
 */
describe('single ARC lifecycle owner', () => {
  it('refuses a second daemon process on a data directory a live daemon owns', async () => {
    const root = trackedRoot();
    const dataDir = path.join(root, 'data');
    const projectRoot = projectDirectory(root);
    const env = environment(dataDir, projectRoot);

    const first = await createArcRuntime({ env });
    try {
      const lockPath = path.join(dataDir, '.arc-mcp.lock');
      expect(existsSync(lockPath)).toBe(true);
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
      expect(owner.pid).toBe(process.pid);

      const second = runSecondDaemon(env);
      expect(second.status).not.toBe(0);
      expect(second.result).toMatchObject({ acquired: false, code: 'data_dir_locked' });
      expect(String(second.result.message)).toMatch(/owned by another server/i);

      // The refusal must not disturb the live owner's lock or its database.
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(owner);
      expect(readdirSync(dataDir).filter((name) => name.startsWith('.arc-mcp.lock.stale-'))).toEqual([]);
      expect(first.store.listRuns({ projectRoots: [projectRoot] })).toEqual([]);
    } finally {
      first.coordinator.dispose();
      first.store.close();
    }
  });

  it('lets the next daemon take over only after the owner released the directory', async () => {
    const root = trackedRoot();
    const dataDir = path.join(root, 'data');
    const projectRoot = projectDirectory(root);
    const env = environment(dataDir, projectRoot);

    const first = await createArcRuntime({ env });
    first.coordinator.dispose();
    first.store.close();

    const second = runSecondDaemon(env);
    expect(second.status).toBe(0);
    expect(second.result).toEqual({ acquired: true });
  });

  it('refuses a second writer even when it opens the store directly', () => {
    const root = trackedRoot();
    const dataDir = path.join(root, 'data');
    const first = new ArcRunStore(dataDir);
    try {
      expect(() => new ArcRunStore(dataDir)).toThrowError(
        expect.objectContaining({ code: 'data_dir_locked' }),
      );
    } finally {
      first.close();
    }
  });
});
