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
  it('targets Memory Core and AutoResearchClaw TypeScript paths only', () => {
    expect(
      selectMemoryCoreMergeHygienePaths([
        'src/memory-core/research-loop-runner.ts',
        './tests/memory-core-autoresearchclaw-contract.test.ts',
        'packages/cli/tests/research-memory.test.ts',
        'src/workers/worker-manager.ts',
        'tests/task-scheduler-one-time.test.ts',
        'src/bridge/message-bridge.ts',
      ]),
    ).toEqual([
      'packages/cli/tests/research-memory.test.ts',
      'src/memory-core/research-loop-runner.ts',
      'src/workers/worker-manager.ts',
      'tests/memory-core-autoresearchclaw-contract.test.ts',
    ]);
    expect(isMemoryCoreMergeHygienePath('tests/task-scheduler-one-time.test.ts')).toBe(false);
  });
});

describe('Memory Core merge hygiene inventories', () => {
  it('collects test names and top-level declarations with the TS parser', () => {
    const inventory = collectSourceInventory(`
      export function keepPublicApi() {}
      const internalValue = 1;
      export { keepPublicApi as keepPublicApiAlias };

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
    expect(inventory.testNames).toEqual(['keeps existing test name', 'keeps skipped test name']);
  });

  it('reports missing tests and declarations between parent and merge inventories', () => {
    expect(
      diffInventories(
        {
          declarationSymbols: ['function:keepPublicApi', 'type:StableType'],
          testNames: ['preserves research memory flow'],
        },
        {
          declarationSymbols: ['function:keepPublicApi'],
          testNames: [],
        },
      ),
    ).toEqual({
      missingDeclarationSymbols: ['type:StableType'],
      missingTestNames: ['preserves research memory flow'],
    });
  });
});

describe('Memory Core merge hygiene gate', () => {
  it('fails when a merge result drops targeted parent declarations or tests', () => {
    const files = new Map<string, string | undefined>([
      [
        'parent-a:src/memory-core/research-loop-runner.ts',
        `export function keepPublicApi() {}\nexport type StableType = { ok: true };\n`,
      ],
      [
        'parent-a:tests/memory-core-autoresearchclaw-contract.test.ts',
        `it('preserves research memory flow', () => {});\n`,
      ],
      [
        'merge:src/memory-core/research-loop-runner.ts',
        `export function keepPublicApi() {}\n`,
      ],
      ['merge:tests/memory-core-autoresearchclaw-contract.test.ts', `describe('noop', () => {});\n`],
      [
        'parent-b:src/memory-core/research-loop-runner.ts',
        `export function keepPublicApi() {}\nexport type StableType = { ok: true };\n`,
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
      changedPaths: [
        'src/memory-core/research-loop-runner.ts',
        'tests/memory-core-autoresearchclaw-contract.test.ts',
      ],
      missingDeclarationSymbols: ['type:StableType'],
      missingTestNames: ['preserves research memory flow'],
      parentRef: 'parent-a',
    });
    expect(formatMemoryCoreMergeHygieneReport(report)).toContain('missing tests: preserves research memory flow');
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
