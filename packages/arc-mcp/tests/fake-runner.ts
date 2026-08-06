import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ArcExecutionHandle, ArcExecutionInput } from '../src/contract.js';
import type { ArcRunner, ArcRunnerResult, ArcRunnerState } from '../src/runner.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class FakeArcRunner implements ArcRunner {
  readonly inputs = new Map<string, ArcExecutionInput>();
  readonly states = new Map<string, ArcRunnerState>();
  readonly startCalls: ArcExecutionInput[] = [];
  readonly pauseCalls: ArcExecutionHandle[] = [];
  readonly resumeCalls: ArcExecutionHandle[] = [];
  readonly cancelCalls: ArcExecutionHandle[] = [];
  readonly collectCalls: ArcExecutionHandle[] = [];
  private readonly handleByRunId = new Map<string, ArcExecutionHandle>();
  private readonly completions = new Map<string, Deferred>();
  private readonly outputs = new Map<string, unknown>();
  private readonly omitArtifacts = new Set<string>();

  async start(input: ArcExecutionInput): Promise<ArcExecutionHandle> {
    this.startCalls.push(input);
    const existing = this.handleByRunId.get(input.run_id);
    if (existing) return existing;
    const handle = { id: `fake-${input.run_id}` };
    this.handleByRunId.set(input.run_id, handle);
    this.inputs.set(handle.id, input);
    this.states.set(handle.id, 'running');
    this.completions.set(handle.id, deferred());
    return handle;
  }

  async pause(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    this.pauseCalls.push(handle);
    const state = this.requireState(handle);
    if (state === 'finished' || state === 'cancelled') return { state };
    this.states.set(handle.id, 'paused');
    return { state: 'paused' };
  }

  async resume(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    this.resumeCalls.push(handle);
    const state = this.requireState(handle);
    if (state === 'finished' || state === 'cancelled') return { state };
    this.states.set(handle.id, 'running');
    return { state: 'running' };
  }

  async cancel(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    this.cancelCalls.push(handle);
    const state = this.requireState(handle);
    if (state === 'finished' || state === 'cancelled') return { state };
    this.states.set(handle.id, 'cancelled');
    this.completions.get(handle.id)?.resolve();
    return { state: 'cancelled' };
  }

  async collect(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    this.collectCalls.push(handle);
    await this.completions.get(handle.id)?.promise;
    const state = this.requireState(handle);
    if (state === 'cancelled') return { state };
    if (state !== 'finished') return { state };
    if (!this.omitArtifacts.has(handle.id)) this.writeOutput(handle.id);
    return { state: 'finished' };
  }

  finish(handleId: string, output: unknown): void {
    this.outputs.set(handleId, output);
    this.states.set(handleId, 'finished');
    this.completions.get(handleId)?.resolve();
  }

  finishWithoutArtifact(handleId: string): void {
    this.omitArtifacts.add(handleId);
    this.states.set(handleId, 'finished');
    this.completions.get(handleId)?.resolve();
  }

  inputForRun(runId: string): ArcExecutionInput | undefined {
    const handle = this.handleByRunId.get(runId);
    return handle ? this.inputs.get(handle.id) : undefined;
  }

  private requireState(handle: ArcExecutionHandle): ArcRunnerState {
    const state = this.states.get(handle.id);
    if (!state) throw new Error(`Unknown fake handle: ${handle.id}`);
    return state;
  }

  private writeOutput(handleId: string): void {
    const input = this.inputs.get(handleId);
    if (!input) throw new Error(`Missing fake input for ${handleId}`);
    const target = path.join(input.project_root, input.artifact_path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(this.outputs.get(handleId), null, 2)}\n`, 'utf8');
  }
}
