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
    expect(build.indexOf('-w @metabot/rulespack-adapter')).toBeGreaterThan(
      build.indexOf('-w @metabot/rulespack'),
    );
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

  it('builds every compiled package required by the restart preflight before tests', () => {
    const rulesPackBuildStep = ciWorkflow.slice(
      ciWorkflow.indexOf('Build RulesPack entrypoints'),
      ciWorkflow.indexOf('- name: Type check'),
    );
    const buildStep = ciWorkflow.slice(
      ciWorkflow.indexOf('Build workspace libraries and restart prerequisites'),
      ciWorkflow.indexOf('- name: Run tests'),
    );

    expect(restartCli).toContain('packages/arc-researchclaw-adapter/dist/factory.js');
    expect(rulesPackBuildStep).toContain('-w @metabot/rulespack');
    expect(rulesPackBuildStep).toContain('-w @metabot/rulespack-adapter');
    expect(buildStep).toContain('-w @xvirobotics/arc-mcp');
    expect(buildStep).toContain('-w @xvirobotics/worker-runner-mcp');
    expect(buildStep).toContain('-w @xvirobotics/arc-researchclaw-adapter');
    expect(buildStep).toContain('-w @xvirobotics/arc-worker-runner-adapter');
  });
});
