import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OfficialResearchClawAdapter } from '../src/adapter.js';
import { cleanup, fixture, input, waitFor } from './helpers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe('official HITL delegation', () => {
  it('exposes status, output, guidance, and approval through the official adapter bridge', async () => {
    const kit = fixture();
    roots.push(kit.root);
    const adapter = new OfficialResearchClawAdapter({
      python: kit.python,
      bridgePath: kit.bridge,
      supervisorPath: kit.supervisor,
      pollIntervalMs: 20,
    });
    const handle = await adapter.start(input(kit.projectRoot, 'hitl-e2e', 'WAIT_FOR_HITL'));
    const paused = await waitFor(() => adapter.recover(handle), (value) => value.state === 'paused');
    expect(paused.state).toBe('paused');
    expect(await adapter.hitl.getStatus(handle)).toMatchObject({ success: true, needs_input: true });
    expect(await adapter.hitl.viewOutput(handle, 1)).toMatchObject({
      success: true,
      files: [expect.objectContaining({ name: 'stage-output.md' })],
    });
    expect(await adapter.hitl.injectGuidance(handle, 1, 'Add a stronger baseline.')).toMatchObject({
      success: true,
      stage: 1,
    });
    expect(() => adapter.hitl.viewOutput(handle, 1, path.join('..', 'secret'))).toThrow('single safe');
    expect(await adapter.hitl.approveStage(handle, 'Looks good.')).toMatchObject({ success: true, action: 'approve' });
    expect(await adapter.resume(handle)).toEqual({ state: 'running' });
    expect(await adapter.collect(handle)).toEqual({ state: 'finished' });
  });

  it('restarts a rejected official gate from the official rollback target', async () => {
    const kit = fixture();
    roots.push(kit.root);
    const adapter = new OfficialResearchClawAdapter({
      python: kit.python,
      bridgePath: kit.bridge,
      supervisorPath: kit.supervisor,
      pollIntervalMs: 20,
    });
    const handle = await adapter.start(input(kit.projectRoot, 'hitl-reject-e2e', 'WAIT_FOR_HITL'));
    expect((await waitFor(() => adapter.recover(handle), (value) => value.state === 'paused')).state).toBe('paused');
    expect(await adapter.hitl.rejectStage(handle, 'Revise the evidence boundary.')).toMatchObject({
      success: true,
      action: 'reject',
    });
    await adapter.resume(handle);
    expect((await waitFor(() => adapter.recover(handle), (value) => value.state === 'paused')).state).toBe('paused');
    expect(await adapter.hitl.approveStage(handle, 'Rollback output accepted.')).toMatchObject({
      success: true,
      action: 'approve',
    });
    await adapter.resume(handle);
    expect(await adapter.collect(handle)).toEqual({ state: 'finished' });
  });
});
