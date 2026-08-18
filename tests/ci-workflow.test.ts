import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const ciWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
const restartCli = fs.readFileSync(path.join(repositoryRoot, 'bin/metabot'), 'utf8');

describe('CI runtime prerequisites', () => {
  it('builds every compiled package required by the restart preflight before tests', () => {
    const buildStep = ciWorkflow.slice(
      ciWorkflow.indexOf('Build workspace libraries and restart prerequisites'),
      ciWorkflow.indexOf('- name: Run tests'),
    );

    expect(restartCli).toContain('packages/arc-researchclaw-adapter/dist/factory.js');
    expect(buildStep).toContain('-w @xvirobotics/arc-mcp');
    expect(buildStep).toContain('-w @xvirobotics/worker-runner-mcp');
    expect(buildStep).toContain('-w @xvirobotics/arc-researchclaw-adapter');
  });
});
