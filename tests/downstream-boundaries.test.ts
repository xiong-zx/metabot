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

  it('rejects required features without non-empty roots', () => {
    const missing = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [{ id: 'empty', status: 'required', roots: [] }],
    });
    expect(checkDownstreamBoundaries(missing).failures).toContain(
      'empty: required feature must declare non-empty roots',
    );

    const blank = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [{ id: 'blank', status: 'required', roots: [''] }],
    });
    expect(checkDownstreamBoundaries(blank).failures).toContain('blank: roots must contain non-empty relative paths');
  });

  it('rejects forbidden paths and static, dynamic, import-equals, and re-export imports', () => {
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
      "import x from 'legacy-core'; export { y } from 'legacy-core/sub'; void import('legacy-core/dynamic'); require('legacy-core/cjs'); import legacy = require('legacy-core/equal');\n",
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
        "isolated: packages/isolated/index.ts imports forbidden 'legacy-core/equal'",
      ]),
    );
  });

  it('matches package boundaries and resolved repository paths precisely', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        {
          id: 'precise',
          status: 'required',
          roots: ['packages/isolated'],
          forbiddenImports: ['legacy-core', 'src/bridge'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'packages/isolated'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages/isolated/index.ts'),
      [
        "import 'legacy-core/subpath';",
        "import './legacy-core';",
        "import 'legacy-core-extra';",
        "import '../../src/bridge/client.js';",
        "import '../../src/bridge-client';",
        "import 'src/bridge';",
      ].join('\n'),
    );

    expect(checkDownstreamBoundaries(root).failures).toEqual([
      "precise: packages/isolated/index.ts imports forbidden 'legacy-core/subpath'",
      "precise: packages/isolated/index.ts imports forbidden '../../src/bridge/client.js'",
    ]);
  });

  it('recursively scans source files anywhere under an owned directory root', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        {
          id: 'adapter',
          status: 'required',
          roots: ['packages/adapter'],
          importRoots: ['packages/adapter/src'],
          forbiddenImports: ['@example/runtime'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'packages/adapter/src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/adapter/extra'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/adapter/src/index.ts'), 'export const adapter = true;\n');
    fs.writeFileSync(path.join(root, 'packages/adapter/extra/worker.ts'), "import '@example/runtime';\n");
    expect(checkDownstreamBoundaries(root).failures).toEqual([
      "adapter: packages/adapter/extra/worker.ts imports forbidden '@example/runtime'",
    ]);
  });

  it('recursively scans nested tests under an owned directory root', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        {
          id: 'adapter',
          status: 'required',
          roots: ['packages/adapter'],
          importRoots: ['packages/adapter/src'],
          forbiddenImports: ['@example/runtime'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'packages/adapter/src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/adapter/tests/nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/adapter/src/index.ts'), 'export {}\n');
    fs.writeFileSync(
      path.join(root, 'packages/adapter/tests/nested/integration.test.ts'),
      "import '@example/runtime';\n",
    );
    expect(checkDownstreamBoundaries(root).failures).toEqual([
      "adapter: packages/adapter/tests/nested/integration.test.ts imports forbidden '@example/runtime'",
    ]);
  });

  it('supports an explicit separate test-root import policy', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        {
          id: 'adapter-production',
          status: 'required',
          roots: ['packages/adapter/src'],
          forbiddenImports: ['@example/runtime'],
        },
        {
          id: 'adapter-tests',
          status: 'required',
          roots: ['packages/adapter/tests'],
          forbiddenImports: ['@example/internal'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'packages/adapter/src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/adapter/tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/adapter/src/index.ts'), 'export {}\n');
    fs.writeFileSync(path.join(root, 'packages/adapter/tests/integration.test.ts'), "import '@example/runtime';\n");
    expect(checkDownstreamBoundaries(root)).toMatchObject({ ok: true });
  });

  it('ignores unrelated roots and generated dependency or output directories', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        {
          id: 'adapter',
          status: 'required',
          roots: ['packages/adapter'],
          forbiddenImports: ['@example/runtime'],
        },
      ],
    });
    for (const directory of ['node_modules', 'dist', 'build', 'coverage']) {
      fs.mkdirSync(path.join(root, 'packages/adapter', directory), { recursive: true });
      fs.writeFileSync(path.join(root, 'packages/adapter', directory, 'generated.js'), "import '@example/runtime';\n");
    }
    fs.mkdirSync(path.join(root, 'packages/unrelated'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/unrelated/index.ts'), "import '@example/runtime';\n");
    expect(checkDownstreamBoundaries(root)).toMatchObject({ ok: true });
  });

  it('rejects import roots outside the declared feature roots', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        {
          id: 'adapter',
          status: 'required',
          roots: ['packages/adapter'],
          importRoots: ['packages/other'],
          forbiddenImports: ['@example/runtime'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'packages/adapter'), { recursive: true });
    expect(checkDownstreamBoundaries(root).failures).toContain('adapter: importRoots must stay within declared roots');
  });

  it('enforces reverse boundaries from upstream roots to downstream packages', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [],
      reverseBoundaries: [
        {
          id: 'upstream-isolation',
          roots: ['src'],
          forbiddenImports: ['@example/downstream'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/index.ts'), "import '@example/downstream/runtime';\n");

    expect(checkDownstreamBoundaries(root)).toMatchObject({
      ok: false,
      failures: ["upstream-isolation: src/index.ts imports forbidden '@example/downstream/runtime'"],
      checkedReverseBoundaries: [{ id: 'upstream-isolation', presentRoots: 1 }],
    });
  });

  it('allows only enumerated thin-hook importers through a reverse boundary', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [],
      reverseBoundaries: [
        {
          id: 'thin-hooks',
          roots: ['src'],
          forbiddenImports: ['@example/downstream'],
          allowedImporters: ['src/hook.ts'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/hook.ts'), "import '@example/downstream';\n");
    fs.writeFileSync(path.join(root, 'src/leak.ts'), "import '@example/downstream';\n");
    expect(checkDownstreamBoundaries(root).failures).toEqual([
      "thin-hooks: src/leak.ts imports forbidden '@example/downstream'",
    ]);
  });

  it('mechanically validates feature thinHooks and allowedImporters', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: [],
      features: [
        {
          id: 'adapter',
          status: 'required',
          roots: ['packages/adapter'],
          thinHooks: ['src/hook.ts', 'src/missing.ts'],
          allowedImporters: ['src/importer.ts'],
        },
      ],
    });
    fs.mkdirSync(path.join(root, 'packages/adapter'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/hook.ts'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'src/importer.ts'), 'export {};\n');
    expect(checkDownstreamBoundaries(root).failures).toEqual([
      'adapter: missing thinHooks: src/missing.ts',
      'adapter: allowedImporters must also be declared thinHooks: src/importer.ts',
    ]);
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

  it('detects dangling symlinks at forbidden paths', () => {
    const root = fixture({
      schemaVersion: 1,
      forbiddenPaths: ['src/legacy'],
      features: [],
    });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'src/legacy'));

    expect(checkDownstreamBoundaries(root).failures).toContain('forbidden path exists: src/legacy');
  });

  it('declares signed schedule capabilities inside the Agent Team governance boundary', () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'config/downstream-features.json'), 'utf8'),
    ) as {
      features: Array<{
        id: string;
        roots?: string[];
        forbiddenImports?: string[];
        reason?: string;
        validationSurface?: string[];
      }>;
    };
    const governance = manifest.features.find((feature) => feature.id === 'agent-team-governance');

    expect(governance).toMatchObject({
      roots: expect.arrayContaining([
        'src/agent-teams/governance-capability.ts',
        'src/agent-teams/schedule-capability.ts',
      ]),
      forbiddenImports: expect.arrayContaining(['src/memory-core', 'src/workers']),
      reason: expect.any(String),
      validationSurface: expect.arrayContaining([
        'tests/agent-team-http-auth.test.ts',
        'tests/agent-team-cli-capability.test.ts',
      ]),
    });
  });

  it('documents validation surfaces for every detached runtime package', () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'config/downstream-features.json'), 'utf8'),
    ) as {
      features: Array<{ id: string; reason?: string; validationSurface?: string[] }>;
    };

    for (const id of ['arc-mcp', 'worker-runner-mcp', 'arc-worker-runner-adapter', 'arc-researchclaw-adapter']) {
      const feature = manifest.features.find((candidate) => candidate.id === id);
      expect(feature).toMatchObject({
        reason: expect.any(String),
        validationSurface: expect.arrayContaining([expect.stringMatching(/\.test\.ts$/)]),
      });
    }
  });

  it('passes against the repository manifest', () => {
    expect(checkDownstreamBoundaries(path.resolve(import.meta.dirname, '..'))).toMatchObject({ ok: true });
  });

  it('declares separately scanned RulesPack engine, adapter, Worker, and extension boundaries', () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'config/downstream-features.json'), 'utf8'),
    ) as { features: Array<{ id: string; roots?: string[]; thinHooks?: string[]; validationSurface?: string[] }> };
    const adapter = manifest.features.find((candidate) => candidate.id === 'rulespack-metabot-adapter');
    expect(adapter).toMatchObject({
      roots: ['packages/rulespack-adapter'],
      thinHooks: expect.arrayContaining([
        'src/bridge/message-bridge.ts',
        'src/engines/codex/executor.ts',
        'packages/worker-runner-mcp/src/store.ts',
      ]),
      validationSurface: expect.arrayContaining([
        'packages/rulespack-adapter/tests/runtime.test.ts',
        'tests/rulespack-codex-integration.test.ts',
      ]),
    });
    for (const [id, root] of [
      ['rulespack-engine', 'packages/rulespack'],
      ['rulespack-worker-adapter', 'packages/worker-runner-mcp/src/rulespack.ts'],
      ['rulespack-operator-routes', 'src/extensions/rulespack-routes.ts'],
      ['rulespack-api-principal', 'src/extensions/rulespack-api-principal.ts'],
      ['rulespack-peer-dispatch', 'src/extensions/rulespack-peer-dispatch.ts'],
    ]) {
      expect(manifest.features.find((candidate) => candidate.id === id)).toMatchObject({
        roots: expect.arrayContaining([root]),
        forbiddenImports: expect.any(Array),
      });
    }
  });
});
