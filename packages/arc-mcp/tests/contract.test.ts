import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { validateArcOutput } from '../src/contract.js';
import { ArcError } from '../src/errors.js';
import { projectDirectory, removeDirectory, temporaryDirectory, validOutput } from './helpers.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDirectory(directory);
});

describe('ARC output contract', () => {
  it('validates the canonical nested output and preserves partial and failed evidence', () => {
    for (const status of ['completed', 'partial', 'failed'] as const) {
      const output = validateArcOutput(validOutput('project-1', `run-${status}`, { status }), {
        expectedProjectId: 'project-1',
        expectedRunId: `run-${status}`,
      });
      expect(output.status).toBe(status);
      expect(output.hypotheses[0]?.statement).toContain('proposed change');
      expect(output.negative_results[0]?.summary).toContain('did not change');
    }
  });

  it('rejects wrong versions, identifiers, malformed nested values, and unknown fields', () => {
    const base = validOutput('project-1', 'run-1');
    expect(() =>
      validateArcOutput(
        { ...base, contract_version: 'autoresearchclaw.output.v1' },
        {
          expectedProjectId: 'project-1',
          expectedRunId: 'run-1',
        },
      ),
    ).toThrow(ArcError);
    expect(() => validateArcOutput(base, { expectedProjectId: 'project-2', expectedRunId: 'run-1' })).toThrow(
      /project_id/,
    );
    expect(() => validateArcOutput(base, { expectedProjectId: 'project-1', expectedRunId: 'run-2' })).toThrow(/run_id/);
    expect(() =>
      validateArcOutput(
        { ...base, findings: [{ id: 'broken', summary: '', evidence: [] }] },
        {
          expectedProjectId: 'project-1',
          expectedRunId: 'run-1',
        },
      ),
    ).toThrow(/Invalid ARC output/);
    expect(() =>
      validateArcOutput(
        { ...base, unversioned_extension: true },
        {
          expectedProjectId: 'project-1',
          expectedRunId: 'run-1',
        },
      ),
    ).toThrow(/Invalid ARC output/);
  });

  it('accepts HTTP evidence but rejects traversal and a symlink escape', () => {
    const temporary = temporaryDirectory();
    cleanup.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const outside = path.join(temporary, 'outside.txt');
    writeFileSync(outside, 'outside', 'utf8');
    const inside = path.join(projectRoot, 'evidence.txt');
    writeFileSync(inside, 'inside', 'utf8');
    const store = new ArcArtifactStore();

    expect(() =>
      store.writeOutput(
        { projectId: 'project-1', projectRoot, runId: 'run-traversal' },
        validOutput('project-1', 'run-traversal', {
          artifacts: [{ id: 'escape', uri: '../outside.txt', summary: 'Must be rejected.' }],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'path_outside_project' }));

    const links = path.join(projectRoot, 'links');
    mkdirSync(links);
    symlinkSync(outside, path.join(links, 'outside.txt'));
    expect(() =>
      store.writeOutput(
        { projectId: 'project-1', projectRoot, runId: 'run-symlink' },
        validOutput('project-1', 'run-symlink', {
          artifacts: [{ id: 'symlink', uri: 'links/outside.txt', summary: 'Must also be rejected.' }],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'symlink_not_allowed' }));

    expect(() =>
      store.writeOutput(
        { projectId: 'project-1', projectRoot, runId: 'run-http' },
        validOutput('project-1', 'run-http', {
          artifacts: [{ id: 'local-evidence', uri: 'evidence.txt', summary: 'A project-local artifact.' }],
        }),
      ),
    ).not.toThrow();
  });
});
