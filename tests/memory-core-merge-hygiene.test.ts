import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mergeHygieneScript = join(repoRoot, 'scripts/check-memory-core-merge-hygiene.ts');
const requireFromTest = createRequire(import.meta.url);
const tsxCli = requireFromTest.resolve('tsx/cli');

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
  it('does not allow spoofed GitHub pull_request env to suppress a genuine merge scan', () => {
    const report = runMemoryCoreMergeHygiene({
      git: makeDeletedTargetGitReader('keeps genuine merge coverage'),
      mergeRef: 'HEAD',
    });

    expect(report.checked).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.parentResults[0]).toMatchObject({
      changedPaths: ['tests/memory-core-autoresearchclaw-contract.test.ts'],
      missingTestNames: ['keeps genuine merge coverage'],
      parentRef: 'parent-a',
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
      git,
      mergeRef: 'HEAD',
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
      git,
      mergeRef: 'merge',
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

  it('keeps the GitHub pull_request synthetic-merge exception in the workflow step condition', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const step = workflow.match(
      /- name: Memory Core merge hygiene[\s\S]*?run: npm run check:merge-hygiene:memory-core/,
    );

    expect(step?.[0]).toContain("if: github.event_name != 'pull_request'");
    expect(workflow).not.toContain('GITHUB_REF');
    expect(workflow).not.toContain(
      'refs/pull/*/merge, a synthetic CI merge ref; production parent-vs-merge semantic-loss scan runs',
    );
  });
});

describe('Memory Core merge hygiene real git CLI probes', () => {
  it('scans a genuine delete merge under spoofed pull_request env and keeps --json stdout clean', () => {
    const repo = createDeleteMergeRepo();
    try {
      const result = runMergeHygieneCli(repo, ['--json'], {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/123/merge',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      const report = JSON.parse(result.stdout) as ReturnType<typeof runMemoryCoreMergeHygiene>;
      expect(report.checked).toBe(true);
      expect(report.ok).toBe(false);
      expect(
        report.parentResults.some((parent) => parent.missingTestNames.includes('keeps real delete coverage')),
      ).toBe(true);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it('scans a genuine add merge and keeps missing-parent git-show stderr out of --json output', () => {
    const repo = createAddMergeRepo();
    try {
      const result = runMergeHygieneCli(repo, ['--json']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const report = JSON.parse(result.stdout) as ReturnType<typeof runMemoryCoreMergeHygiene>;
      expect(report.checked).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.parentResults.some((parent) => parent.changedPaths.includes('src/memory-core/added.ts'))).toBe(
        true,
      );
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });
});

function makeDeletedTargetGitReader(testName: string): MergeHygieneGitReader {
  const files = new Map<string, string | undefined>([
    ['parent-a:tests/memory-core-autoresearchclaw-contract.test.ts', `it('${testName}', () => {});\n`],
    ['parent-b:tests/memory-core-autoresearchclaw-contract.test.ts', undefined],
    ['HEAD:tests/memory-core-autoresearchclaw-contract.test.ts', undefined],
  ]);

  return {
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
}

function createDeleteMergeRepo(): string {
  const repo = createGitRepo();
  writeRepoFile(repo, 'README.md', 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['checkout', '-b', 'parent-a']);
  writeRepoFile(
    repo,
    'tests/memory-core-autoresearchclaw-contract.test.ts',
    "it('keeps real delete coverage', () => {});\n",
  );
  git(repo, ['add', 'tests/memory-core-autoresearchclaw-contract.test.ts']);
  git(repo, ['commit', '-m', 'add memory coverage']);
  git(repo, ['checkout', 'main']);
  git(repo, ['checkout', '-b', 'parent-b']);
  writeRepoFile(repo, 'README.md', 'base\nparent-b\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'update unrelated file']);
  git(repo, ['checkout', 'parent-a']);
  git(repo, ['merge', '--no-ff', '--no-commit', 'parent-b']);
  rmSync(join(repo, 'tests/memory-core-autoresearchclaw-contract.test.ts'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'merge and delete memory coverage']);
  return repo;
}

function createAddMergeRepo(): string {
  const repo = createGitRepo();
  writeRepoFile(repo, 'README.md', 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['checkout', '-b', 'parent-a']);
  writeRepoFile(repo, 'README.md', 'base\nparent-a\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'update unrelated file']);
  git(repo, ['checkout', 'main']);
  git(repo, ['checkout', '-b', 'parent-b']);
  writeRepoFile(repo, 'src/memory-core/added.ts', 'export function keepAddedMemoryApi() { return true; }\n');
  git(repo, ['add', 'src/memory-core/added.ts']);
  git(repo, ['commit', '-m', 'add memory api']);
  git(repo, ['checkout', 'parent-a']);
  git(repo, ['merge', '--no-ff', 'parent-b', '-m', 'merge added memory api']);
  return repo;
}

function createGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'metabot-merge-hygiene-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'merge-hygiene@example.test']);
  git(repo, ['config', 'user.name', 'Merge Hygiene Test']);
  return repo;
}

function writeRepoFile(repo: string, filePath: string, contents: string): void {
  const absolutePath = join(repo, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runMergeHygieneCli(repo: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCli, mergeHygieneScript, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}
