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

export const ARC_TRUSTED_ROLES = ['admin', 'user', 'pm', 'manager', 'agent', 'worker'] as const;
export type ArcTrustedRole = (typeof ARC_TRUSTED_ROLES)[number];
export interface ArcTrustedPrincipal {
  role: ArcTrustedRole;
  botName: string;
  chatId: string;
}

export const LOCAL_LIFECYCLE_ADMIN_PRINCIPAL = {
  role: 'admin',
  botName: 'metabot-local-lifecycle',
  chatId: 'local:daemon-lifecycle',
} as const satisfies ArcTrustedPrincipal;

export interface ArcMcpServerOptions {
  principal?: ArcTrustedPrincipal;
  authorizingCapability?: string;
}

const runOutputSchema = z.object({ run: arcRunRecordSchema }).strict();
const listOutputSchema = z.object({ runs: z.array(arcRunRecordSchema) }).strict();

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

export function createArcMcpServer(coordinator: ArcCoordinator, options: ArcMcpServerOptions = {}): McpServer {
  const principal = options.principal ? normalizeArcPrincipal(options.principal) : undefined;
  const server = new McpServer({ name: 'metabot-arc-mcp', version: '0.2.0' }, { capabilities: { tools: {} } });

  server.registerTool(
    'arc_run_start',
    {
      description: 'Create an idempotent AutoResearchClaw run and start its configured runner.',
      inputSchema: arcStartRequestSchema,
      outputSchema: runOutputSchema,
      annotations: { idempotentHint: true },
    },
    (request) =>
      invoke(async () => {
        authorizeArcMutation(principal);
        return {
          run: await coordinator.start(
            request,
            principal ? { bot_name: principal.botName, chat_id: principal.chatId } : undefined,
            options.authorizingCapability,
          ),
        };
      }),
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
      invoke(async () => {
        authorizeArcMutation(principal);
        return { run: await coordinator.pause(request) };
      }),
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
      invoke(async () => {
        authorizeArcMutation(principal);
        return { run: await coordinator.resume(request) };
      }),
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
      invoke(async () => {
        authorizeArcMutation(principal);
        return { run: await coordinator.cancel(request) };
      }),
  );

  return server;
}

export function normalizeArcPrincipal(principal: ArcTrustedPrincipal): ArcTrustedPrincipal {
  if (!ARC_TRUSTED_ROLES.includes(principal.role)) {
    throw new ArcError('scope_denied', 'ARC connection role is not recognized');
  }
  const botName = principal.botName.trim();
  const chatId = principal.chatId.trim();
  if (!botName || botName.length > 200 || !chatId || chatId.length > 500) {
    throw new ArcError('scope_denied', 'ARC connection principal is invalid');
  }
  if (chatId.toLowerCase().startsWith('team:')) {
    throw new ArcError('scope_denied', 'Agent Team chats cannot be trusted ARC principals');
  }
  const normalized = { role: principal.role, botName, chatId };
  if (normalized.role === 'admin' && !isLocalLifecycleAdmin(normalized)) {
    throw new ArcError('scope_denied', 'Only the fixed local lifecycle identity may use the ARC admin role');
  }
  return normalized;
}

function authorizeArcMutation(principal: ArcTrustedPrincipal | undefined): void {
  // No principal means the existing operator-pinned standalone stdio mode.
  if (!principal || ['user', 'pm'].includes(principal.role)) return;
  throw new ArcError('scope_denied', `Role ${principal.role} is read-only for ARC`);
}

function isLocalLifecycleAdmin(principal: ArcTrustedPrincipal): boolean {
  return (
    principal.role === LOCAL_LIFECYCLE_ADMIN_PRINCIPAL.role &&
    principal.botName === LOCAL_LIFECYCLE_ADMIN_PRINCIPAL.botName &&
    principal.chatId === LOCAL_LIFECYCLE_ADMIN_PRINCIPAL.chatId
  );
}

export async function connectArcStdioServer(coordinator: ArcCoordinator): Promise<McpServer> {
  await coordinator.recover();
  const server = createArcMcpServer(coordinator);
  await server.connect(new StdioServerTransport());
  return server;
}
