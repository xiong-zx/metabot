import type * as http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryCoreError,
  MemoryCoreService,
  AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
  ResearchLoopRunner,
  ResearchRunStore,
  WorkerManagerAutoResearchClawAdapter,
  type ContextPackPurpose,
  type ContextPackScopeFilter,
  type LogMemoryEventInput,
  type MemoryActor,
  type MemoryScope,
  type MemoryUnitKind,
  type MemoryVisibility,
} from '../../memory-core/index.js';
import type { EngineName } from '../../config.js';
import type { CodexApprovalPolicy, CodexSandbox, WorkerReasoningEffort } from '../../workers/worker-manager.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleResearchMemoryRoutes(
  _ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const parsedUrl = new URL(url, 'http://localhost');
  if (!isResearchMemoryRoute(parsedUrl.pathname)) return false;

  try {
    if (method === 'GET' && parsedUrl.pathname === '/api/research-memory/events') {
      const service = serviceFromUrl(parsedUrl);
      jsonResponse(res, 200, { events: service.readEvents() });
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/research-memory/runs') {
      const root = rootFromUrl(parsedUrl);
      const store = new ResearchRunStore(root);
      jsonResponse(res, 200, { runs: store.listRuns(optionalString(parsedUrl.searchParams.get('projectId'))) });
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/research-memory/artifacts') {
      const root = rootFromUrl(parsedUrl);
      const store = new ResearchRunStore(root);
      jsonResponse(res, 200, {
        artifacts: store.listArtifacts({
          projectId: optionalString(parsedUrl.searchParams.get('projectId')),
          runId: optionalString(parsedUrl.searchParams.get('runId')),
        }),
      });
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/events') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      const service = serviceFromBody(body);
      const event = service.logEvent(requireRecord(body.event, 'event') as unknown as LogMemoryEventInput);
      jsonResponse(res, 201, { event });
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/research-memory/units') {
      const service = serviceFromUrl(parsedUrl);
      jsonResponse(res, 200, { units: service.deriveUnits() });
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/research-memory/search') {
      const service = serviceFromUrl(parsedUrl);
      const results = await service.search({
        query: parsedUrl.searchParams.get('q') ?? '',
        limit: optionalNumber(parsedUrl.searchParams.get('limit')),
        kinds: parseCsv(parsedUrl.searchParams.get('kinds')) as MemoryUnitKind[] | undefined,
        includeCandidates: parsedUrl.searchParams.get('includeCandidates') === 'true',
        scopeFilter: {
          project_id: optionalString(parsedUrl.searchParams.get('projectId')),
          run_id: optionalString(parsedUrl.searchParams.get('runId')),
          agent_id: optionalString(parsedUrl.searchParams.get('agentId')),
          user_id: optionalString(parsedUrl.searchParams.get('userId')),
          domain: optionalString(parsedUrl.searchParams.get('domain')),
        },
      });
      jsonResponse(res, 200, { results });
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/context-pack') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      const service = serviceFromBody(body);
      const result = service.createContextPack({
        purpose: requireString(body.purpose, 'purpose') as ContextPackPurpose,
        query: requireString(body.query, 'query'),
        tokenBudget: requireNumber(body.tokenBudget, 'tokenBudget'),
        scopeFilter: optionalRecord(body.scopeFilter) as ContextPackScopeFilter | undefined,
        includeCandidates: body.includeCandidates === true,
        actor: optionalRecord(body.actor) as MemoryActor | undefined,
        scope: optionalRecord(body.scope) as MemoryScope | undefined,
      });
      jsonResponse(res, 201, result);
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/autoresearchclaw/ingest') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      const service = serviceFromBody(body);
      const events = service.ingestAutoResearchClawOutput({
        output: body.output,
        actor: requireRecord(body.actor, 'actor') as unknown as MemoryActor,
        scope: requireRecord(body.scope, 'scope') as unknown as MemoryScope,
        workerEventId: optionalString(body.workerEventId),
        timestamp: optionalString(body.timestamp),
        reviewRequired: body.reviewRequired === true,
      });
      jsonResponse(res, 201, { events });
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/research-loop/dispatch') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      if (_ctx.workerManager === undefined) {
        jsonResponse(res, 503, { error: 'Worker manager not initialized' });
        return true;
      }
      const root = rootFromBody(body);
      const runId = optionalString(body.runId) ?? `run_${randomUUID()}`;
      const projectId = requireString(body.projectId, 'projectId');
      const task = requireString(body.task, 'task');
      const domain = optionalString(body.domain);
      const tokenBudget = optionalBodyNumber(body.tokenBudget, 'tokenBudget');
      const reviewRequired = body.reviewRequired === true;
      const service = new MemoryCoreService({ rootDir: root });
      const runStore = new ResearchRunStore(root);
      const runner = new ResearchLoopRunner({
        readEvents: () => service.readEvents(),
        appendEvent: (event) => service.appendEvent(event),
        runStore,
        worker: new WorkerManagerAutoResearchClawAdapter({
          workerManager: _ctx.workerManager,
          botName: requireString(body.botName, 'botName'),
          pmChatId: requireString(body.pmChatId, 'pmChatId'),
          outputFileName: optionalString(body.outputFileName),
          model: optionalString(body.model),
          engine: optionalString(body.engine) as EngineName | undefined,
          reasoningEffort: optionalString(body.reasoningEffort) as WorkerReasoningEffort | undefined,
          approvalPolicy: optionalString(body.approvalPolicy) as CodexApprovalPolicy | undefined,
          sandbox: optionalString(body.sandbox) as CodexSandbox | undefined,
          timeoutMs: optionalBodyNumber(body.timeoutMs, 'timeoutMs'),
          idleTimeoutMs: optionalBodyNumber(body.idleTimeoutMs, 'idleTimeoutMs'),
          pollIntervalMs: optionalBodyNumber(body.pollIntervalMs, 'pollIntervalMs'),
          collectTimeoutMs: optionalBodyNumber(body.collectTimeoutMs, 'collectTimeoutMs'),
        }),
      });
      void runner
        .run({
          projectId,
          runId,
          projectRoot: root,
          task,
          domain,
          tokenBudget,
          actor:
            optionalRecord(body.actor) === undefined
              ? { kind: 'agent', id: 'autoresearchclaw-pm' }
              : (body.actor as MemoryActor),
          scope: optionalRecord(body.scope) as Partial<MemoryScope> | undefined,
          contextScopeFilter: optionalRecord(body.contextScopeFilter) as ContextPackScopeFilter | undefined,
          reviewRequired,
        })
        .catch((error) => {
          _ctx.logger.error({ err: error, runId, root }, 'Research loop dispatch failed');
          try {
            runStore.updateRun(runId, {
              status: 'failed',
              errorMessages: [errorMessage(error)],
              completedAt: new Date().toISOString(),
            });
          } catch {
            // Best effort: events remain the primary audit trail.
          }
        });
      jsonResponse(res, 202, {
        runId,
        projectId,
        projectRoot: root,
        status: 'dispatched',
        preflight: buildResearchLoopPreflight({
          projectId,
          runId,
          projectRoot: root,
          task,
          domain,
          tokenBudget,
          reviewRequired,
        }),
      });
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/evaluate') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      const service = serviceFromBody(body);
      const report = service.evaluate({
        contextPacks: Array.isArray(body.contextPacks) ? (body.contextPacks as any) : [],
        rawHistoryMarkdown: optionalString(body.rawHistoryMarkdown),
        rawHistoryTokenEstimate:
          body.rawHistoryTokenEstimate === undefined
            ? undefined
            : requireNumber(body.rawHistoryTokenEstimate, 'rawHistoryTokenEstimate'),
        expectedNegativeResultEventIds: Array.isArray(body.expectedNegativeResultEventIds)
          ? body.expectedNegativeResultEventIds.map(String)
          : undefined,
        thresholds: optionalRecord(body.thresholds) as any,
      });
      jsonResponse(res, 200, report);
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/promotions/request') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      const service = serviceFromBody(body);
      const event = service.requestPromotion({
        targetEventId: requireString(body.targetEventId, 'targetEventId'),
        targetVisibility: requireString(body.targetVisibility, 'targetVisibility') as MemoryVisibility,
        targetDomain: optionalString(body.targetDomain),
        actor: requireRecord(body.actor, 'actor') as unknown as MemoryActor,
        scope: requireRecord(body.scope, 'scope') as unknown as MemoryScope,
        reason: optionalString(body.reason),
      });
      jsonResponse(res, 201, { event });
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/promotions/approve') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      requireMemoryAdmin(req);
      const service = serviceFromBody(body);
      const result = service.approvePromotion({
        requestEventId: requireString(body.requestEventId, 'requestEventId'),
        actor: requireRecord(body.actor, 'actor') as unknown as MemoryActor,
        scope: requireRecord(body.scope, 'scope') as unknown as MemoryScope,
        reason: optionalString(body.reason),
      });
      jsonResponse(res, 201, result);
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/promotions/reject') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      requireMemoryAdmin(req);
      const service = serviceFromBody(body);
      const event = service.rejectPromotion({
        requestEventId: requireString(body.requestEventId, 'requestEventId'),
        actor: requireRecord(body.actor, 'actor') as unknown as MemoryActor,
        scope: requireRecord(body.scope, 'scope') as unknown as MemoryScope,
        reason: optionalString(body.reason),
      });
      jsonResponse(res, 201, { event });
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/supersede') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      requireMemoryAdmin(req);
      const service = serviceFromBody(body);
      const event = service.supersede({
        targetEventId: requireString(body.targetEventId, 'targetEventId'),
        replacementEventId: optionalString(body.replacementEventId),
        actor: requireRecord(body.actor, 'actor') as unknown as MemoryActor,
        scope: requireRecord(body.scope, 'scope') as unknown as MemoryScope,
        reason: optionalString(body.reason),
      });
      jsonResponse(res, 201, { event });
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/research-memory/redact') {
      const body = requireRecord(await parseJsonBody(req), 'body');
      requireMemoryAdmin(req);
      const service = serviceFromBody(body);
      const event = service.redact({
        targetEventId: requireString(body.targetEventId, 'targetEventId'),
        actor: requireRecord(body.actor, 'actor') as unknown as MemoryActor,
        scope: requireRecord(body.scope, 'scope') as unknown as MemoryScope,
        reason: optionalString(body.reason),
      });
      jsonResponse(res, 201, { event });
      return true;
    }

    jsonResponse(res, 404, { error: 'Unknown research-memory endpoint' });
    return true;
  } catch (error) {
    const status = errorStatus(error);
    jsonResponse(res, status, { error: errorMessage(error) });
    return true;
  }
}

function serviceFromUrl(url: URL): MemoryCoreService {
  return new MemoryCoreService({ rootDir: rootFromUrl(url) });
}

function serviceFromBody(body: Record<string, unknown>): MemoryCoreService {
  return new MemoryCoreService({ rootDir: rootFromBody(body) });
}

function rootFromUrl(url: URL): string {
  return resolveAllowedRoot(url.searchParams.get('root'));
}

function rootFromBody(body: Record<string, unknown>): string {
  return resolveAllowedRoot(body.root);
}

function isResearchMemoryRoute(pathname: string): boolean {
  return pathname === '/api/research-memory' || pathname.startsWith('/api/research-memory/');
}

function resolveAllowedRoot(value: unknown): string {
  const root = path.resolve(requireString(value, 'root'));
  if (!allowedMemoryRoots().some((allowedRoot) => isInsidePath(root, allowedRoot))) {
    throw Object.assign(new Error(`root is outside allowed memory roots: ${root}`), { statusCode: 403 });
  }
  return root;
}

function allowedMemoryRoots(): string[] {
  const configured = process.env.METABOT_MEMORY_ALLOWED_ROOTS;
  const roots =
    configured !== undefined && configured.trim().length > 0 ? configured.split(path.delimiter) : defaultMemoryRoots();
  return [...new Set(roots.map((root) => path.resolve(root)).filter((root) => root.length > 0))];
}

function defaultMemoryRoots(): string[] {
  if (process.env.METABOT_HOME !== undefined && process.env.METABOT_HOME.trim().length > 0) {
    return [process.env.METABOT_HOME];
  }
  const cwd = path.resolve(process.cwd());
  if (cwd === os.homedir() || cwd === path.parse(cwd).root) {
    return [];
  }
  return [cwd];
}

function isInsidePath(candidate: string, allowedRoot: string): boolean {
  const relative = path.relative(allowedRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireMemoryAdmin(req: http.IncomingMessage): void {
  const expected = process.env.METABOT_MEMORY_ADMIN_TOKEN;
  if (expected === undefined || expected.trim().length === 0) {
    throw Object.assign(new Error('memory admin API is disabled; set METABOT_MEMORY_ADMIN_TOKEN'), { statusCode: 403 });
  }

  const provided = headerString(req.headers['x-metabot-memory-admin-token']);
  if (provided === undefined || !timingSafeStringEqual(provided, expected)) {
    throw Object.assign(new Error('memory admin token required'), { statusCode: 403 });
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`${field} must be a non-empty string`), { statusCode: 400 });
  }
  return value.trim();
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Object.assign(new Error(`${field} must be a finite number`), { statusCode: 400 });
  }
  return value;
}

function optionalBodyNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNumber(value, field);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Object.assign(new Error(`${field} must be an object`), { statusCode: 400 });
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, 'record');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildResearchLoopPreflight(input: {
  projectId: string;
  runId: string;
  projectRoot: string;
  task: string;
  domain?: string;
  tokenBudget?: number;
  reviewRequired: boolean;
}): Record<string, unknown> {
  return {
    summary: 'AutoResearchClaw research loop accepted for asynchronous execution.',
    projectId: input.projectId,
    runId: input.runId,
    projectRoot: input.projectRoot,
    domain: input.domain,
    tokenBudget: input.tokenBudget,
    task: input.task,
    stages: [
      {
        phase: 'context_pack',
        status: 'planned',
        description: 'Build a token-budgeted Memory Core context pack before worker dispatch.',
      },
      {
        phase: 'worker_dispatch',
        status: 'planned',
        description: 'Dispatch an AutoResearchClaw worker through WorkerManager with the context pack injected.',
      },
      {
        phase: 'output_contract',
        status: 'required',
        description: `Worker must write ${AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION} JSON to the configured artifact file.`,
      },
      {
        phase: 'ingest_review',
        status: input.reviewRequired ? 'review_required' : 'direct_ingest',
        description: input.reviewRequired
          ? 'Validate the artifact and stage candidate memory for human review.'
          : 'Validate the artifact and ingest eligible project memory directly.',
      },
    ],
    outputContract: [
      'contract_version',
      'project_id',
      'run_id',
      'status',
      'summary',
      'hypotheses',
      'experiments',
      'findings',
      'negative_results',
      'decisions',
      'artifacts',
      'open_questions',
      'memory_event_candidates',
      'recommended_followups',
      'tool_trace',
      'metrics',
      'pivots',
    ],
    completionCriteria: [
      'run status is completed, partial, or failed in Memory Core run lifecycle records',
      'AutoResearchClaw artifact validates against the output contract',
      'ingest or review events are traceable by memory/event ids',
    ],
    nextAction: `Inspect lifecycle progress with memory_runs or metabot research runs --root ${input.projectRoot} --project ${input.projectId}`,
  };
}

function parseCsv(value: string | null): string[] | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorStatus(error: unknown): number {
  if (error instanceof MemoryCoreError) {
    switch (error.code) {
      case 'memory_event_not_found':
        return 404;
      case 'duplicate_event_id':
        return 409;
      case 'insufficient_memory_authority':
      case 'redaction_requires_admin_actor':
        return 403;
      default:
        return 400;
    }
  }
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
