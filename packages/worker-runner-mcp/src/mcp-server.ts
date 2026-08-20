import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DispatchWorkerInput, GenericOutputContract, TrustedPrincipal, WorkerRecord } from './types.js';
import type { RulesPackChildGrantV1 } from '@metabot/rulespack';
import { WorkerRunnerError } from './types.js';
import type { WorkerService } from './service.js';

export const WORKER_RUNNER_TOOLS: Tool[] = [
  {
    name: 'worker_dispatch',
    description:
      'Persist and asynchronously launch one one-shot Codex, Claude, or Kimi CLI job in an explicit absolute workdir. ' +
      'Authority and bot/chat scope are pinned by the MCP server process and are not tool arguments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workdir: { type: 'string', description: 'Existing absolute working directory.' },
        prompt: { type: 'string', description: 'One-shot task instructions.' },
        engine: { type: 'string', enum: ['codex', 'claude', 'kimi'] },
        model: { type: 'string' },
        label: { type: 'string' },
        dedupe_key: {
          type: 'string',
          description: 'Scope-local idempotency key.',
        },
        dedupe_ttl_ms: {
          type: 'integer',
          minimum: 0,
          description: 'How long a successful result is reused for this key.',
        },
        retry_terminal: {
          type: 'boolean',
          description: 'When true, failed/aborted/timed-out/recovery-required jobs do not poison the key.',
        },
        timeout_ms: { type: 'integer', minimum: 1, description: 'Bounded wall-clock timeout.' },
        idle_timeout_ms: { type: 'integer', minimum: 1, description: 'Bounded no-output timeout.' },
        recovery_policy: {
          type: 'object',
          additionalProperties: false,
          properties: {
            restart: { type: 'string', enum: ['manual', 'relaunch'] },
            idempotent: { type: 'boolean' },
          },
          required: ['restart', 'idempotent'],
          description: 'Per-run restart policy. relaunch is accepted only with idempotent=true.',
        },
        output_contract: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional generic final-response contract; no artifact inference is performed.',
          properties: {
            format: { type: 'string', enum: ['text', 'json'] },
            description: { type: 'string' },
            json_schema: { type: 'object' },
          },
          required: ['format'],
        },
      },
      required: ['workdir', 'prompt', 'engine'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'worker_list',
    description:
      'List bounded worker metadata in the pinned bot+chat scope. Only the fixed read-only lifecycle admin may request all scopes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        all_scopes: { type: 'boolean' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'worker_status',
    description: 'Read bounded lifecycle, process output/error, timing, recovery, and notification metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'worker_abort',
    description: 'Abort a job owned by the pinned principal without trusting a persisted PID from another process.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

export interface WorkerRunnerMcpOptions {
  authorizingCapability?: string;
  /** Verified daemon-session context; never accepted from tool arguments. */
  rulesPackChildGrant?: RulesPackChildGrantV1;
  maxStatusOutputChars?: number;
}

export function createWorkerRunnerMcpServer(
  service: WorkerService,
  principal: TrustedPrincipal | undefined,
  options: WorkerRunnerMcpOptions = {},
): Server {
  service.assertTrustedPrincipal(principal);
  const authenticatedPrincipal = principal as TrustedPrincipal;
  const maxStatusOutputChars = options.maxStatusOutputChars ?? 16_384;
  if (!Number.isSafeInteger(maxStatusOutputChars) || maxStatusOutputChars < 1 || maxStatusOutputChars > 65_536) {
    throw new Error('maxStatusOutputChars must be an integer between 1 and 65536');
  }

  const server = new Server(
    { name: 'metabot-worker-runner', version: '0.2.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Standalone one-shot CLI worker runner. Authority and scope are pinned by this server instance, never supplied by tool arguments.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: WORKER_RUNNER_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = requireObject(request.params.arguments);
      switch (request.params.name) {
        case 'worker_dispatch': {
          assertAllowedKeys(args, [
            'workdir',
            'prompt',
            'engine',
            'model',
            'label',
            'dedupe_key',
            'dedupe_ttl_ms',
            'retry_terminal',
            'timeout_ms',
            'idle_timeout_ms',
            'recovery_policy',
            'output_contract',
          ]);
          const contract = asOptionalObject(args.output_contract);
          const recovery = asOptionalObject(args.recovery_policy);
          if (contract) assertAllowedKeys(contract, ['format', 'description', 'json_schema']);
          if (recovery) assertAllowedKeys(recovery, ['restart', 'idempotent']);
          const result = await service.dispatch({
            workdir: asString(args.workdir),
            prompt: asString(args.prompt),
            engine: asString(args.engine) as DispatchWorkerInput['engine'],
            ...(args.model !== undefined ? { model: asString(args.model) } : {}),
            ...(args.label !== undefined ? { label: asString(args.label) } : {}),
            ...(args.dedupe_key !== undefined ? { dedupeKey: asString(args.dedupe_key) } : {}),
            ...(args.dedupe_ttl_ms !== undefined || args.retry_terminal !== undefined
              ? {
                  dedupePolicy: {
                    ...(args.dedupe_ttl_ms !== undefined ? { completedTtlMs: asNumber(args.dedupe_ttl_ms) } : {}),
                    ...(args.retry_terminal !== undefined ? { retryTerminal: asBoolean(args.retry_terminal) } : {}),
                  },
                }
              : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: asNumber(args.timeout_ms) } : {}),
            ...(args.idle_timeout_ms !== undefined ? { idleTimeoutMs: asNumber(args.idle_timeout_ms) } : {}),
            ...(recovery
              ? {
                  recoveryPolicy: {
                    restart: asString(recovery.restart) as 'manual' | 'relaunch',
                    idempotent: asBoolean(recovery.idempotent),
                  },
                }
              : {}),
            ...(contract
              ? {
                  outputContract: {
                    format: asString(contract.format) as GenericOutputContract['format'],
                    ...(contract.description !== undefined ? { description: asString(contract.description) } : {}),
                    ...(contract.json_schema !== undefined ? { jsonSchema: requireObject(contract.json_schema) } : {}),
                  },
                }
              : {}),
          }, authenticatedPrincipal, options.authorizingCapability, options.rulesPackChildGrant);
          return toolResult({
            deduplicated: result.deduplicated,
            retriedTerminal: result.retriedTerminal,
            worker: listWorker(result.worker),
          });
        }
        case 'worker_list': {
          assertAllowedKeys(args, ['limit', 'all_scopes']);
          const workers = service.list({
            ...(args.limit !== undefined ? { limit: asNumber(args.limit) } : {}),
            ...(args.all_scopes !== undefined ? { allScopes: asBoolean(args.all_scopes) } : {}),
          }, authenticatedPrincipal);
          return toolResult({ workers: workers.map(listWorker) });
        }
        case 'worker_status':
          assertAllowedKeys(args, ['id']);
          return toolResult({
            worker: statusWorker(service.status(asString(args.id), authenticatedPrincipal), maxStatusOutputChars),
          });
        case 'worker_abort':
          assertAllowedKeys(args, ['id']);
          return toolResult({ worker: listWorker(await service.abort(asString(args.id), authenticatedPrincipal)) });
        default:
          throw new WorkerRunnerError(`Unknown tool: ${request.params.name}`, 'NOT_FOUND');
      }
    } catch (error) {
      const normalized =
        error instanceof WorkerRunnerError
          ? { code: error.code, error: error.message }
          : { code: 'INTERNAL_ERROR', error: error instanceof Error ? error.message : String(error) };
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(normalized) }],
        structuredContent: normalized,
      };
    }
  });
  return server;
}

function listWorker(worker: WorkerRecord): Record<string, unknown> {
  return {
    id: worker.id,
    botName: worker.botName,
    chatId: worker.chatId,
    workdir: worker.workdir,
    engine: worker.engine,
    ...(worker.model ? { model: worker.model } : {}),
    ...(worker.label ? { label: worker.label } : {}),
    ...(worker.dedupeKey ? { dedupeKey: worker.dedupeKey } : {}),
    status: worker.status,
    launchCount: worker.launchCount,
    recoveryCount: worker.recoveryCount,
    createdAt: worker.createdAt,
    ...(worker.startedAt !== undefined ? { startedAt: worker.startedAt } : {}),
    ...(worker.finishedAt !== undefined ? { finishedAt: worker.finishedAt } : {}),
    ...(worker.durationMs !== undefined ? { durationMs: worker.durationMs } : {}),
    ...(worker.terminalReason ? { terminalReason: worker.terminalReason } : {}),
    ...(worker.error ? { error: worker.error.slice(0, 500) } : {}),
    notificationState: worker.notificationState,
  };
}

function statusWorker(worker: WorkerRecord, maxOutputChars: number): Record<string, unknown> {
  const stdout = boundedText(worker.stdout, maxOutputChars);
  const stderr = boundedText(worker.stderr, maxOutputChars);
  return {
    ...listWorker(worker),
    timeoutMs: worker.timeoutMs,
    idleTimeoutMs: worker.idleTimeoutMs,
    recoveryPolicy: worker.recoveryPolicy,
    dedupePolicy: worker.dedupePolicy,
    ...(worker.lastActivityAt !== undefined ? { lastActivityAt: worker.lastActivityAt } : {}),
    ...(worker.exitCode !== undefined ? { exitCode: worker.exitCode } : {}),
    ...(worker.signal ? { signal: worker.signal } : {}),
    ...(stdout.text !== undefined ? { stdout: stdout.text } : {}),
    ...(stderr.text !== undefined ? { stderr: stderr.text } : {}),
    stdoutTruncated: worker.stdoutTruncated || stdout.readTruncated,
    stderrTruncated: worker.stderrTruncated || stderr.readTruncated,
    ...(worker.outputContract
      ? {
          outputContract: {
            format: worker.outputContract.format,
            ...(worker.outputContract.description
              ? { description: worker.outputContract.description.slice(0, 1_000) }
              : {}),
            hasJsonSchema: worker.outputContract.jsonSchema !== undefined,
          },
        }
      : {}),
    notificationAttempts: worker.notificationAttempts,
    ...(worker.notificationNextAttemptAt !== undefined
      ? { notificationNextAttemptAt: worker.notificationNextAttemptAt }
      : {}),
    ...(worker.notificationLastError ? { notificationLastError: worker.notificationLastError.slice(0, 500) } : {}),
    ...(worker.notificationDeliveredAt !== undefined
      ? { notificationDeliveredAt: worker.notificationDeliveredAt }
      : {}),
  };
}

function boundedText(value: string | undefined, max: number): { text?: string; readTruncated: boolean } {
  if (value === undefined) return { readTruncated: false };
  if (value.length <= max) return { text: value, readTruncated: false };
  return { text: value.slice(0, max), readTruncated: true };
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function assertAllowedKeys(args: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unexpected.length) {
    throw new WorkerRunnerError(`Unexpected tool arguments: ${unexpected.sort().join(', ')}`, 'INVALID_INPUT');
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkerRunnerError('Tool arguments must be an object', 'INVALID_INPUT');
  }
  return value as Record<string, unknown>;
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireObject(value);
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new WorkerRunnerError('Expected a string tool argument', 'INVALID_INPUT');
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number') throw new WorkerRunnerError('Expected a numeric tool argument', 'INVALID_INPUT');
  return value;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new WorkerRunnerError('Expected a boolean tool argument', 'INVALID_INPUT');
  return value;
}
