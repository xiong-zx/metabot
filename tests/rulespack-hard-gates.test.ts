import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSecretFindings,
  readGitDiff,
  SECRET_SCAN_MAX_DIFF_BYTES,
} from '../scripts/check-added-secrets.mjs';
import { checkFeatureHistory } from '../scripts/check-feature-history.mjs';

describe('FIX-012 mechanical policy gates', () => {
  it('rejects high-confidence credentials only on added lines', () => {
    expect(findSecretFindings([
      '+++ b/src/config.ts',
      '+const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";', // secret-scan: allow(test fixture)
      '-Authorization: Bearer oldoldoldoldoldoldoldoldold', // secret-scan: allow(test fixture)
    ].join('\n'))).toEqual([{ file: 'src/config.ts', kind: 'github-token' }]);
    expect(findSecretFindings('+++ b/tests/x.ts\n+const token = "test-token";')).toEqual([]);
    expect(findSecretFindings('+++ b/src/x.ts\n+const clientSecret = process.env.FEISHU_APP_SECRET;')).toEqual([]);
    expect(findSecretFindings('+++ b/src/x.ts\n+feishuAppSecret: "abcdefghijklmnopqrstuvwxyz123456"')).toEqual([ // secret-scan: allow(test fixture)
      { file: 'src/x.ts', kind: 'assigned-secret-literal' },
    ]);
    expect(findSecretFindings('+++ b/src/x.ts\n+const key = "ASIAABCDEFGHIJKLMNOP";')).toEqual([ // secret-scan: allow(test fixture)
      { file: 'src/x.ts', kind: 'aws-temporary-access-key' },
    ]);
    for (const field of ['FEISHU_APP_SECRET', 'SLACK_SIGNING_SECRET', 'TELEGRAM_BOT_TOKEN']) {
      expect(findSecretFindings(`+++ b/.env\n+${field}=abcdefghijklmnopqrstuvwxyz123456`)).toEqual([ // secret-scan: allow(test fixture)
        { file: '.env', kind: 'environment-secret-literal' },
      ]);
      expect(findSecretFindings(`+++ b/src/config.ts\n+const ${field} = process.env.${field};`)).toEqual([]);
    }
  });

  it('reads a large promotion diff without the execFileSync default-buffer failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'metabot-secret-scan-buffer-'));
    try {
      const fakeGit = join(directory, 'git');
      writeFileSync(fakeGit, [
        '#!/bin/sh',
        "printf '+++ b/large.txt\\n'",
        "yes '+ordinary non-secret line' | head -n 60000",
      ].join('\n'), { mode: 0o755 });
      chmodSync(fakeGit, 0o755);
      const diff = readGitDiff('base', 'head', fakeGit);
      expect(Buffer.byteLength(diff)).toBeGreaterThan(1024 * 1024);
      expect(Buffer.byteLength(diff)).toBeLessThan(SECRET_SCAN_MAX_DIFF_BYTES);
      expect(findSecretFindings(diff)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires one final implementation commit on feature branches', () => {
    expect(checkFeatureHistory({
      branch: 'fix/fix-012-rulespack-operationalization',
      commits: [
        { subject: 'feat(rulespack): operationalize defaults', files: ['src/config.ts', 'tests/rulespack.test.ts'] },
      ],
      changedFiles: ['src/config.ts', 'tests/rulespack.test.ts'],
    })).toEqual([]);
    expect(checkFeatureHistory({
      branch: 'fix/fix-012-rulespack-operationalization',
      commits: [
        { subject: 'feat(rulespack): operationalize defaults', files: ['src/config.ts'] },
        { subject: 'test(rulespack): cover defaults', files: ['tests/rulespack-more.test.ts'] },
      ],
      changedFiles: ['src/config.ts', 'tests/rulespack-more.test.ts'],
    })).toEqual(['feature branches require exactly one final commit; found 2']);
    expect(checkFeatureHistory({
      branch: 'fix/fix-012-rulespack-operationalization',
      commits: [
        { subject: 'feat(rulespack): first', files: ['src/config.ts'] },
        { subject: 'chore(rulespack): hidden follow-up', files: ['src/bridge.ts'] },
      ],
      changedFiles: ['src/config.ts'],
    })).toEqual(['feature branches require exactly one final commit; found 2']);
    expect(checkFeatureHistory({
      branch: 'feature/rulespack',
      commits: [{ subject: 'chore: change runtime', files: ['packages/runtime.ts'] }],
      changedFiles: ['packages/runtime.ts'],
    })).toEqual(['the production-code commit must use feat, fix, refactor, or perf conventional syntax']);
    expect(checkFeatureHistory({
      branch: 'dev', commits: ['merge: integrate feature'], changedFiles: ['src/config.ts'],
    })).toEqual([]);
    for (const branch of ['develop', 'main-evil']) {
      expect(checkFeatureHistory({
        branch,
        commits: [
          { subject: 'feat(core): first', files: ['src/a.ts'] },
          { subject: 'chore: hidden second', files: ['src/b.ts'] },
        ],
        changedFiles: ['src/a.ts', 'src/b.ts'],
      })).toEqual(['feature branches require exactly one final commit; found 2']);
    }
  });
});
