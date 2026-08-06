import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { arcStartRequestSchema } from '../src/coordinator.js';
import { ARC_MAX_OBJECTIVE_BYTES, ARC_MAX_PARAMETERS_BYTES, validateArcOutput } from '../src/contract.js';
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

  it('rejects duplicate entity IDs, unknown references, and oversized start data', () => {
    const base = validOutput('project-1', 'run-semantic');
    expect(() =>
      validateArcOutput(
        { ...base, hypotheses: [base.hypotheses[0]!, base.hypotheses[0]!] },
        { expectedProjectId: 'project-1', expectedRunId: 'run-semantic' },
      ),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining('duplicate hypotheses id') }),
          ]),
        }),
      }),
    );
    expect(() =>
      validateArcOutput(
        {
          ...base,
          experiments: [{ ...base.experiments[0]!, hypothesis_ids: ['missing-hypothesis'] }],
        },
        { expectedProjectId: 'project-1', expectedRunId: 'run-semantic' },
      ),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining('unknown hypothesis reference') }),
          ]),
        }),
      }),
    );
    expect(
      arcStartRequestSchema.safeParse({
        project_id: 'project-1',
        project_root: '/tmp/project',
        objective: 'x'.repeat(ARC_MAX_OBJECTIVE_BYTES + 1),
        idempotency_key: 'oversized-objective',
      }).success,
    ).toBe(false);
    expect(
      arcStartRequestSchema.safeParse({
        project_id: 'project-1',
        project_root: '/tmp/project',
        objective: 'Bounded objective.',
        idempotency_key: 'oversized-parameters',
        parameters: { payload: 'x'.repeat(ARC_MAX_PARAMETERS_BYTES + 1) },
      }).success,
    ).toBe(false);
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

    for (const uri of [outside, pathToFileURL(outside).href]) {
      expect(() =>
        store.writeOutput(
          { projectId: 'project-1', projectRoot, runId: `run-absolute-${uri.startsWith('file:')}` },
          validOutput('project-1', `run-absolute-${uri.startsWith('file:')}`, {
            artifacts: [{ id: 'absolute-escape', uri, summary: 'Must be rejected.' }],
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'path_outside_project' }));
    }

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
