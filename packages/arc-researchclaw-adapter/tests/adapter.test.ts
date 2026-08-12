import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OfficialResearchClawAdapter } from '../src/adapter.js';
import { cleanup, fixture, input, waitFor } from './helpers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe('official AutoResearchClaw adapter', () => {
  it('runs the pinned pipeline supervisor and writes a validated official artifact envelope', async () => {
    const kit = fixture();
    roots.push(kit.root);
    const adapter = new OfficialResearchClawAdapter({
      python: kit.python,
      bridgePath: kit.bridge,
      supervisorPath: kit.supervisor,
      pollIntervalMs: 20,
    });
    const handle = await adapter.start(input(kit.projectRoot, 'official-e2e', 'Run all official stages'));
    const result = await adapter.collect(handle);
    expect(result).toEqual({ state: 'finished' });
    const output = JSON.parse(
      readFileSync(path.join(kit.projectRoot, '.metabot-arc/runs/official-e2e/output.json'), 'utf8'),
    );
    expect(output).toMatchObject({
      contract_version: 'autoresearchclaw.output.v2',
      project_id: 'project-1',
      run_id: 'official-e2e',
      status: 'completed',
      metrics: { official_stage_count: 23, stages_done: 23 },
    });
    expect(output.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: expect.stringContaining('deliverables/paper_final.md') })]),
    );
    expect(await adapter.start(input(kit.projectRoot, 'official-e2e', 'Run all official stages'))).toEqual(handle);
  });

  it('supports durable process pause, resume, and cancellation', async () => {
    const kit = fixture();
    roots.push(kit.root);
    const adapter = new OfficialResearchClawAdapter({
      python: kit.python,
      bridgePath: kit.bridge,
      supervisorPath: kit.supervisor,
      pollIntervalMs: 20,
      stopTimeoutMs: 500,
    });
    const handle = await adapter.start(input(kit.projectRoot, 'control-e2e', 'LONG_RUNNING'));
    const running = await waitFor(() => adapter.recover(handle), (value) => value.state === 'running');
    expect(running.state).toBe('running');
    expect(await adapter.pause(handle)).toEqual({ state: 'paused' });
    expect(await adapter.recover(handle)).toEqual({ state: 'paused' });
    expect(await adapter.resume(handle)).toEqual({ state: 'running' });
    expect(await adapter.cancel(handle)).toEqual({ state: 'cancelled' });
    expect(await adapter.recover(handle)).toEqual({ state: 'cancelled' });
  });
});
