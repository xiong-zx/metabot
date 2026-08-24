import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { officialBridgePath, officialCompatibilityPath } from '../src/official-driver.js';
import { assertReleaseTreesSealed, restoreTreeDirectoriesWritable } from '../src/releases/immutability.js';
import {
  externalReleasePaths,
  installExternalReleaseCandidate,
  type CommandResult,
  type ReleaseManagerDependencies,
  type ReleaseManagerOptions,
} from '../src/releases/release-manager.js';
import { OFFICIAL_RESEARCHCLAW_COMPAT_SPEC } from '../src/releases/spec.js';
import { removeDirectory, temporaryDirectory } from './helpers.js';

const SPEC = OFFICIAL_RESEARCHCLAW_COMPAT_SPEC;
const TREE = 'df6b145fc5abf7005cf157386492bc26d010ba8c';
const TAG_COMMIT = '12d3fd809fa9658e91a0328c3280a0e462c78386';
const FREEZE = 'alpha==1.0.0\nbeta==2.0.0\n';

let root: string;
let paths: ReturnType<typeof externalReleasePaths>;
let acpx: string;
let codex: string;
let options: ReleaseManagerOptions;

function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr = ''): CommandResult {
  return { status: 1, stdout: '', stderr };
}

beforeEach(() => {
  root = realpathSync.native(temporaryDirectory('arc-sealed-install-'));
  paths = externalReleasePaths(path.join(root, 'autoresearchclaw'), SPEC);
  acpx = path.join(root, 'acpx');
  codex = path.join(root, 'codex');
  writeFileSync(acpx, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  writeFileSync(codex, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  options = {
    root: paths.root,
    bootstrapPython: '/opt/homebrew/bin/python3.11',
    bridgePath: officialBridgePath(),
    compatibilityPath: officialCompatibilityPath(),
    acpAgent: 'codex',
    spec: SPEC,
    packageDirName: 'researchclaw',
    role: 'mcp-execution',
    consoleScripts: ['researchclaw'],
  };
});

afterEach(() => {
  restoreTreeDirectoriesWritable(root);
  removeDirectory(root);
});

function dependencies(): ReleaseManagerDependencies {
  const execute = (command: string, args: string[]): CommandResult => {
    if (command === 'git') {
      if (args[0] === 'clone') {
        const packageDir = path.join(paths.source, 'researchclaw');
        mkdirSync(packageDir, { recursive: true, mode: 0o755 });
        writeFileSync(path.join(packageDir, '__init__.py'), '__version__ = "0.5.0"\n', {
          encoding: 'utf8',
          mode: 0o644,
        });
        return ok();
      }
      const key = args.filter((value) => value !== '-C' && value !== paths.source).join(' ');
      if (key === 'remote get-url origin') return ok(SPEC.repository);
      if (key === 'rev-parse HEAD') return ok(SPEC.revision);
      if (key === 'symbolic-ref -q HEAD') return fail();
      if (key === 'status --porcelain --untracked-files=all') return ok();
      if (key === 'rev-parse HEAD^{tree}') return ok(TREE);
      if (key === 'describe --tags --always HEAD') return ok('v0.5.0-45-ge2e23c9');
      if (key === 'describe --tags --abbrev=0 HEAD') return ok(SPEC.tag);
      if (key === `rev-parse refs/tags/${SPEC.tag}^{commit}`) return ok(TAG_COMMIT);
      return ok();
    }
    if (command === options.bootstrapPython && args[0] === '-m' && args[1] === 'venv') {
      const bin = path.join(paths.venv, 'bin');
      const site = path.join(paths.venv, 'lib', 'python3.11', 'site-packages');
      mkdirSync(bin, { recursive: true, mode: 0o755 });
      mkdirSync(site, { recursive: true, mode: 0o755 });
      writeFileSync(paths.python, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
      writeFileSync(path.join(bin, 'researchclaw'), '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
      writeFileSync(path.join(site, 'dependency.py'), 'VALUE = 1\n', { encoding: 'utf8', mode: 0o644 });
      return ok();
    }
    if (command === options.bootstrapPython) return ok('3.11');
    if (command === paths.python && args[0] === '-c') return ok('3.11.15');
    if (command === paths.python && args.join(' ') === '-m pip freeze --all') return ok(FREEZE);
    if (command === paths.python && args[0] === options.compatibilityPath) {
      return ok(JSON.stringify({ success: true }));
    }
    if (command === acpx) return ok(SPEC.acpxVersion);
    return ok();
  };
  return {
    execute,
    findCommand: (name) => (name === 'acpx' ? acpx : name === 'codex' ? codex : undefined),
    probe: async () => ({
      success: true,
      version: SPEC.version,
      stage_count: SPEC.stageCount,
      package_path: path.join(paths.source, 'researchclaw', '__init__.py'),
    }),
    now: () => new Date('2026-08-17T20:00:00.000Z'),
    randomId: () => 'fixed',
  };
}

describe('new release installation is recursively immutable', () => {
  it('seals source and virtualenv, preserves execution, and repeats byte-identically', async () => {
    const deps = dependencies();
    const first = await installExternalReleaseCandidate(options, deps);
    const firstBytes = readFileSync(paths.manifest);

    expect(first.release_id).toBe('0.5.0-e2e23c93b494-arc-mcp-0.3.0-v2');
    expect(first.supersedes).toEqual({
      release_id: '0.5.0-e2e23c93b494-arc-mcp-0.3.0',
      reason: SPEC.supersedes!.reason,
    });
    expect(first.immutability?.sealed).toEqual(['source', 'venv']);
    expect(assertReleaseTreesSealed(paths, first.immutability)).toEqual(first.immutability);
    expect(statSync(path.join(paths.venv, 'bin', 'researchclaw')).mode & 0o777).toBe(0o555);

    const second = await installExternalReleaseCandidate(options, deps);
    expect(second).toEqual(first);
    expect(readFileSync(paths.manifest)).toEqual(firstBytes);
  });

  it('does not rewrite a sealed manifest while failing closed on restored write permission', async () => {
    const deps = dependencies();
    await installExternalReleaseCandidate(options, deps);
    const before = readFileSync(paths.manifest);
    const dependency = path.join(paths.venv, 'lib', 'python3.11', 'site-packages', 'dependency.py');
    chmodSync(path.dirname(dependency), 0o755);
    chmodSync(dependency, 0o644);

    await expect(installExternalReleaseCandidate(options, deps)).rejects.toThrow(/virtualenv tree is not immutable.*writable/is);
    expect(readFileSync(paths.manifest)).toEqual(before);
  });

  it('refuses an escape hatch that asks for a writable new install before creating a release', async () => {
    await expect(installExternalReleaseCandidate({ ...options, sealReadOnly: false }, dependencies())).rejects.toThrow(
      /must seal both source and virtualenv/i,
    );
    expect(() => statSync(paths.release)).toThrow();
  });
});
