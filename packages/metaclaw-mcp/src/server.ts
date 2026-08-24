import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { asMetaClawError } from './errors.js';
import type { MetaClawRuntime } from './runtime.js';
import {
  emptyInput,
  inferInputSchema,
  METACLAW_TOOL_DESCRIPTIONS,
  runHealth,
  runInfer,
  runSkillGet,
  runSkillsList,
  runStatus,
  skillGetInputSchema,
} from './tools.js';

/**
 * The strict schema objects are registered whole, not spread into raw shapes.
 *
 * `z.object({...}).strict()` carries the strictness on the object; a raw shape
 * is just its properties, so registering `schema.shape` hands the SDK an
 * ordinary object and the refusal of unknown keys is dropped on the floor. The
 * advertised JSON Schema loses `additionalProperties: false` and `tools/call`
 * accepts `{"messages": [...], "model": "expensive-model"}` — the exact input
 * the strictness existed to refuse. The declared schema constants stayed strict
 * the whole time, which is why a test that asserted against them agreed with a
 * server that did not.
 */
export const METACLAW_SERVER_NAME = 'metaclaw-mcp';
export const METACLAW_SERVER_VERSION = '0.1.0';

/**
 * stdio only.
 *
 * There is no lifecycle ownership here: one stdio process per client reads the
 * same product-owned fixed profile and talks to the operator-started service.
 */
export function createMetaClawMcpServer(runtime: MetaClawRuntime): McpServer {
  const server = new McpServer(
    { name: METACLAW_SERVER_NAME, version: METACLAW_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'metaclaw_health',
    {
      description: METACLAW_TOOL_DESCRIPTIONS.metaclaw_health,
      inputSchema: emptyInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    () => invoke(runtime, () => runHealth(runtime)),
  );

  server.registerTool(
    'metaclaw_status',
    {
      description: METACLAW_TOOL_DESCRIPTIONS.metaclaw_status,
      inputSchema: emptyInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => invoke(runtime, () => runStatus(runtime)),
  );

  server.registerTool(
    'metaclaw_infer',
    {
      description: METACLAW_TOOL_DESCRIPTIONS.metaclaw_infer,
      inputSchema: inferInputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
    },
    (request) => invoke(runtime, () => runInfer(runtime, request)),
  );

  server.registerTool(
    'metaclaw_skills_list',
    {
      description: METACLAW_TOOL_DESCRIPTIONS.metaclaw_skills_list,
      inputSchema: emptyInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => invoke(runtime, () => runSkillsList(runtime)),
  );

  server.registerTool(
    'metaclaw_skill_get',
    {
      description: METACLAW_TOOL_DESCRIPTIONS.metaclaw_skill_get,
      inputSchema: skillGetInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (request) => invoke(runtime, () => runSkillGet(runtime, request)),
  );

  return server;
}

export async function connectMetaClawStdioServer(runtime: MetaClawRuntime): Promise<McpServer> {
  const server = createMetaClawMcpServer(runtime);
  await server.connect(new StdioServerTransport());
  return server;
}

async function invoke(
  runtime: MetaClawRuntime,
  operation: () => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const value = (await operation()) as Record<string, unknown>;
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  } catch (error) {
    // Every failure crosses this one boundary, and it redacts. A per-call-site
    // decision about what is safe to stringify is a decision someone forgets.
    const failure = asMetaClawError(error, runtime.redact);
    const payload = { error: failure.toJSON() };
    return { isError: true, content: [{ type: 'text', text: runtime.redact(JSON.stringify(payload)) }] };
  }
}
