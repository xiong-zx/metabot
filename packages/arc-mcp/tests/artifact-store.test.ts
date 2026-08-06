import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { projectDirectory, removeDirectory, temporaryDirectory, validOutput } from './helpers.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDirectory(directory);
});

describe('ArcArtifactStore', () => {
  it('writes separate run artifacts atomically and reads validated output', () => {
    const temporary = temporaryDirectory();
    cleanup.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const store = new ArcArtifactStore();

    for (const runId of ['run-a', 'run-b']) {
      const relative = store.writeOutput(
        { projectId: 'project-1', projectRoot, runId },
        validOutput('project-1', runId),
      );
      expect(relative).toBe(`.metabot-arc/runs/${runId}/output.json`);
      expect(store.readOutput({ projectId: 'project-1', projectRoot, runId }).run_id).toBe(runId);
    }

    const runDirectory = path.join(projectRoot, '.metabot-arc', 'runs', 'run-a');
    expect(existsSync(path.join(runDirectory, 'output.json'))).toBe(true);
    expect(readFileSync(path.join(runDirectory, 'output.json'), 'utf8')).toContain('autoresearchclaw.output.v2');
    expect(existsSync(path.join(projectRoot, '.metabot-arc', 'runs', 'run-b', 'output.json'))).toBe(true);
  });

  it('waits only for a bounded delayed artifact arrival', async () => {
    const temporary = temporaryDirectory();
    cleanup.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const store = new ArcArtifactStore();
    setTimeout(() => {
      store.writeOutput(
        { projectId: 'project-1', projectRoot, runId: 'run-delayed' },
        validOutput('project-1', 'run-delayed'),
      );
    }, 30);
    await expect(
      store.waitForOutput({
        projectId: 'project-1',
        projectRoot,
        runId: 'run-delayed',
        timeoutMs: 500,
        pollIntervalMs: 5,
      }),
    ).resolves.toMatchObject({ run_id: 'run-delayed', status: 'completed' });
    await expect(
      store.waitForOutput({
        projectId: 'project-1',
        projectRoot,
        runId: 'run-missing',
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'artifact_missing' });
  });
});
