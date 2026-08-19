import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertReleaseTreesSealed,
  restoreTreeDirectoriesWritable,
  sealReleaseTrees,
  RELEASE_IMMUTABILITY_MODE,
  type SealedTreePaths,
} from '../src/releases/immutability.js';
import { removeDirectory } from './helpers.js';

/**
 * Sealing is a permission change on two real trees, so these exercise real
 * directories rather than a mocked filesystem: a check that only looks right
 * against a fake tree is exactly the check that let a writable virtualenv ship.
 */

let root: string;
let paths: SealedTreePaths;

/** A system interpreter the fixture's virtualenv link may legitimately reach. */
const SYSTEM_PYTHON = probeSystemPython();

function probeSystemPython(): string | null {
  const candidate = process.env.METABOT_ARC_TEST_PYTHON ?? 'python3';
  const found = spawnSync('command', ['-v', candidate], { encoding: 'utf8', shell: true });
  const resolved = (found.stdout ?? '').trim().split('\n')[0]?.trim();
  if (found.status !== 0 || !resolved) return null;
  return spawnSync(resolved, ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0 ? resolved : null;
}

function buildRelease(): void {
  const source = path.join(paths.source, 'researchclaw', 'pipeline');
  mkdirSync(source, { recursive: true, mode: 0o755 });
  writeFileSync(path.join(paths.source, 'researchclaw', '__init__.py'), '', { encoding: 'utf8', mode: 0o644 });
  writeFileSync(path.join(source, 'runner.py'), 'pass\n', { encoding: 'utf8', mode: 0o644 });

  const bin = path.join(paths.venv, 'bin');
  const sitePackages = path.join(paths.venv, 'lib', 'python3.11', 'site-packages');
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  mkdirSync(sitePackages, { recursive: true, mode: 0o755 });
  writeFileSync(path.join(paths.venv, 'pyvenv.cfg'), 'version = 3.11.15\n', { encoding: 'utf8', mode: 0o644 });
  writeFileSync(path.join(bin, 'researchclaw'), '#!/bin/sh\necho ok\n', { encoding: 'utf8', mode: 0o755 });
  writeFileSync(path.join(sitePackages, 'demo.py'), 'VALUE = 1\n', { encoding: 'utf8', mode: 0o644 });
  if (SYSTEM_PYTHON) {
    symlinkSync(SYSTEM_PYTHON, path.join(bin, 'python3.11'));
    symlinkSync('python3.11', path.join(bin, 'python3'));
  }
}

beforeEach(() => {
  // Short prefix: the virtualenv console-script fixture writes a real `#!`
  // shebang, which some kernels truncate past 128 bytes.
  root = mkdtempSync(path.join(tmpdir(), 'arc-im-'));
  const release = path.join(root, 'r');
  paths = { release, source: path.join(release, 'source'), venv: path.join(release, 'venv') };
  mkdirSync(release, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  // The production cleanup path, so removing a sealed fixture exercises the
  // same helper a failed install relies on.
  restoreTreeDirectoriesWritable(root);
  removeDirectory(root);
});

function writableNodes(tree: string): string[] {
  const found: string[] = [];
  const pending = [tree];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if ((statSync(directory).mode & 0o222) !== 0) found.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(candidate);
      else if ((statSync(candidate).mode & 0o222) !== 0) found.push(candidate);
    }
  }
  return found;
}

describe('recursive source and virtualenv sealing', () => {
  it('leaves no writable node in either tree', () => {
    buildRelease();
    sealReleaseTrees(paths);
    expect(writableNodes(paths.source)).toEqual([]);
    expect(writableNodes(paths.venv)).toEqual([]);
  });

  it('preserves the executable bit a console script needs', () => {
    buildRelease();
    const script = path.join(paths.venv, 'bin', 'researchclaw');
    sealReleaseTrees(paths);
    expect(statSync(script).mode & 0o777).toBe(0o555);
    expect(statSync(path.join(paths.venv, 'pyvenv.cfg')).mode & 0o777).toBe(0o444);
    // Directories keep execute permission, or nothing inside could be read.
    expect(statSync(path.join(paths.venv, 'bin')).mode & 0o777).toBe(0o555);
  });

  it('keeps a private file private rather than widening it', () => {
    buildRelease();
    const secretive = path.join(paths.source, 'owner-only.txt');
    writeFileSync(secretive, 'x\n', { encoding: 'utf8', mode: 0o600 });
    sealReleaseTrees(paths);
    expect(statSync(secretive).mode & 0o777).toBe(0o400);
  });

  it('records a census that a later verification reproduces exactly', () => {
    buildRelease();
    const record = sealReleaseTrees(paths);
    expect(record.mode).toBe(RELEASE_IMMUTABILITY_MODE);
    expect(record.sealed).toEqual(['source', 'venv']);
    expect(record.trees.source.files).toBe(2);
    expect(record.trees.venv.files).toBe(3);
    expect(record.trees.venv.interpreter_links).toBe(SYSTEM_PYTHON ? 2 : 0);
    expect(assertReleaseTreesSealed(paths, record)).toEqual(record);
  });
});

describe('verification fails closed', () => {
  it('refuses a file that was made writable again', () => {
    buildRelease();
    const record = sealReleaseTrees(paths);
    const restored = path.join(paths.venv, 'lib', 'python3.11', 'site-packages', 'demo.py');
    chmodSync(path.dirname(restored), 0o755);
    chmodSync(restored, 0o644);
    // Only the file stays writable, so the failure names the file rather than
    // the directory that had to be reopened to reach it.
    chmodSync(path.dirname(restored), 0o555);
    expect(() => assertReleaseTreesSealed(paths, record)).toThrow(/is not immutable.*demo\.py is writable/s);
  });

  it('refuses a directory that was made writable again', () => {
    buildRelease();
    const record = sealReleaseTrees(paths);
    chmodSync(path.join(paths.source, 'researchclaw'), 0o755);
    expect(() => assertReleaseTreesSealed(paths, record)).toThrow(/source tree is not immutable/i);
  });

  it('refuses a virtualenv whose seal was never applied', () => {
    buildRelease();
    expect(() => assertReleaseTreesSealed(paths)).toThrow(/source tree is not immutable/i);
  });

  it('refuses a node that gained or vanished under a restored directory', () => {
    buildRelease();
    const record = sealReleaseTrees(paths);
    const sitePackages = path.join(paths.venv, 'lib', 'python3.11', 'site-packages');
    chmodSync(sitePackages, 0o755);
    writeFileSync(path.join(sitePackages, 'sneaked.py'), '', { encoding: 'utf8', mode: 0o444 });
    chmodSync(sitePackages, 0o555);
    expect(() => assertReleaseTreesSealed(paths, record)).toThrow(/venv tree drifted from the sealed census/i);
  });

  it('refuses a manifest census that claims a tree it did not seal', () => {
    buildRelease();
    const record = sealReleaseTrees(paths);
    expect(() =>
      assertReleaseTreesSealed(paths, { ...record, sealed: ['source'] }),
    ).toThrow(/does not claim to have sealed its venv tree/i);
  });

  it('refuses an unknown immutability mode rather than treating it as this one', () => {
    buildRelease();
    const record = sealReleaseTrees(paths);
    expect(() =>
      assertReleaseTreesSealed(paths, { ...record, mode: 'read-only-ish' as never }),
    ).toThrow(/unknown immutability mode/i);
  });
});

describe('symlinks and unsafe nodes', () => {
  it('refuses any symlink in the source tree', () => {
    buildRelease();
    symlinkSync(path.join(paths.source, 'researchclaw', '__init__.py'), path.join(paths.source, 'alias.py'));
    expect(() => sealReleaseTrees(paths)).toThrow(/source tree contains an unsafe symlink/i);
  });

  it('refuses a symlink outside the virtualenv bin directory', () => {
    buildRelease();
    symlinkSync(
      path.join(paths.venv, 'pyvenv.cfg'),
      path.join(paths.venv, 'lib', 'python3.11', 'site-packages', 'alias.cfg'),
    );
    expect(() => sealReleaseTrees(paths)).toThrow(/only a virtualenv interpreter link may be a symlink/i);
  });

  it('accepts the exact root-level lib64 link created by Linux virtualenvs', () => {
    buildRelease();
    symlinkSync('lib', path.join(paths.venv, 'lib64'));
    const record = sealReleaseTrees(paths);
    expect(record.trees.venv.interpreter_links).toBe((SYSTEM_PYTHON ? 2 : 0) + 1);
    expect(() => assertReleaseTreesSealed(paths, record)).not.toThrow();
  });

  it('refuses a root-level lib64 link that does not point exactly to lib', () => {
    buildRelease();
    symlinkSync('bin', path.join(paths.venv, 'lib64'));
    expect(() => sealReleaseTrees(paths)).toThrow(/lib64 link must point exactly to lib/i);
  });

  it('refuses a bin symlink that is not an interpreter name', () => {
    buildRelease();
    symlinkSync(path.join(paths.venv, 'bin', 'researchclaw'), path.join(paths.venv, 'bin', 'rc'));
    expect(() => sealReleaseTrees(paths)).toThrow(/not an interpreter name/i);
  });

  it('refuses an interpreter link that reaches back into the sealed release', () => {
    buildRelease();
    symlinkSync(path.join(paths.source, 'researchclaw', '__init__.py'), path.join(paths.venv, 'bin', 'python9'));
    expect(() => sealReleaseTrees(paths)).toThrow(/reaches into the sealed release/i);
  });

  it('refuses an interpreter link that traverses upwards', () => {
    buildRelease();
    symlinkSync('../../source/researchclaw/__init__.py', path.join(paths.venv, 'bin', 'python9'));
    expect(() => sealReleaseTrees(paths)).toThrow(/traverses upwards/i);
  });

  it('refuses a dangling interpreter link', () => {
    buildRelease();
    symlinkSync(path.join(root, 'no-such-interpreter'), path.join(paths.venv, 'bin', 'python9'));
    expect(() => sealReleaseTrees(paths)).toThrow(/does not resolve/i);
  });

  it.skipIf(spawnSync('command', ['-v', 'mkfifo'], { shell: true }).status !== 0)(
    'refuses a node that is neither a file nor a directory',
    () => {
      buildRelease();
      const fifo = path.join(paths.venv, 'bin', 'queue');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      expect(() => sealReleaseTrees(paths)).toThrow(/neither a file nor a directory/i);
    },
  );

  it.skipIf(!SYSTEM_PYTHON)('accepts the interpreter links a virtualenv cannot exist without', () => {
    buildRelease();
    const record = sealReleaseTrees(paths);
    expect(record.trees.venv.interpreter_links).toBe(2);
    expect(() => assertReleaseTreesSealed(paths, record)).not.toThrow();
  });
});

describe('a sealed virtualenv still executes', () => {
  it('runs a console script whose executable bit survived sealing', () => {
    buildRelease();
    sealReleaseTrees(paths);
    const result = spawnSync(path.join(paths.venv, 'bin', 'researchclaw'), ['--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  it.skipIf(!SYSTEM_PYTHON)('runs a Python console script that imports from a sealed site-packages', () => {
    // A real virtualenv, so the interpreter link, `pyvenv.cfg` prefix
    // detection and site-packages import path are the real ones rather than a
    // fixture's idea of them.
    const venv = paths.venv;
    const created = spawnSync(SYSTEM_PYTHON!, ['-m', 'venv', '--without-pip', venv], { encoding: 'utf8' });
    if (created.status !== 0) {
      throw new Error(`could not create a virtualenv fixture: ${created.stderr || created.stdout}`);
    }
    mkdirSync(paths.source, { recursive: true, mode: 0o755 });
    writeFileSync(path.join(paths.source, 'marker.txt'), 'sealed\n', { encoding: 'utf8', mode: 0o644 });

    const python = path.join(venv, 'bin', 'python3');
    const purelib = spawnSync(python, ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], {
      encoding: 'utf8',
    });
    expect(purelib.status).toBe(0);
    const sitePackages = purelib.stdout.trim();
    mkdirSync(path.join(sitePackages, 'arc_demo'), { recursive: true, mode: 0o755 });
    writeFileSync(
      path.join(sitePackages, 'arc_demo', '__init__.py'),
      'def main():\n    print("sealed console script ok")\n    return 0\n',
      { encoding: 'utf8', mode: 0o644 },
    );
    // The exact shape pip gives a console script: a shebang naming the
    // virtualenv's own interpreter, then an import from site-packages.
    const script = path.join(venv, 'bin', 'arc-demo');
    writeFileSync(script, `#!${python}\nimport sys\nfrom arc_demo import main\nsys.exit(main())\n`, {
      encoding: 'utf8',
      mode: 0o755,
    });

    const record = sealReleaseTrees(paths);
    const executed = spawnSync(script, [], { encoding: 'utf8' });
    expect(executed.stderr).toBe('');
    expect(executed.status).toBe(0);
    expect(executed.stdout.trim()).toBe('sealed console script ok');
    // Executing it could not write a bytecode cache into the sealed tree, so
    // the census the manifest recorded still describes the tree exactly.
    expect(() => assertReleaseTreesSealed(paths, record)).not.toThrow();
    expect(existsSync(path.join(sitePackages, 'arc_demo', '__pycache__'))).toBe(false);
  });
});

describe('failed installs stay removable', () => {
  it('restores directory write permission without widening any file', () => {
    buildRelease();
    sealReleaseTrees(paths);
    const file = path.join(paths.source, 'researchclaw', 'pipeline', 'runner.py');
    restoreTreeDirectoriesWritable(paths.release);
    expect(statSync(path.dirname(file)).mode & 0o200).not.toBe(0);
    // Files keep the modes they were sealed with: a local clone hardlinks its
    // git objects into the staging repository that supplied them, so widening
    // a file here would widen it there too.
    expect(statSync(file).mode & 0o222).toBe(0);
    expect(() => removeDirectory(paths.release)).not.toThrow();
    expect(existsSync(paths.release)).toBe(false);
  });
});
