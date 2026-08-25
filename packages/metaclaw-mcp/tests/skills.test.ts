import { mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MetaClawError } from '../src/errors.js';
import { getSkill, isSafeSkillName, listSkills } from '../src/skills.js';
import { cleanupFixtures, createFixture, writeSkill } from './helpers.js';

afterEach(cleanupFixtures);

function options(root: string) {
  return { root, maxEntries: 100, maxFileBytes: 1_024, maxTotalBytes: 8 * 1_024, deadlineMs: 5_000 } as const;
}

async function failureOf(run: () => unknown): Promise<{ code: string; reason: unknown }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MetaClawError) return { code: error.code, reason: error.details?.reason };
    return { code: `unexpected:${String(error)}`, reason: undefined };
  }
  return { code: 'no-error', reason: undefined };
}

describe('skill name containment', () => {
  it('accepts plain contained identifiers', () => {
    for (const name of ['research', 'code-review', 'skill_1', 'a']) {
      expect(isSafeSkillName(name), name).toBe(true);
    }
  });

  it('rejects traversal, separators, absolute names, dots, and overlong names', () => {
    for (const name of [
      '..',
      '../escape',
      'a/b',
      'a\\b',
      '/absolute',
      '.hidden',
      'Upper',
      'with space',
      'dot.name',
      'x'.repeat(65),
      '',
    ]) {
      expect(isSafeSkillName(name), name).toBe(false);
    }
  });
});

describe('read-only skills access', () => {
  it('returns digest and provenance for a well-formed skill', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'research', '# Research\n');

    const [entry] = (await listSkills(options(fixture.skillsRoot))).entries;
    expect(entry).toMatchObject({ name: 'research', state: 'active', reason: null });
    expect(entry.provenance).toMatchObject({
      name: 'research',
      writer: 'arc',
      bytes: Buffer.byteLength('# Research\n'),
      relativePath: path.join('research', 'SKILL.md'),
    });
    expect(entry.provenance!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const document = await getSkill(options(fixture.skillsRoot), 'research');
    expect(document.content).toBe('# Research\n');
    expect(document.provenance.sha256).toBe(entry.provenance!.sha256);
  });

  it('quarantines a symlinked skill directory and fails closed on fetch', async () => {
    const fixture = createFixture();
    const outside = path.join(fixture.root, 'outside-skill');
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(outside, 'SKILL.md'), '# Outside\n', { mode: 0o600 });
    symlinkSync(outside, path.join(fixture.skillsRoot, 'linked'));

    expect((await listSkills(options(fixture.skillsRoot))).entries).toEqual([
      { name: 'linked', state: 'quarantined', reason: 'symlink', provenance: null },
    ]);
    expect(await failureOf(() => getSkill(options(fixture.skillsRoot), 'linked'))).toEqual({
      code: 'skill_unsafe',
      reason: 'symlink',
    });
  });

  it('quarantines a symlinked SKILL.md even inside a real directory', async () => {
    const fixture = createFixture();
    const target = path.join(fixture.root, 'target.md');
    writeFileSync(target, '# Elsewhere\n', { mode: 0o600 });
    const directory = path.join(fixture.skillsRoot, 'sneaky');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    symlinkSync(target, path.join(directory, 'SKILL.md'));

    expect((await listSkills(options(fixture.skillsRoot))).entries[0]).toMatchObject({
      state: 'quarantined',
      reason: 'skill_file_symlink',
    });
    expect((await failureOf(() => getSkill(options(fixture.skillsRoot), 'sneaky'))).reason).toBe('skill_file_symlink');
  });

  it('quarantines a non-directory entry and a directory without SKILL.md', async () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.skillsRoot, 'loose'), 'not a skill', { mode: 0o600 });
    mkdirSync(path.join(fixture.skillsRoot, 'empty'), { recursive: true, mode: 0o700 });

    const entries = (await listSkills(options(fixture.skillsRoot))).entries;
    expect(entries.find((entry) => entry.name === 'loose')).toMatchObject({ reason: 'not_a_directory' });
    expect(entries.find((entry) => entry.name === 'empty')).toMatchObject({ reason: 'missing_skill_file' });
    expect((await failureOf(() => getSkill(options(fixture.skillsRoot), 'empty'))).code).toBe('skill_not_found');
  });

  it('quarantines an oversized skill rather than reading it', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'huge', 'x'.repeat(2_048));
    expect((await listSkills(options(fixture.skillsRoot))).entries[0]).toMatchObject({ reason: 'oversize' });
    expect(await failureOf(() => getSkill(options(fixture.skillsRoot), 'huge'))).toEqual({
      code: 'skill_unsafe',
      reason: 'oversize',
    });
  });

  it('refuses a skill while a temporary sibling shows a write in flight', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'inflight', '# Complete\n');
    const temporary = path.join(fixture.skillsRoot, 'inflight', 'SKILL.md.tmp');
    writeFileSync(temporary, '# Half', { mode: 0o600 });

    expect((await listSkills(options(fixture.skillsRoot))).entries[0]).toMatchObject({ reason: 'half_written' });
    expect(await failureOf(() => getSkill(options(fixture.skillsRoot), 'inflight'))).toEqual({
      code: 'skill_unsafe',
      reason: 'half_written',
    });

    // Once the writer finishes and removes the temporary file, the same skill
    // reads normally: the refusal is about the in-flight write, not the skill.
    rmSync(temporary);
    expect((await getSkill(options(fixture.skillsRoot), 'inflight')).content).toBe('# Complete\n');
  });

  it('quarantines an unsafe name found on disk without reading it', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'Weird.Name', '# Weird\n');
    const entry = (await listSkills(options(fixture.skillsRoot))).entries[0];
    expect(entry).toMatchObject({
      state: 'quarantined',
      reason: 'unsafe_name',
    });
    expect(entry.name).toMatch(/^unsafe-[0-9a-f]{16}$/);
    expect(entry.name).not.toContain('Weird.Name');
  });

  it('never reflects terminal-control bytes from an unsafe disk name', async () => {
    const fixture = createFixture();
    const unsafe = 'bad\u001b[31m-name';
    writeSkill(fixture.skillsRoot, unsafe, '# Bad\n');
    const listing = await listSkills(options(fixture.skillsRoot));
    expect(JSON.stringify(listing)).not.toContain(unsafe);
    expect(listing.entries[0]).toMatchObject({
      name: expect.stringMatching(/^unsafe-[0-9a-f]{16}$/),
      state: 'quarantined',
      reason: 'unsafe_name',
    });
  });

  it('rejects a traversing fetch before touching the filesystem', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'research', '# Research\n');
    for (const name of ['../research', '/etc/passwd', 'a/b', '..']) {
      expect(await failureOf(() => getSkill(options(fixture.skillsRoot), name)), name).toEqual({
        code: 'skill_unsafe',
        reason: 'unsafe_name',
      });
    }
  });

  it('reports a missing skill distinctly from an unsafe one', async () => {
    const fixture = createFixture();
    expect((await failureOf(() => getSkill(options(fixture.skillsRoot), 'absent'))).code).toBe('skill_not_found');
  });

  it('keeps good skills visible when a neighbour is quarantined', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'good', '# Good\n');
    writeSkill(fixture.skillsRoot, 'huge', 'x'.repeat(2_048));

    const entries = (await listSkills(options(fixture.skillsRoot))).entries;
    expect(entries.map((entry) => `${entry.name}:${entry.state}`)).toEqual([
      'good:active',
      'huge:quarantined',
    ]);
  });

  it('bounds how many entries a single listing walks', async () => {
    const fixture = createFixture();
    for (const index of [1, 2, 3, 4, 5]) writeSkill(fixture.skillsRoot, `skill-${index}`, `# ${index}\n`);
    const listing = await listSkills({
      root: fixture.skillsRoot, maxEntries: 2, maxFileBytes: 1_024, maxTotalBytes: 8_192, deadlineMs: 5_000,
    });
    expect(listing.entries).toHaveLength(2);
    expect(listing).toMatchObject({
      complete: false,
      truncated: true,
      truncation: { reason: 'entry_limit', limit: 2 },
      totalEntries: null,
      returnedEntryCount: 2,
      observedRootEntryCount: 3,
    });
  });

  it('reports an exact total only after a complete root scan', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'one', '1');
    writeSkill(fixture.skillsRoot, 'two', '2');
    expect(await listSkills(options(fixture.skillsRoot))).toMatchObject({
      complete: true,
      truncated: false,
      truncation: null,
      totalEntries: 2,
      returnedEntryCount: 2,
      observedRootEntryCount: 2,
    });
  });

  it('refuses a relative or missing skills root', async () => {
    expect((await failureOf(() => listSkills(options('relative/skills')))).code).toBe('skill_unsafe');
    expect((await failureOf(() => listSkills(options('/nonexistent/skills/root')))).code).toBe('skill_unsafe');
  });

  it('never writes: a listing and a fetch leave the tree byte-identical', async () => {
    const fixture = createFixture();
    const file = writeSkill(fixture.skillsRoot, 'research', '# Research\n');
    const before = statSync(file);
    await listSkills(options(fixture.skillsRoot));
    await getSkill(options(fixture.skillsRoot), 'research');
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readdirSync(path.join(fixture.skillsRoot, 'research'))).toEqual(['SKILL.md']);
  });

  it('observes only complete versions across an ARC-style atomic replacement', async () => {
    const fixture = createFixture();
    const file = writeSkill(fixture.skillsRoot, 'research', '# Version one\n');
    const before = await getSkill(options(fixture.skillsRoot), 'research');
    const temporary = path.join(fixture.skillsRoot, 'research', '.tmp-SKILL.md');
    writeFileSync(temporary, '# Version two\n', { mode: 0o600 });
    renameSync(temporary, file);
    const after = await getSkill(options(fixture.skillsRoot), 'research');

    expect(before.content).toBe('# Version one\n');
    expect(after.content).toBe('# Version two\n');
    expect(before.provenance.sha256).not.toBe(after.provenance.sha256);
    expect(readdirSync(path.dirname(file))).toEqual(['SKILL.md']);
  });

  it('truthfully truncates on a total-byte ceiling', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'one', '12345');
    writeSkill(fixture.skillsRoot, 'two', '67890');
    const listing = await listSkills({ ...options(fixture.skillsRoot), maxTotalBytes: 8 });
    expect(listing).toMatchObject({ complete: false, truncation: { reason: 'byte_limit', limit: 8 } });
    expect(listing.bytesRead).toBeLessThanOrEqual(8);
  });

  it('truthfully truncates when its wall-clock budget expires', async () => {
    const fixture = createFixture();
    writeSkill(fixture.skillsRoot, 'one', 'content');
    let clock = 0;
    const listing = await listSkills({
      ...options(fixture.skillsRoot), deadlineMs: 1, now: () => (clock += 10),
    });
    expect(listing).toMatchObject({ complete: false, truncation: { reason: 'deadline', limit: 1 } });
  });
});
