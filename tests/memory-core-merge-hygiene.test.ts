import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  collectSourceInventory,
  diffInventories,
  formatMemoryCoreMergeHygieneReport,
  isMemoryCoreMergeHygienePath,
  runMemoryCoreMergeHygiene,
  selectMemoryCoreMergeHygienePaths,
  type MergeHygieneGitReader,
} from '../src/release-gates/memory-core-merge-hygiene.js';

describe('Memory Core merge hygiene path selector', () => {
  it('targets Memory Core, AutoResearchClaw, WorkerManager, and known integration TypeScript paths', () => {
    expect(
      selectMemoryCoreMergeHygienePaths([
        'src/memory-core/research-loop-runner.ts',
        './tests/memory-core-autoresearchclaw-contract.test.ts',
        'packages/cli/tests/research-memory.test.ts',
        'src/workers/worker-manager.ts',
        'src/api/routes/task-routes.ts',
        'src/mcp/research-memory-mcp-tools.ts',
        'tests/task-scheduler-one-time.test.ts',
        'src/bridge/message-bridge.ts',
      ]),
    ).toEqual([
      'packages/cli/tests/research-memory.test.ts',
      'src/api/routes/task-routes.ts',
      'src/mcp/research-memory-mcp-tools.ts',
      'src/memory-core/research-loop-runner.ts',
      'src/workers/worker-manager.ts',
      'tests/memory-core-autoresearchclaw-contract.test.ts',
    ]);
    expect(isMemoryCoreMergeHygienePath('tests/task-scheduler-one-time.test.ts')).toBe(false);
  });
});

describe('Memory Core merge hygiene inventories', () => {
  it('does not diagnose this gate test file as its own fixture text', () => {
    const inventory = collectSourceInventory(
      readFileSync(new URL('./memory-core-merge-hygiene.test.ts', import.meta.url), 'utf8'),
    );

    expect(inventory.diagnostics).toEqual([]);
  });

  it('collects test names and top-level declarations with the TS parser', () => {
    const inventory = collectSourceInventory(`
      export function keepPublicApi() {}
      const internalValue = 1;
      export { keepPublicApi as keepPublicApiAlias };
      import { readFile } from 'node:fs/promises';

      describe('suite', () => {
        it('keeps existing test name', () => {});
        test.skip('keeps skipped test name', () => {});
      });
    `);

    expect(inventory.declarationSymbols).toEqual([
      'const:internalValue',
      'export:keepPublicApiAlias',
      'function:keepPublicApi',
    ]);
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.exportedDeclarationSymbols).toEqual(['export:keepPublicApiAlias', 'function:keepPublicApi']);
    expect(inventory.importSpecifiers).toEqual(['node:fs/promises']);
    expect(inventory.testNames).toEqual(['keeps existing test name', 'keeps skipped test name']);
  });

  it('reports missing tests and declarations between parent and merge inventories', () => {
    expect(
      diffInventories(
        {
          declarationSymbols: ['function:keepPublicApi', 'type:StableType'],
          diagnostics: [],
          exportedDeclarationSymbols: ['function:keepPublicApi', 'type:StableType'],
          importSpecifiers: ['../memory-core/index.js'],
          testNames: ['preserves research memory flow'],
        },
        {
          declarationSymbols: ['function:keepPublicApi'],
          diagnostics: ['src/api/routes/task-routes.ts:unresolved-conflict-marker'],
          exportedDeclarationSymbols: [],
          importSpecifiers: [],
          testNames: [],
        },
      ),
    ).toEqual({
      diagnostics: ['src/api/routes/task-routes.ts:unresolved-conflict-marker'],
      missingDeclarationSymbols: ['type:StableType'],
      missingExportedDeclarationSymbols: ['function:keepPublicApi', 'type:StableType'],
      missingImportSpecifiers: ['../memory-core/index.js'],
      missingTestNames: ['preserves research memory flow'],
    });
  });

  it('detects source-level conflict markers and forbidden legacy candidate aliases', () => {
    const inventory = collectSourceInventory(`
      export const output = {
        hypothesis_candidates: [],
      };
      <<<<<<< HEAD
      export const local = true;
      =======
      export const incoming = true;
      >>>>>>> parent
    `);

    expect(inventory.diagnostics).toEqual([
      'forbidden-lexeme:legacy-autoresearchclaw-candidate-alias',
      'unresolved-conflict-marker',
    ]);
  });

  it('detects forbidden aliases in semantic property names', () => {
    const inventory = collectSourceInventory(`
      export const output = {
        "finding_candidates": [],
        ['decision_candidates']: [],
      };
      output['hypothesis_candidates'] = [];
      output[\`finding_candidates\`] = [];
    `);

    expect(inventory.diagnostics).toEqual(['forbidden-lexeme:legacy-autoresearchclaw-candidate-alias']);
  });

  it('ignores conflict-marker and forbidden-alias fixture text in comments and literals', () => {
    const leftMarker = '<'.repeat(7);
    const middleMarker = '='.repeat(7);
    const rightMarker = '>'.repeat(7);
    const source = [
      `// ${leftMarker} HEAD`,
      `/* ${middleMarker} */`,
      `const markerFixture = \`${leftMarker} HEAD`,
      `${middleMarker}`,
      `${rightMarker} parent\`;`,
      `const aliasFixture = 'hypothesis_candidates finding_candidates decision_candidates';`,
      `const bypassVariant = { hypothesis_candidate_count: 1, decision_candidate_total: 2 };`,
    ].join('\n');

    expect(collectSourceInventory(source).diagnostics).toEqual([]);
  });
});

describe('Memory Core merge hygiene gate', () => {
  it('skips production semantic-loss scan for GitHub pull_request synthetic merge refs', () => {
    const git: MergeHygieneGitReader = {
      listChangedFiles() {
        throw new Error('synthetic pull_request merge refs must not run the production scan');
      },
      readFileAtRef() {
        throw new Error('synthetic pull_request merge refs must not read parent inventories');
      },
      resolveParentRefs() {
        throw new Error('synthetic pull_request merge refs must not resolve merge parents');
      },
    };

    const report = runMemoryCoreMergeHygiene({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/123/merge',
      },
      git,
      mergeRef: 'HEAD',
      mergeRefExplicit: false,
    });

    expect(report).toEqual({
      checked: false,
      mergeRef: 'HEAD',
      ok: true,
      parentResults: [],
      skippedReason:
        'GitHub pull_request checked out refs/pull/*/merge, a synthetic CI merge ref; production parent-vs-merge semantic-loss scan runs on pushed merge commits or explicit --merge refs.',
    });
  });

  it('fails when a merge result drops targeted parent declarations or tests', () => {
    const files = new Map<string, string | undefined>([
      [
        'parent-a:src/memory-core/research-loop-runner.ts',
        `import '../api/routes/research-memory-routes.js';\nexport function keepPublicApi() {}\nexport type StableType = { ok: true };\n`,
      ],
      [
        'parent-a:tests/memory-core-autoresearchclaw-contract.test.ts',
        `it('preserves research memory flow', () => {});\n`,
      ],
      [
        'merge:src/memory-core/research-loop-runner.ts',
        `function keepPublicApi() {}\nexport const output = { decision_candidates: [] };\n`,
      ],
      ['merge:tests/memory-core-autoresearchclaw-contract.test.ts', `describe('noop', () => {});\n`],
      [
        'parent-b:src/memory-core/research-loop-runner.ts',
        `import '../api/routes/research-memory-routes.js';\nexport function keepPublicApi() {}\nexport type StableType = { ok: true };\n`,
      ],
      [
        'parent-b:tests/memory-core-autoresearchclaw-contract.test.ts',
        `it('preserves research memory flow', () => {});\n`,
      ],
    ]);

    const git: MergeHygieneGitReader = {
      listChangedFiles() {
        return [
          'src/memory-core/research-loop-runner.ts',
          'tests/memory-core-autoresearchclaw-contract.test.ts',
          'tests/task-scheduler-one-time.test.ts',
        ];
      },
      readFileAtRef(ref, filePath) {
        return files.get(`${ref}:${filePath}`);
      },
      resolveParentRefs() {
        return ['parent-a', 'parent-b'];
      },
    };

    const report = runMemoryCoreMergeHygiene({ git, mergeRef: 'merge' });

    expect(report.checked).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.parentResults[0]).toMatchObject({
      changedPaths: ['src/memory-core/research-loop-runner.ts', 'tests/memory-core-autoresearchclaw-contract.test.ts'],
      missingDeclarationSymbols: ['type:StableType'],
      missingExportedDeclarationSymbols: ['function:keepPublicApi', 'type:StableType'],
      missingImportSpecifiers: ['../api/routes/research-memory-routes.js'],
      missingTestNames: ['preserves research memory flow'],
      parentRef: 'parent-a',
    });
    expect(report.parentResults[0]?.diagnostics).toEqual([
      'src/memory-core/research-loop-runner.ts:forbidden-lexeme:legacy-autoresearchclaw-candidate-alias',
    ]);
    expect(formatMemoryCoreMergeHygieneReport(report)).toContain('missing tests: preserves research memory flow');
    expect(formatMemoryCoreMergeHygieneReport(report)).toContain(
      'missing exported declarations: function:keepPublicApi, type:StableType',
    );
  });

  it('checks actual pushed merge commits and fails accidental targeted test deletion', () => {
    const files = new Map<string, string | undefined>([
      [
        'parent-a:tests/memory-core-autoresearchclaw-contract.test.ts',
        `it('keeps pushed merge coverage', () => {});\n`,
      ],
      ['parent-b:tests/memory-core-autoresearchclaw-contract.test.ts', undefined],
      ['merge:tests/memory-core-autoresearchclaw-contract.test.ts', undefined],
    ]);

    const git: MergeHygieneGitReader = {
      listChangedFiles() {
        return ['tests/memory-core-autoresearchclaw-contract.test.ts'];
      },
      readFileAtRef(ref, filePath) {
        return files.get(`${ref}:${filePath}`);
      },
      resolveParentRefs() {
        return ['parent-a', 'parent-b'];
      },
    };

    const report = runMemoryCoreMergeHygiene({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
      },
      git,
      mergeRef: 'HEAD',
      mergeRefExplicit: false,
    });

    expect(report.checked).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.parentResults[0]).toMatchObject({
      changedPaths: ['tests/memory-core-autoresearchclaw-contract.test.ts'],
      missingTestNames: ['keeps pushed merge coverage'],
      parentRef: 'parent-a',
    });
  });

  it('preserves explicit merge-ref scans even inside pull_request CI', () => {
    const files = new Map<string, string | undefined>([
      [
        'parent-a:tests/memory-core-autoresearchclaw-contract.test.ts',
        `it('keeps explicit merge coverage', () => {});\n`,
      ],
      ['merge:tests/memory-core-autoresearchclaw-contract.test.ts', undefined],
      [
        'parent-b:tests/memory-core-autoresearchclaw-contract.test.ts',
        `it('keeps explicit merge coverage', () => {});\n`,
      ],
    ]);

    const git: MergeHygieneGitReader = {
      listChangedFiles() {
        return ['tests/memory-core-autoresearchclaw-contract.test.ts'];
      },
      readFileAtRef(ref, filePath) {
        return files.get(`${ref}:${filePath}`);
      },
      resolveParentRefs() {
        return ['parent-a', 'parent-b'];
      },
    };

    const report = runMemoryCoreMergeHygiene({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/123/merge',
      },
      git,
      mergeRef: 'merge',
      mergeRefExplicit: true,
    });

    expect(report.checked).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.parentResults[0]?.missingTestNames).toEqual(['keeps explicit merge coverage']);
  });

  it('fails when a known integration route keeps declarations but drops visibility and imports', () => {
    const files = new Map<string, string | undefined>([
      [
        'parent-a:src/api/routes/task-routes.ts',
        `import { ingest } from '../../memory-core/index.js';\nexport function buildAutoResearchStatus() { return ingest; }\n`,
      ],
      ['merge:src/api/routes/task-routes.ts', `function buildAutoResearchStatus() { return true; }\n`],
      [
        'parent-b:src/api/routes/task-routes.ts',
        `import { ingest } from '../../memory-core/index.js';\nexport function buildAutoResearchStatus() { return ingest; }\n`,
      ],
    ]);

    const git: MergeHygieneGitReader = {
      listChangedFiles() {
        return ['src/api/routes/task-routes.ts'];
      },
      readFileAtRef(ref, filePath) {
        return files.get(`${ref}:${filePath}`);
      },
      resolveParentRefs() {
        return ['parent-a', 'parent-b'];
      },
    };

    const report = runMemoryCoreMergeHygiene({ git, mergeRef: 'merge' });

    expect(report.checked).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.parentResults[0]).toMatchObject({
      changedPaths: ['src/api/routes/task-routes.ts'],
      missingDeclarationSymbols: [],
      missingExportedDeclarationSymbols: ['function:buildAutoResearchStatus'],
      missingImportSpecifiers: ['../../memory-core/index.js'],
      parentRef: 'parent-a',
    });
  });

  it('passes a synthetic merge that changes gate source and tests without semantic loss', () => {
    const gateSource = `
      export function collectSourceInventory() {}
      export const MEMORY_CORE_FORBIDDEN_LEXICAL_PATTERNS = [];
    `;
    const gateTest = `
      import { collectSourceInventory } from '../src/release-gates/memory-core-merge-hygiene.js';
      it('keeps gate coverage', () => collectSourceInventory());
    `;
    const files = new Map<string, string | undefined>([
      ['parent-a:src/release-gates/memory-core-merge-hygiene.ts', gateSource],
      ['parent-a:tests/memory-core-merge-hygiene.test.ts', gateTest],
      ['parent-b:src/release-gates/memory-core-merge-hygiene.ts', gateSource],
      ['parent-b:tests/memory-core-merge-hygiene.test.ts', gateTest],
      ['merge:src/release-gates/memory-core-merge-hygiene.ts', gateSource],
      ['merge:tests/memory-core-merge-hygiene.test.ts', gateTest],
    ]);

    const git: MergeHygieneGitReader = {
      listChangedFiles() {
        return ['src/release-gates/memory-core-merge-hygiene.ts', 'tests/memory-core-merge-hygiene.test.ts'];
      },
      readFileAtRef(ref, filePath) {
        return files.get(`${ref}:${filePath}`);
      },
      resolveParentRefs() {
        return ['parent-a', 'parent-b'];
      },
    };

    const report = runMemoryCoreMergeHygiene({ git, mergeRef: 'merge' });

    expect(report).toMatchObject({
      checked: true,
      mergeRef: 'merge',
      ok: true,
    });
    expect(report.parentResults).toHaveLength(2);
    expect(report.parentResults[0]?.changedPaths).toEqual([
      'src/release-gates/memory-core-merge-hygiene.ts',
      'tests/memory-core-merge-hygiene.test.ts',
    ]);
  });

  it('skips cleanly when the current ref is not a merge commit', () => {
    const git: MergeHygieneGitReader = {
      listChangedFiles() {
        return [];
      },
      readFileAtRef() {
        return undefined;
      },
      resolveParentRefs() {
        return ['only-parent'];
      },
    };

    expect(runMemoryCoreMergeHygiene({ git, mergeRef: 'HEAD' })).toEqual({
      checked: false,
      mergeRef: 'HEAD',
      ok: true,
      parentResults: [],
      skippedReason: 'HEAD is not a merge commit; Memory Core merge hygiene runs only on merge commits.',
    });
  });
});
