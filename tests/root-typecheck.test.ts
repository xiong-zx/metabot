import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ROOT_TYPECHECK_PROJECTS,
  runRootTypecheck,
  type TypecheckProject,
} from '../src/release-gates/root-typecheck.js';

describe('root typecheck gate', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('checks the bridge, referenced workspaces, and supported packaged web UI explicitly', () => {
    expect(ROOT_TYPECHECK_PROJECTS).toEqual([
      { label: 'bridge', tsconfig: 'tsconfig.bridge.json' },
      { label: 'packages/cli-core', tsconfig: 'packages/cli-core/tsconfig.json' },
      { label: 'packages/metamemory', tsconfig: 'packages/metamemory/tsconfig.json' },
      { label: 'packages/skill-hub', tsconfig: 'packages/skill-hub/tsconfig.json' },
      { label: 'packages/cli', tsconfig: 'packages/cli/tsconfig.json' },
      { label: 'packages/server', tsconfig: 'packages/server/tsconfig.json' },
      { label: 'packages/web-ui', tsconfig: 'packages/web-ui/tsconfig.json' },
    ]);
  });

  it('fails when an explicitly checked child project has a type error', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-typecheck-probe-'));
    fs.mkdirSync(path.join(tmpDir, 'child', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'child', 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          target: 'ES2022',
        },
        include: ['src/**/*'],
      }),
    );
    fs.writeFileSync(path.join(tmpDir, 'child', 'src', 'index.ts'), 'export const broken: string = 1;\n');

    const result = runRootTypecheck({
      cwd: tmpDir,
      projects: [{ label: 'child', tsconfig: 'child/tsconfig.json' }],
      runner: runTscProbe,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.label).toBe('child');
  });
});

function runTscProbe(project: TypecheckProject, cwd: string): void {
  execFileSync(
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    ['-p', project.tsconfig, '--noEmit', '--pretty', 'false'],
    {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
}
