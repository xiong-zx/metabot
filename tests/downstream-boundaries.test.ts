import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkDownstreamBoundaries } from '../scripts/check-downstream-boundaries.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(manifest: object): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-downstream-boundaries-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/downstream-features.json'), JSON.stringify(manifest));
  return root;
}

describe('downstream feature boundary gate', () => {
  it('accepts planned modules but requires accepted roots', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        { id: 'present', status: 'required', roots: ['packages/present'] },
        { id: 'future', status: 'planned', roots: ['packages/future'] },
      ],
    });
    fs.mkdirSync(path.join(root, 'packages/present'), { recursive: true });
    expect(checkDownstreamBoundaries(root)).toMatchObject({ ok: true });
    expect(checkDownstreamBoundaries(root, undefined, { release: true }).failures).toContain(
      'future: planned feature is not allowed in release mode',
    );
    fs.rmSync(path.join(root, 'packages/present'), { recursive: true });
    expect(checkDownstreamBoundaries(root).failures).toContain('present: missing required roots: packages/present');
  });

  it('rejects forbidden paths and static, dynamic, and re-export imports', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: ['src/legacy'],
      features: [
        { id: 'isolated', status: 'required', roots: ['packages/isolated'], forbiddenImports: ['legacy-core'] },
      ],
    });
    fs.mkdirSync(path.join(root, 'src/legacy'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/isolated'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages/isolated/index.ts'),
      "import x from 'legacy-core'; export { y } from 'legacy-core/sub'; void import('legacy-core/dynamic'); require('legacy-core/cjs');\n",
    );
    const result = checkDownstreamBoundaries(root);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'forbidden path exists: src/legacy',
        "isolated: packages/isolated/index.ts imports forbidden 'legacy-core'",
        "isolated: packages/isolated/index.ts imports forbidden 'legacy-core/sub'",
        "isolated: packages/isolated/index.ts imports forbidden 'legacy-core/dynamic'",
        "isolated: packages/isolated/index.ts imports forbidden 'legacy-core/cjs'",
      ]),
    );
  });

  it('fails closed on path escape or symlinked source roots', () => {
    const escaped = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [{ id: 'escape', status: 'required', roots: ['../outside'] }],
    });
    expect(() => checkDownstreamBoundaries(escaped)).toThrow('escapes repository');

    const linked = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [{ id: 'linked', status: 'required', roots: ['packages/linked'] }],
    });
    fs.mkdirSync(path.join(linked, 'packages'), { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(linked, 'packages/linked'));
    expect(() => checkDownstreamBoundaries(linked)).toThrow('cannot be a symlink');
  });

  it('passes against the repository manifest', () => {
    expect(checkDownstreamBoundaries(path.resolve(import.meta.dirname, '..'))).toMatchObject({ ok: true });
  });
});
