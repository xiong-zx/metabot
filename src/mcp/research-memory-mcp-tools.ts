type ApiRequest = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>;

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

const MEMORY_TOOL_NAMES = new Set([
  'memory_log_event',
  'memory_units',
  'memory_runs',
  'memory_artifacts',
  'memory_search',
  'memory_context_pack',
  'research_loop_dispatch',
  'research_memory_ingest',
  'memory_promotion_request',
  'memory_promotion_approve',
  'memory_promotion_reject',
  'memory_supersede',
  'memory_redact',
]);

export const RESEARCH_MEMORY_MCP_TOOLS = [
  {
    name: 'memory_log_event',
    description:
      'Append a policy-controlled private/project memory event. This tool cannot directly create domain/global approved memory or supersede/redact existing memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
        type: { type: 'string', description: 'Memory event type, e.g. decision, finding, negative_result' },
        summary: { type: 'string', description: 'Short memory summary' },
        body: { type: 'string', description: 'Optional detailed body' },
        projectId: { type: 'string', description: 'Project id' },
        runId: { type: 'string', description: 'Run id' },
        domain: { type: 'string', description: 'Domain name' },
        visibility: { type: 'string', enum: ['private', 'project'], description: 'Direct log visibility' },
        actorKind: { type: 'string', enum: ['user', 'bot', 'agent', 'worker', 'system'] },
        actorId: { type: 'string' },
        status: { type: 'string', enum: ['live', 'candidate'] },
      },
      required: ['root', 'type', 'summary'],
    },
  },
  {
    name: 'memory_units',
    description: 'List active policy-safe memory units for a project root.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
      },
      required: ['root'],
    },
  },
  {
    name: 'memory_runs',
    description: 'List research run lifecycle records from the project-local memory store.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
        projectId: { type: 'string' },
      },
      required: ['root'],
    },
  },
  {
    name: 'memory_artifacts',
    description: 'List indexed research artifacts from the project-local memory store.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
        projectId: { type: 'string' },
        runId: { type: 'string' },
      },
      required: ['root'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search active policy-safe memory units.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
        query: { type: 'string' },
        projectId: { type: 'string' },
        runId: { type: 'string' },
        domain: { type: 'string' },
        limit: { type: 'number' },
        includeCandidates: { type: 'boolean' },
      },
      required: ['root', 'query'],
    },
  },
  {
    name: 'memory_context_pack',
    description: 'Build a token-budgeted context pack for coding/research/review/planning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
        purpose: { type: 'string', enum: ['coding', 'research', 'review', 'planning', 'ops', 'report'] },
        query: { type: 'string' },
        tokenBudget: { type: 'number' },
        projectId: { type: 'string' },
        runId: { type: 'string' },
        domain: { type: 'string' },
        includeCandidates: { type: 'boolean' },
        actorKind: { type: 'string', enum: ['user', 'bot', 'agent', 'worker', 'system'] },
        actorId: { type: 'string' },
      },
      required: ['root', 'query'],
    },
  },
  {
    name: 'research_memory_ingest',
    description:
      'Ingest a validated AutoResearchClaw output object into the Unified Memory Core. Use reviewRequired=true to stage candidate events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
        output: { type: 'object', description: 'AutoResearchClaw output JSON object' },
        projectId: { type: 'string' },
        runId: { type: 'string' },
        domain: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'project'] },
        actorKind: { type: 'string', enum: ['agent', 'worker', 'system'] },
        actorId: { type: 'string' },
        workerEventId: { type: 'string' },
        reviewRequired: { type: 'boolean' },
      },
      required: ['root', 'output'],
    },
  },
  {
    name: 'research_loop_dispatch',
    description:
      'Dispatch an AutoResearchClaw research loop through WorkerManager. Returns immediately; memory ingestion happens from the output artifact after the worker completes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root allowed by the bridge memory allowlist' },
        projectId: { type: 'string' },
        runId: { type: 'string' },
        task: { type: 'string' },
        domain: { type: 'string' },
        botName: { type: 'string' },
        pmChatId: { type: 'string' },
        tokenBudget: { type: 'number' },
        reviewRequired: { type: 'boolean' },
        model: { type: 'string' },
        engine: { type: 'string', enum: ['claude', 'codex', 'kimi'] },
        reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
        approvalPolicy: { type: 'string', enum: ['untrusted', 'on-failure', 'on-request', 'never'] },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
        timeoutMs: { type: 'number' },
        idleTimeoutMs: { type: 'number' },
      },
      required: ['root', 'projectId', 'task', 'botName', 'pmChatId'],
    },
  },
  {
    name: 'memory_promotion_request',
    description: 'Request promotion of an active project memory event to domain/global scope. Approval is separate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string' },
        targetEventId: { type: 'string' },
        targetVisibility: { type: 'string', enum: ['domain', 'global'] },
        targetDomain: { type: 'string' },
        reason: { type: 'string' },
        projectId: { type: 'string' },
        domain: { type: 'string' },
        actorKind: { type: 'string', enum: ['agent', 'system', 'user'] },
        actorId: { type: 'string' },
      },
      required: ['root', 'targetEventId', 'targetVisibility'],
    },
  },
  {
    name: 'memory_promotion_approve',
    description:
      'Approve a pending promotion request by request event id. Requires authority visibility matching the target.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string' },
        requestEventId: { type: 'string' },
        visibility: { type: 'string', enum: ['domain', 'global'] },
        domain: { type: 'string' },
        reason: { type: 'string' },
        actorKind: { type: 'string', enum: ['user', 'system'] },
        actorId: { type: 'string' },
      },
      required: ['root', 'requestEventId', 'visibility'],
    },
  },
  {
    name: 'memory_promotion_reject',
    description: 'Reject a pending promotion request by request event id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string' },
        requestEventId: { type: 'string' },
        reason: { type: 'string' },
        actorKind: { type: 'string', enum: ['user', 'system'] },
        actorId: { type: 'string' },
      },
      required: ['root', 'requestEventId'],
    },
  },
  {
    name: 'memory_supersede',
    description: 'Append a policy-checked supersede tombstone for active memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string' },
        targetEventId: { type: 'string' },
        replacementEventId: { type: 'string' },
        reason: { type: 'string' },
        visibility: { type: 'string', enum: ['project', 'domain', 'global'] },
        projectId: { type: 'string' },
        domain: { type: 'string' },
        actorKind: { type: 'string', enum: ['agent', 'system', 'user'] },
        actorId: { type: 'string' },
      },
      required: ['root', 'targetEventId'],
    },
  },
  {
    name: 'memory_redact',
    description: 'Append a redaction tombstone. Requires user/system actor and authority visibility.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string' },
        targetEventId: { type: 'string' },
        reason: { type: 'string' },
        visibility: { type: 'string', enum: ['project', 'domain', 'global'] },
        projectId: { type: 'string' },
        domain: { type: 'string' },
        actorKind: { type: 'string', enum: ['user', 'system'] },
        actorId: { type: 'string' },
      },
      required: ['root', 'targetEventId'],
    },
  },
];

export function isResearchMemoryMcpTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

export async function callResearchMemoryMcpTool(name: string, args: any, apiRequest: ApiRequest): Promise<ToolResult> {
  switch (name) {
    case 'memory_log_event':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/events', {
          root: requireString(args?.root, 'root'),
          event: {
            type: normalizeEventType(requireString(args?.type, 'type')),
            summary: requireString(args?.summary, 'summary'),
            body: optionalString(args?.body),
            actor: actor(args, 'agent', 'mcp'),
            scope: scope(args, optionalString(args?.visibility) ?? 'project'),
            status: optionalString(args?.status),
          },
        }),
      );
    case 'memory_units':
      return apiToolResult(
        await apiRequest(
          'GET',
          `/api/research-memory/units?root=${encodeURIComponent(requireString(args?.root, 'root'))}`,
        ),
      );
    case 'memory_runs': {
      const params = new URLSearchParams({ root: requireString(args?.root, 'root') });
      addOptional(params, 'projectId', optionalString(args?.projectId));
      return apiToolResult(await apiRequest('GET', `/api/research-memory/runs?${params.toString()}`));
    }
    case 'memory_artifacts': {
      const params = new URLSearchParams({ root: requireString(args?.root, 'root') });
      addOptional(params, 'projectId', optionalString(args?.projectId));
      addOptional(params, 'runId', optionalString(args?.runId));
      return apiToolResult(await apiRequest('GET', `/api/research-memory/artifacts?${params.toString()}`));
    }
    case 'memory_search': {
      const params = new URLSearchParams({
        root: requireString(args?.root, 'root'),
        q: requireString(args?.query, 'query'),
      });
      addOptional(params, 'projectId', optionalString(args?.projectId));
      addOptional(params, 'runId', optionalString(args?.runId));
      addOptional(params, 'domain', optionalString(args?.domain));
      addOptional(params, 'limit', args?.limit === undefined ? undefined : String(args.limit));
      if (args?.includeCandidates === true) params.set('includeCandidates', 'true');
      return apiToolResult(await apiRequest('GET', `/api/research-memory/search?${params.toString()}`));
    }
    case 'memory_context_pack':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/context-pack', {
          root: requireString(args?.root, 'root'),
          purpose: optionalString(args?.purpose) ?? 'research',
          query: requireString(args?.query, 'query'),
          tokenBudget: optionalNumber(args?.tokenBudget) ?? 4000,
          includeCandidates: args?.includeCandidates === true,
          scopeFilter: compact({
            project_id: optionalString(args?.projectId),
            run_id: optionalString(args?.runId),
            domain: optionalString(args?.domain),
          }),
          ...(args?.actorKind || args?.actorId
            ? { actor: actor(args, 'agent', 'mcp'), scope: scope(args, 'project') }
            : {}),
        }),
      );
    case 'research_memory_ingest':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/autoresearchclaw/ingest', {
          root: requireString(args?.root, 'root'),
          output: requireRecord(args?.output, 'output'),
          actor: actor(args, 'agent', 'autoresearchclaw'),
          scope: scope(args, optionalString(args?.visibility) ?? 'project'),
          workerEventId: optionalString(args?.workerEventId),
          reviewRequired: args?.reviewRequired === true,
        }),
      );
    case 'research_loop_dispatch':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/research-loop/dispatch', {
          root: requireString(args?.root, 'root'),
          projectId: requireString(args?.projectId, 'projectId'),
          runId: optionalString(args?.runId),
          task: requireString(args?.task, 'task'),
          domain: optionalString(args?.domain),
          botName: requireString(args?.botName, 'botName'),
          pmChatId: requireString(args?.pmChatId, 'pmChatId'),
          tokenBudget: optionalNumber(args?.tokenBudget),
          reviewRequired: args?.reviewRequired === true,
          model: optionalString(args?.model),
          engine: optionalString(args?.engine),
          reasoningEffort: optionalString(args?.reasoningEffort),
          approvalPolicy: optionalString(args?.approvalPolicy),
          sandbox: optionalString(args?.sandbox),
          timeoutMs: optionalNumber(args?.timeoutMs),
          idleTimeoutMs: optionalNumber(args?.idleTimeoutMs),
        }),
      );
    case 'memory_promotion_request':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/promotions/request', {
          root: requireString(args?.root, 'root'),
          targetEventId: requireString(args?.targetEventId, 'targetEventId'),
          targetVisibility: requireString(args?.targetVisibility, 'targetVisibility'),
          targetDomain: optionalString(args?.targetDomain),
          actor: actor(args, 'agent', 'memory-curator'),
          scope: scope(args, 'project'),
          reason: optionalString(args?.reason),
        }),
      );
    case 'memory_promotion_approve':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/promotions/approve', {
          root: requireString(args?.root, 'root'),
          requestEventId: requireString(args?.requestEventId, 'requestEventId'),
          actor: actor(args, 'user', 'mcp-user'),
          scope: scope(args, requireString(args?.visibility, 'visibility')),
          reason: optionalString(args?.reason),
        }),
      );
    case 'memory_promotion_reject':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/promotions/reject', {
          root: requireString(args?.root, 'root'),
          requestEventId: requireString(args?.requestEventId, 'requestEventId'),
          actor: actor(args, 'user', 'mcp-user'),
          scope: scope(args, optionalString(args?.visibility) ?? 'domain'),
          reason: optionalString(args?.reason),
        }),
      );
    case 'memory_supersede':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/supersede', {
          root: requireString(args?.root, 'root'),
          targetEventId: requireString(args?.targetEventId, 'targetEventId'),
          replacementEventId: optionalString(args?.replacementEventId),
          actor: actor(args, 'agent', 'memory-curator'),
          scope: scope(args, optionalString(args?.visibility) ?? 'project'),
          reason: optionalString(args?.reason),
        }),
      );
    case 'memory_redact':
      return apiToolResult(
        await apiRequest('POST', '/api/research-memory/redact', {
          root: requireString(args?.root, 'root'),
          targetEventId: requireString(args?.targetEventId, 'targetEventId'),
          actor: actor(args, 'user', 'mcp-user'),
          scope: scope(args, optionalString(args?.visibility) ?? 'project'),
          reason: optionalString(args?.reason),
        }),
      );
    default:
      return { content: [{ type: 'text', text: `Unknown research memory tool: ${name}` }] };
  }
}

function apiToolResult(response: { status: number; data: any }): ToolResult {
  if (response.status >= 400) {
    return { content: [{ type: 'text', text: `Error: ${response.data?.error || JSON.stringify(response.data)}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
}

function actor(args: any, defaultKind: string, defaultId: string): { kind: string; id: string } {
  return {
    kind: optionalString(args?.actorKind) ?? defaultKind,
    id: optionalString(args?.actorId) ?? defaultId,
  };
}

function scope(args: any, defaultVisibility: string): Record<string, string> {
  return compact({
    project_id: optionalString(args?.projectId),
    run_id: optionalString(args?.runId),
    domain: optionalString(args?.domain),
    visibility: optionalString(args?.visibility) ?? defaultVisibility,
  }) as Record<string, string>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeEventType(value: string): string {
  return value === 'fact' ? 'finding' : value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('number field must be finite');
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function addOptional(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) {
    params.set(key, value);
  }
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
