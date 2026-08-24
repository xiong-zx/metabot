import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MetaClawError } from '../src/errors.js';
import { assertReleaseIntact, loadReleaseManifest, verifyReleaseIntegrity } from '../src/integrity.js';
import { cleanupFixtures, createFixture } from './helpers.js';

afterEach(cleanupFixtures);

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof MetaClawError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

const limits = { maxEntries: 1_000, maxBytes: 4 * 1024 * 1024, deadlineMs: 5_000 } as const;

describe('release manifest', () => {
  it('loads a candidate manifest and reports it as not official', async () => {
    const fixture = createFixture();
    const manifest = loadReleaseManifest(fixture.manifestPath);
    expect(manifest.official).toBe(false);
    expect(manifest.state).toBe('downstream_patched_candidate');
    expect((await verifyReleaseIntegrity(manifest, limits)).ok).toBe(true);
  });

  it('refuses a manifest whose official flag contradicts its state', async () => {
    const lying = createFixture({
      manifestOverrides: (manifest) => ({ ...manifest, official: true }),
    });
    expect(await codeOf(() => loadReleaseManifest(lying.manifestPath))).toBe('profile_invalid');

    const alsoLying = createFixture({
      manifestOverrides: (manifest) => ({ ...manifest, state: 'official_release' }),
    });
    expect(await codeOf(() => loadReleaseManifest(alsoLying.manifestPath))).toBe('profile_invalid');
  });

  it('accepts a coherent official manifest', () => {
    const fixture = createFixture({
      manifestOverrides: (manifest) => ({
        schemaVersion: manifest.schemaVersion,
        releaseId: '0.4.1-aea4f3382d56',
        official: true,
        state: 'official_release',
        tag: manifest.tag,
        commit: manifest.commit,
        root: manifest.root,
        files: manifest.files.map(
          ({ mode: _mode, ...file }: { mode: string; path: string; sha256: string; bytes: number }) => file,
        ),
      }),
    });
    expect(loadReleaseManifest(fixture.manifestPath).official).toBe(true);
  });

  it('refuses a malformed commit, an empty file list, and unknown fields', async () => {
    expect(
      await codeOf(() =>
        loadReleaseManifest(
          createFixture({
            manifestOverrides: (manifest) => ({ ...manifest, commit: 'not-a-sha' }),
          }).manifestPath,
        ),
      ),
    ).toBe('profile_invalid');
    expect(
      await codeOf(() =>
        loadReleaseManifest(
          createFixture({
            manifestOverrides: (manifest) => ({ ...manifest, files: [] }),
          }).manifestPath,
        ),
      ),
    ).toBe('profile_invalid');
    expect(
      await codeOf(() =>
        loadReleaseManifest(
          createFixture({
            manifestOverrides: (manifest) => ({ ...manifest, editable: true }),
          }).manifestPath,
        ),
      ),
    ).toBe('profile_invalid');
  });

  it('refuses a well-formed but unreviewed downstream base or patch identity', async () => {
    const wrongBase = createFixture({
      manifestOverrides: (manifest) => ({
        ...manifest,
        provenance: {
          ...manifest.provenance,
          upstream: { ...manifest.provenance.upstream, baseCommit: 'f'.repeat(40) },
        },
      }),
    });
    expect(await codeOf(() => loadReleaseManifest(wrongBase.manifestPath))).toBe('profile_invalid');
  });
});

describe('release integrity', () => {
  it('detects a single changed byte and fails inference closed', async () => {
    const fixture = createFixture();
    const manifest = loadReleaseManifest(fixture.manifestPath);
    expect((await verifyReleaseIntegrity(manifest, limits)).ok).toBe(true);

    const target = fixture.releaseFile;
    chmodSync(target, 0o644);
    writeFileSync(target, 'print("fixture releasf")\n');
    chmodSync(target, 0o444);

    const drifted = await verifyReleaseIntegrity(manifest, limits);
    expect(drifted.ok).toBe(false);
    expect(drifted.drift).toEqual([{ path: 'source/metaclaw.py', reason: 'digest_mismatch' }]);
    expect(await codeOf(() => assertReleaseIntact(drifted))).toBe('integrity_drift');
  });

  it('detects size drift before hashing', async () => {
    const fixture = createFixture();
    const manifest = loadReleaseManifest(fixture.manifestPath);
    const target = fixture.releaseFile;
    chmodSync(target, 0o644);
    writeFileSync(target, 'shorter\n');
    chmodSync(target, 0o444);
    expect((await verifyReleaseIntegrity(manifest, limits)).drift).toEqual([
      { path: 'source/metaclaw.py', reason: 'size_mismatch' },
    ]);
  });

  it('detects a removed file, a replaced symlink, and a replaced directory', async () => {
    const fixture = createFixture();
    const manifest = loadReleaseManifest(fixture.manifestPath);
    const target = fixture.releaseFile;

    chmodSync(path.dirname(target), 0o755);
    rmSync(target);
    chmodSync(path.dirname(target), 0o555);
    expect((await verifyReleaseIntegrity(manifest, limits)).drift).toEqual([
      { path: 'source/metaclaw.py', reason: 'missing' },
    ]);

    const decoy = path.join(fixture.root, 'decoy.py');
    writeFileSync(decoy, 'print("fixture release")\n', { mode: 0o444 });
    chmodSync(path.dirname(target), 0o755);
    symlinkSync(decoy, target);
    chmodSync(path.dirname(target), 0o555);
    expect((await verifyReleaseIntegrity(manifest, limits)).drift).toEqual([
      { path: 'source/metaclaw.py', reason: 'symlink' },
    ]);

    chmodSync(path.dirname(target), 0o755);
    rmSync(target);
    mkdirSync(target, { mode: 0o700 });
    chmodSync(path.dirname(target), 0o555);
    expect((await verifyReleaseIntegrity(manifest, limits)).drift).toEqual([
      { path: 'source/metaclaw.py', reason: 'not_regular_file' },
    ]);
  });

  it('refuses a manifest entry that would read outside the release root', async () => {
    const fixture = createFixture({
      manifestOverrides: (manifest) => ({
        ...manifest,
        files: [{ ...manifest.files[0], path: '../escape.py' }],
      }),
    });
    expect(await codeOf(() => loadReleaseManifest(fixture.manifestPath))).toBe('profile_invalid');
  });

  it('reports every file as missing when the release root itself is gone', async () => {
    const fixture = createFixture();
    const manifest = loadReleaseManifest(fixture.manifestPath);
    chmodSync(fixture.releaseRoot, 0o755);
    chmodSync(path.join(fixture.releaseRoot, 'source'), 0o755);
    chmodSync(path.join(fixture.releaseRoot, 'venv'), 0o755);
    chmodSync(path.join(fixture.releaseRoot, 'venv', 'bin'), 0o755);
    chmodSync(path.join(fixture.releaseRoot, 'wheels'), 0o755);
    rmSync(fixture.releaseRoot, { recursive: true, force: true });
    const integrity = await verifyReleaseIntegrity(manifest, limits);
    expect(integrity.ok).toBe(false);
    expect(integrity.drift).toHaveLength(manifest.files.length);
    expect(integrity.drift).toContainEqual({ path: 'source/metaclaw.py', reason: 'missing' });
  });

  it('passes an intact release through unchanged', async () => {
    const fixture = createFixture();
    const intact = await verifyReleaseIntegrity(loadReleaseManifest(fixture.manifestPath), limits);
    expect(() => assertReleaseIntact(intact)).not.toThrow();
  });

  it('detects an unlisted file and fails closed on an incomplete scan', async () => {
    const fixture = createFixture();
    const manifest = loadReleaseManifest(fixture.manifestPath);
    chmodSync(fixture.releaseRoot, 0o755);
    writeFileSync(path.join(fixture.releaseRoot, 'unlisted.py'), 'extra\n', { mode: 0o444 });
    chmodSync(fixture.releaseRoot, 0o555);
    expect((await verifyReleaseIntegrity(manifest, limits)).drift).toContainEqual({
      path: 'unlisted.py',
      reason: 'unlisted',
    });

    const bounded = await verifyReleaseIntegrity(manifest, { ...limits, maxEntries: 1 });
    expect(bounded).toMatchObject({ ok: false, complete: false, truncation: { reason: 'entry_limit' } });

    const byteBounded = await verifyReleaseIntegrity(manifest, { ...limits, maxBytes: 1 });
    expect(byteBounded).toMatchObject({ ok: false, complete: false, truncation: { reason: 'byte_limit' } });

    let clock = 0;
    const timed = await verifyReleaseIntegrity(manifest, { ...limits, deadlineMs: 1, now: () => (clock += 10) });
    expect(timed).toMatchObject({ ok: false, complete: false, truncation: { reason: 'deadline' } });
  });

  it('detects an unlisted empty directory as release drift', async () => {
    const fixture = createFixture();
    chmodSync(fixture.releaseRoot, 0o755);
    mkdirSync(path.join(fixture.releaseRoot, 'plugin-discovery'), { mode: 0o700 });
    chmodSync(fixture.releaseRoot, 0o555);
    expect((await verifyReleaseIntegrity(loadReleaseManifest(fixture.manifestPath), limits)).drift).toContainEqual({
      path: 'plugin-discovery',
      reason: 'unlisted',
    });
  });

  it('rejects a symlinked release root even when it resolves to byte-identical contents', async () => {
    const fixture = createFixture();
    const manifest = loadReleaseManifest(fixture.manifestPath);
    const retained = `${fixture.releaseRoot}-retained`;
    renameSync(fixture.releaseRoot, retained);
    symlinkSync(retained, fixture.releaseRoot);
    expect((await verifyReleaseIntegrity(manifest, limits)).drift).toEqual([{ path: '.', reason: 'symlink' }]);
  });
});
