import type { ArcExecutionInput } from '@xvirobotics/arc-mcp';
import { describe, expect, it } from 'vitest';

import { ArcWorkerRunnerAdapter, mapWorkerState } from '../src/adapter.js';
import { arcWorkerDedupeKey, renderArcWorkerPrompt } from '../src/prompt.js';
import { WorkerMcpWireClient, type WorkerToolCaller, type WorkerToolResult } from '../src/wire.js';

describe('ArcWorkerRunnerAdapter', () => {
  it('dispatches the versioned input with permanent dedupe and manual recovery', async () => {
    const caller = new FakeCaller();
    const adapter = new ArcWorkerRunnerAdapter({
      client: new WorkerMcpWireClient(caller),
      engine: 'codex',
      model: 'gpt-test',
      timeoutMs: 1_000,
      idleTimeoutMs: 500,
      pollIntervalMs: 10,
    });
    const input = executionInput();
    const handle = await adapter.start(input);

    expect(handle).toEqual({ id: 'wrk-1', metadata: { dedupe_key: 'arc:v1:project-1:run-1' } });
    expect(caller.calls[0]).toMatchObject({
      name: 'worker_dispatch',
      arguments: {
        workdir: '/tmp/project',
        engine: 'codex',
        model: 'gpt-test',
        dedupe_key: 'arc:v1:project-1:run-1',
        dedupe_ttl_ms: 0,
        retry_terminal: false,
        recovery_policy: { restart: 'manual', idempotent: false },
      },
    });
  });

  it('renders only contract data and no process secrets or lifecycle delegation', () => {
    process.env.METABOT_ARC_CALLBACK_KEY_FILE = '/secret/callback.key';
    process.env.API_SECRET = 'never-render-this';
    const prompt = renderArcWorkerPrompt(executionInput());
    expect(prompt).toContain('autoresearchclaw.input.v1');
    expect(prompt).toContain('ARC_INPUT_JSON_BEGIN');
    expect(prompt).toContain('Do not dispatch workers');
    expect(prompt).not.toContain('/secret/callback.key');
    expect(prompt).not.toContain('never-render-this');
    expect(arcWorkerDedupeKey('project:a', 'run/b')).toBe('arc:v1:project%3Aa:run%2Fb');
    expect(arcWorkerDedupeKey('界'.repeat(200), '界'.repeat(200)).length).toBeLessThanOrEqual(4_096);
  });

  it('reports unsupported live pause and returns the actual terminal race state', async () => {
    const caller = new FakeCaller();
    const adapter = new ArcWorkerRunnerAdapter({
      client: new WorkerMcpWireClient(caller),
      engine: 'codex',
      pollIntervalMs: 10,
    });
    await expect(adapter.pause({ id: 'wrk-1' })).rejects.toMatchObject({
      code: 'runner_failure',
      details: { pauseSupport: 'not_supported_at_phase' },
    });
    caller.status = 'completed';
    await expect(adapter.pause({ id: 'wrk-1' })).resolves.toEqual({ state: 'finished' });
  });

  it('maps durable terminal states and refuses ambiguous recovery', () => {
    expect(mapWorkerState({ id: '1', status: 'failed' })).toEqual({ state: 'finished' });
    expect(mapWorkerState({ id: '1', status: 'timed_out' })).toEqual({ state: 'finished' });
    expect(mapWorkerState({ id: '1', status: 'aborted' })).toEqual({ state: 'cancelled' });
    expect(() => mapWorkerState({ id: '1', status: 'recovery_required' })).toThrowError(
      expect.objectContaining({ code: 'runner_failure' }),
    );
  });

  it('rejects malformed wire responses instead of guessing state', async () => {
    const client = new WorkerMcpWireClient({
      callTool: async () => ({ structuredContent: { worker: { id: 'wrk-1', status: 'mystery' } } }),
    });
    await expect(client.status('wrk-1')).rejects.toThrow();
  });
});

class FakeCaller implements WorkerToolCaller {
  readonly calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  status = 'running';

  async callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<WorkerToolResult> {
    this.calls.push(request);
    if (request.name === 'worker_dispatch') {
      return {
        structuredContent: {
          deduplicated: false,
          retriedTerminal: false,
          worker: {
            id: 'wrk-1',
            status: this.status,
            dedupeKey: request.arguments?.dedupe_key,
          },
        },
      };
    }
    return { structuredContent: { worker: { id: 'wrk-1', status: this.status } } };
  }
}

function executionInput(): ArcExecutionInput {
  return {
    contract_version: 'autoresearchclaw.input.v1',
    project_id: 'project-1',
    run_id: 'run-1',
    objective: 'Test prompt hygiene and durable dispatch.',
    project_root: '/tmp/project',
    artifact_path: '.metabot-arc/runs/run-1/output.json',
    requested_at: '2026-08-06T00:00:00.000Z',
    parameters: { sample_size: 3 },
  };
}
