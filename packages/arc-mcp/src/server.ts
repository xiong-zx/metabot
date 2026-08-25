import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  arcListRequestSchema,
  arcRunIdRequestSchema,
  arcStartRequestSchema,
  type ArcCoordinator,
} from './coordinator.js';
import { arcRunRecordSchema } from './contract.js';
import { ArcError, asArcError } from './errors.js';
import { arcHitlRequestRecordSchema, arcHitlResponseRecordSchema, arcHitlSubmitRequestSchema } from './hitl.js';
import { ARC_MCP_VERSION } from './releases/spec.js';
import { ArcSessionFacade } from './session-facade.js';

const runOutputSchema = z.object({ run: arcRunRecordSchema }).strict();
const listOutputSchema = z.object({ runs: z.array(arcRunRecordSchema) }).strict();
const hitlSubmitOutputSchema = z.object({ run: arcRunRecordSchema, response: arcHitlResponseRecordSchema }).strict();
const manifestOutputSchema = z
  .object({
    // The manifest's own contract lives in provenance.ts; restating its full
    // shape here would create a second place to keep in sync.
    manifest: z.record(z.string(), z.unknown()),
    pending_hitl: z.array(arcHitlRequestRecordSchema),
  })
  .strict();

function success(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function failure(error: unknown): CallToolResult {
  const arcError = error instanceof ArcError ? error : asArcError(error);
  const data = { error: arcError.toJSON() };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

async function invoke(operation: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await operation();
    return success(value as Record<string, unknown>);
  } catch (error) {
    return failure(error);
  }
}

export function createArcMcpServer(coordinator: ArcCoordinator): McpServer {
  const session = new ArcSessionFacade(coordinator, coordinator.artifacts, coordinator.scope);
  const server = new McpServer({ name: 'arc-mcp', version: ARC_MCP_VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    'arc_run_start',
    {
      description: 'Create an idempotent AutoResearchClaw run and start its configured runner.',
      inputSchema: arcStartRequestSchema,
      outputSchema: runOutputSchema,
      annotations: { idempotentHint: true },
    },
    (request) => invoke(async () => ({ run: await coordinator.start(request) })),
  );

  server.registerTool(
    'arc_run_get',
    {
      description: 'Read one durable AutoResearchClaw run record.',
      inputSchema: arcRunIdRequestSchema,
      outputSchema: runOutputSchema,
      annotations: { readOnlyHint: true },
    },
    (request) => invoke(() => ({ run: coordinator.get(request) })),
  );

  server.registerTool(
    'arc_run_list',
    {
      description: 'List bounded AutoResearchClaw run summaries, optionally filtered by project or status.',
      inputSchema: arcListRequestSchema,
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true },
    },
    (request) => invoke(() => ({ runs: coordinator.list(request) })),
  );

  server.registerTool(
    'arc_run_pause',
    {
      description: 'Request a checkpoint-safe pause for a running AutoResearchClaw run.',
      inputSchema: arcRunIdRequestSchema,
      outputSchema: runOutputSchema,
      annotations: { idempotentHint: true },
    },
    (request) =>
      invoke(async () => ({ run: await coordinator.pause(request) })),
  );

  server.registerTool(
    'arc_run_resume',
    {
      description: 'Resume a paused or restart-recovered AutoResearchClaw run.',
      inputSchema: arcRunIdRequestSchema,
      outputSchema: runOutputSchema,
      annotations: { idempotentHint: true },
    },
    (request) =>
      invoke(async () => ({ run: await coordinator.resume(request) })),
  );

  server.registerTool(
    'arc_run_cancel',
    {
      description: 'Idempotently cancel a queued, running, or paused AutoResearchClaw run.',
      inputSchema: arcRunIdRequestSchema,
      outputSchema: runOutputSchema,
      annotations: { idempotentHint: true, destructiveHint: true },
    },
    (request) =>
      invoke(async () => ({ run: await coordinator.cancel(request) })),
  );

  server.registerTool(
    'arc_hitl_submit',
    {
      description: 'Record one human decision for a gate the official AutoResearchClaw pipeline is waiting on.',
      inputSchema: arcHitlSubmitRequestSchema,
      outputSchema: hitlSubmitOutputSchema,
      annotations: { idempotentHint: false },
    },
    (request) =>
      invoke(() => session.submitHitl(request)),
  );

  server.registerTool(
    'arc_run_manifest',
    {
      description:
        'Read the provenance-first result manifest for one run, plus the official gates still awaiting a decision.',
      inputSchema: arcRunIdRequestSchema,
      outputSchema: manifestOutputSchema,
      annotations: { readOnlyHint: true },
    },
    (request) => invoke(() => session.artifactManifest(request)),
  );

  return server;
}

export async function connectArcStdioServer(coordinator: ArcCoordinator): Promise<McpServer> {
  await coordinator.recover();
  const server = createArcMcpServer(coordinator);
  await server.connect(new StdioServerTransport());
  return server;
}
