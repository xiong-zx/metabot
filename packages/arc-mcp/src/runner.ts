import type { ArcExecutionHandle, ArcExecutionInput } from './contract.js';

/**
 * The only execution dependency owned by ARC. A future Worker Runner adapter
 * can implement this interface without ARC importing WorkerManager or bridge code.
 */
export interface ArcRunner {
  start(input: ArcExecutionInput): Promise<ArcExecutionHandle>;
  pause(handle: ArcExecutionHandle): Promise<void>;
  resume(handle: ArcExecutionHandle): Promise<void>;
  cancel(handle: ArcExecutionHandle): Promise<void>;
  collect(handle: ArcExecutionHandle): Promise<unknown>;
}

/**
 * A completed ARC artifact is intentionally passive. A future Memory MCP may
 * implement this interface and consume it explicitly; ARC never promotes it.
 */
export interface ArcResultConsumer {
  consume(result: { runId: string; projectId: string; projectRoot: string; artifactPath: string }): Promise<void>;
}
