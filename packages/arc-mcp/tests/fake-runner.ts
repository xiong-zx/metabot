import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ArcExecutionHandle, ArcExecutionInput } from '../src/contract.js';
import type { ArcRunner } from '../src/runner.js';

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
  readonly states = new Map<string, 'running' | 'paused' | 'cancelled'>();
  readonly startCalls: ArcExecutionInput[] = [];
  private readonly completions = new Map<string, Deferred>();
  private readonly outputs = new Map<string, unknown>();
  private readonly omitArtifacts = new Set<string>();

  async start(input: ArcExecutionInput): Promise<ArcExecutionHandle> {
    const handle = { id: `fake-${input.run_id}` };
    this.inputs.set(handle.id, input);
    this.states.set(handle.id, 'running');
    this.startCalls.push(input);
    this.completions.set(handle.id, deferred());
    return handle;
  }

  async pause(handle: ArcExecutionHandle): Promise<void> {
    this.states.set(handle.id, 'paused');
  }

  async resume(handle: ArcExecutionHandle): Promise<void> {
    this.states.set(handle.id, 'running');
  }

  async cancel(handle: ArcExecutionHandle): Promise<void> {
    this.states.set(handle.id, 'cancelled');
    this.completions.get(handle.id)?.resolve();
  }

  async collect(handle: ArcExecutionHandle): Promise<unknown> {
    await this.completions.get(handle.id)?.promise;
    if (this.states.get(handle.id) === 'cancelled' || this.omitArtifacts.has(handle.id)) return;
    const input = this.inputs.get(handle.id);
    if (!input) throw new Error(`Missing fake input for ${handle.id}`);
    const target = path.join(input.project_root, input.artifact_path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(this.outputs.get(handle.id), null, 2)}\n`, 'utf8');
  }

  finish(handleId: string, output: unknown): void {
    this.outputs.set(handleId, output);
    this.completions.get(handleId)?.resolve();
  }

  finishWithoutArtifact(handleId: string): void {
    this.omitArtifacts.add(handleId);
    this.completions.get(handleId)?.resolve();
  }
}
