import { z } from 'zod';

export const workerStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'timed_out',
  'aborted',
  'recovery_required',
]);

export const workerRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    status: workerStatusSchema,
    dedupeKey: z.string().optional(),
    terminalReason: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const workerDispatchResultSchema = z
  .object({
    deduplicated: z.boolean(),
    retriedTerminal: z.boolean(),
    worker: workerRecordSchema,
  })
  .passthrough();

export const workerStatusResultSchema = z.object({ worker: workerRecordSchema }).passthrough();

export type WorkerRecordWire = z.infer<typeof workerRecordSchema>;

export interface WorkerToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

export interface WorkerToolCaller {
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

export class WorkerMcpWireClient {
  constructor(private readonly caller: WorkerToolCaller) {}

  async dispatch(argumentsValue: Record<string, unknown>): Promise<z.infer<typeof workerDispatchResultSchema>> {
    return workerDispatchResultSchema.parse(await this.call('worker_dispatch', argumentsValue));
  }

  async status(id: string): Promise<WorkerRecordWire> {
    return workerStatusResultSchema.parse(await this.call('worker_status', { id })).worker;
  }

  async abort(id: string): Promise<WorkerRecordWire> {
    return workerStatusResultSchema.parse(await this.call('worker_abort', { id })).worker;
  }

  private async call(name: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    const raw = await this.caller.callTool({ name, arguments: argumentsValue });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Worker Runner ${name} returned a malformed tool result`);
    }
    const result = raw as WorkerToolResult;
    if (result.isError) {
      const detail =
        result.content?.find((item) => item.type === 'text' && item.text)?.text ?? JSON.stringify(result.structuredContent);
      throw new Error(`Worker Runner ${name} failed: ${detail}`);
    }
    if (!result.structuredContent) throw new Error(`Worker Runner ${name} returned no structured content`);
    return result.structuredContent;
  }
}
