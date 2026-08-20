import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const ciWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
const restartCli = fs.readFileSync(path.join(repositoryRoot, 'bin/metabot'), 'utf8');
const rootPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('CI runtime prerequisites', () => {
  it('makes the canonical root build self-sufficient from a clean checkout', () => {
    const build = rootPackage.scripts.build;
    expect(build.indexOf('-w @metabot/rulespack')).toBeGreaterThan(-1);
    expect(build.indexOf('-w @metabot/rulespack-adapter')).toBeGreaterThan(build.indexOf('-w @metabot/rulespack'));
    expect(build.indexOf('tsc -b --force')).toBeGreaterThan(build.indexOf('-w @metabot/rulespack-adapter'));
  });

  it('uses setup-node headers before npm ci builds native dependencies', () => {
    const headersStep = ciWorkflow.indexOf('Use setup-node headers for native builds');
    const installStep = ciWorkflow.indexOf('- name: Install dependencies');

    expect(headersStep).toBeGreaterThan(-1);
    expect(headersStep).toBeLessThan(installStep);
    expect(ciWorkflow).toContain('npm_config_nodedir=');
    expect(ciWorkflow).toContain('process.execPath');
  });

  it('fetches the exact pre-push object before scanning rewritten history', () => {
    const pushScan = ciWorkflow.slice(
      ciWorkflow.indexOf('- name: Scan pushed additions for secrets'),
      ciWorkflow.indexOf('- name: Build RulesPack entrypoints'),
    );

    expect(pushScan).toContain('git fetch --no-tags origin "$BASE_SHA"');
    expect(pushScan).not.toContain('--depth=1');
    expect(pushScan.indexOf('git fetch')).toBeLessThan(pushScan.indexOf('npm run check:added-secrets'));
  });

  it('builds every compiled package required by the restart preflight before tests', () => {
    const rulesPackBuildStep = ciWorkflow.slice(
      ciWorkflow.indexOf('Build RulesPack entrypoints'),
      ciWorkflow.indexOf('- name: Type check'),
    );
    const buildStep = ciWorkflow.slice(
      ciWorkflow.indexOf('Build workspace libraries and restart prerequisites'),
      ciWorkflow.indexOf('- name: Run tests'),
    );

    expect(rulesPackBuildStep).toContain('-w @metabot/rulespack');
    expect(rulesPackBuildStep).toContain('-w @metabot/rulespack-adapter');
    expect(restartCli).toContain('packages/arc-mcp/dist/daemon-cli.js');
    expect(buildStep).toContain('-w @xvirobotics/arc-mcp');
    expect(buildStep).toContain('-w @xvirobotics/worker-runner-mcp');
    expect(buildStep).not.toContain('arc-researchclaw-adapter');
    expect(buildStep).not.toContain('arc-worker-runner-adapter');
  });
});
