import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const syncWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/upstream-sync.yml'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');

describe('upstream sync workflow trust boundary', () => {
  it('uses the migration gate for sync and the strict gate for releases', () => {
    expect(syncWorkflow).toContain('npm run check:downstream-boundaries\n');
    expect(syncWorkflow).not.toContain('check:downstream-boundaries:release');
    expect(releaseWorkflow).toContain('npm run check:downstream-boundaries:release');
  });

  it('validates untrusted merged code without write credentials', () => {
    const validateJob = syncWorkflow.slice(syncWorkflow.indexOf('  validate:'), syncWorkflow.indexOf('  publish:'));
    expect(validateJob).toContain('contents: read');
    expect(validateJob).toContain('persist-credentials: false');
    expect(validateJob).not.toContain('contents: write');
    expect(validateJob).not.toContain('git push');
  });

  it('keeps the privileged publish job minimal and never force-pushes', () => {
    const publishJob = syncWorkflow.slice(syncWorkflow.indexOf('  publish:'));
    expect(publishJob).toContain('contents: write');
    expect(publishJob).toContain('persist-credentials: false');
    expect(publishJob).not.toContain('setup-node');
    expect(publishJob).not.toContain('npm ');
    expect(publishJob).not.toContain('--force');
    expect(publishJob).toContain("--jq 'length'");
    expect(publishJob).toContain('Branch $SYNC_BRANCH already exists; leaving it untouched.');
  });

  it('runs only from main and keeps all publication behind a pull request', () => {
    expect(syncWorkflow.match(/github\.ref == 'refs\/heads\/main'/g)).toHaveLength(2);
    expect(syncWorkflow).toContain('gh pr create --base main --head "$SYNC_BRANCH"');
    expect(syncWorkflow).not.toMatch(/git push[^\n]*\bmain\b/);
  });
});
