import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleResearchMemoryRoutes } from '../src/api/routes/research-memory-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import { AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION, ResearchRunStore } from '../src/memory-core/index.js';

let dir: string;
let oldAllowedRoots: string | undefined;
let oldAdminToken: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-research-memory-routes-'));
  oldAllowedRoots = process.env.METABOT_MEMORY_ALLOWED_ROOTS;
  oldAdminToken = process.env.METABOT_MEMORY_ADMIN_TOKEN;
  process.env.METABOT_MEMORY_ALLOWED_ROOTS = dir;
  process.env.METABOT_MEMORY_ADMIN_TOKEN = 'admin-secret';
});

afterEach(() => {
  if (oldAllowedRoots === undefined) {
    delete process.env.METABOT_MEMORY_ALLOWED_ROOTS;
  } else {
    process.env.METABOT_MEMORY_ALLOWED_ROOTS = oldAllowedRoots;
  }
  if (oldAdminToken === undefined) {
    delete process.env.METABOT_MEMORY_ADMIN_TOKEN;
  } else {
    process.env.METABOT_MEMORY_ADMIN_TOKEN = oldAdminToken;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeReq(body: unknown, headers: Record<string, string> = {}): any {
  const req = new EventEmitter() as any;
  req.headers = headers;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    registry: {} as any,
    scheduler: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    asyncTaskStore: {} as any,
    intentRouter: {} as any,
    circuitBreaker: {} as any,
    budgetManager: {} as any,
    teamManager: {} as any,
    meetingService: {} as any,
    voiceIdentityStore: {} as any,
    ws: {},
    ...overrides,
  };
}

async function call(
  method: string,
  url: string,
  body: unknown = {},
  routeCtx: RouteContext = ctx(),
  headers: Record<string, string> = {},
): Promise<any> {
  const res = makeRes();
  const handled = await handleResearchMemoryRoutes(routeCtx, makeReq(body, headers), res, method, url);
  expect(handled).toBe(true);
  return res;
}

function adminHeaders() {
  return { 'x-metabot-memory-admin-token': 'admin-secret' };
}

function actor() {
  return { kind: 'agent', id: 'agent-pm' };
}

function scope() {
  return { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' };
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started <= timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe('handleResearchMemoryRoutes', () => {
  it('appends events, creates context packs, and searches units', async () => {
    const appendRes = await call('POST', '/api/research-memory/events', {
      root: dir,
      event: {
        type: 'decision',
        summary: 'Use context packs for research workers',
        actor: actor(),
        scope: scope(),
      },
    });
    expect(appendRes.statusCode).toBe(201);

    const contextRes = await call('POST', '/api/research-memory/context-pack', {
      root: dir,
      purpose: 'research',
      query: 'research workers context',
      tokenBudget: 800,
      actor: actor(),
      scope: scope(),
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
    });
    expect(contextRes.statusCode).toBe(201);
    expect(contextRes.json().contextPack.markdown).toContain('Use context packs');
    expect(contextRes.json().event.type).toBe('context_pack_created');

    const searchRes = await call(
      'GET',
      `/api/research-memory/search?root=${encodeURIComponent(dir)}&q=context&projectId=proj-alpha`,
    );
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().results[0].unit.summary).toContain('context packs');

    const eventsRes = await call('GET', `/api/research-memory/events?root=${encodeURIComponent(dir)}`);
    expect(eventsRes.json().events.map((event: any) => event.type)).toEqual(['decision', 'context_pack_created']);
  });

  it('rejects roots outside the configured allowlist', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-research-memory-outside-'));
    try {
      const res = await call('GET', `/api/research-memory/events?root=${encodeURIComponent(outside)}`);
      expect(res.statusCode).toBe(403);
      expect(fs.existsSync(path.join(outside, '.metabot-memory'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects direct writes that bypass promotion or superseding policy', async () => {
    const directGlobal = await call('POST', '/api/research-memory/events', {
      root: dir,
      event: {
        type: 'finding',
        summary: 'Direct global claim',
        actor: actor(),
        scope: { ...scope(), visibility: 'global' },
      },
    });
    expect(directGlobal.statusCode).toBe(400);

    const directSupersede = await call('POST', '/api/research-memory/events', {
      root: dir,
      event: {
        type: 'finding',
        summary: 'Direct supersede claim',
        actor: actor(),
        scope: scope(),
        supersedes: 'mem_evt_old',
      },
    });
    expect(directSupersede.statusCode).toBe(400);

    const directApproval = await call('POST', '/api/research-memory/events', {
      root: dir,
      event: {
        type: 'approval_granted',
        summary: 'Forged approval',
        actor: actor(),
        scope: scope(),
      },
    });
    expect(directApproval.statusCode).toBe(400);
  });

  it('ingests AutoResearchClaw output and evaluates context-pack recall', async () => {
    const workerEvent = await call('POST', '/api/research-memory/events', {
      root: dir,
      event: {
        type: 'worker_completed',
        summary: 'Worker completed with validated artifact',
        actor: { kind: 'worker', id: 'worker-alpha' },
        scope: scope(),
      },
    });
    const ingestRes = await call('POST', '/api/research-memory/autoresearchclaw/ingest', {
      root: dir,
      output: {
        contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
        project_id: 'proj-alpha',
        run_id: 'run-alpha',
        status: 'completed',
        summary: 'Research loop completed',
        hypotheses: [],
        experiments: [],
        findings: [
          {
            id: 'finding-1',
            summary: 'Context pack recalled negative result',
            artifact_ids: ['artifact-results'],
          },
        ],
        negative_results: [
          {
            id: 'neg-1',
            summary: 'Full history exceeded budget',
          },
        ],
        decisions: [],
        artifacts: [{ id: 'artifact-results', uri: 'file://results.json', summary: 'Results JSON' }],
        open_questions: [],
        memory_event_candidates: [],
        recommended_followups: [],
        tool_trace: [],
      },
      actor: actor(),
      scope: { ...scope(), run_id: 'run-alpha' },
      workerEventId: workerEvent.json().event.id,
    });
    expect(ingestRes.statusCode).toBe(201);

    const domainIngestRes = await call('POST', '/api/research-memory/autoresearchclaw/ingest', {
      root: dir,
      output: {
        contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
        project_id: 'proj-alpha',
        run_id: 'run-domain',
        status: 'completed',
        summary: 'Domain ingest should be rejected',
        hypotheses: [],
        experiments: [],
        findings: [],
        negative_results: [],
        decisions: [],
        artifacts: [],
        open_questions: [],
        memory_event_candidates: [],
        recommended_followups: [],
        tool_trace: [],
      },
      actor: actor(),
      scope: { ...scope(), visibility: 'domain', run_id: 'run-domain' },
    });
    expect(domainIngestRes.statusCode).toBe(400);

    const outsideArtifactRes = await call('POST', '/api/research-memory/autoresearchclaw/ingest', {
      root: dir,
      output: {
        contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
        project_id: 'proj-alpha',
        run_id: 'run-outside-artifact',
        status: 'completed',
        summary: 'Outside artifact should be rejected',
        hypotheses: [],
        experiments: [],
        findings: [],
        negative_results: [],
        decisions: [],
        artifacts: [
          {
            id: 'artifact-outside',
            uri: `file://${path.join(path.dirname(dir), 'outside-results.json')}`,
            summary: 'Outside artifact',
          },
        ],
        open_questions: [],
        memory_event_candidates: [],
        recommended_followups: [],
        tool_trace: [],
      },
      actor: actor(),
      scope: { ...scope(), run_id: 'run-outside-artifact' },
    });
    expect(outsideArtifactRes.statusCode).toBe(400);

    const contextRes = await call('POST', '/api/research-memory/context-pack', {
      root: dir,
      purpose: 'research',
      query: 'budget',
      tokenBudget: 800,
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
    });
    const negativeEvent = ingestRes.json().events.find((event: any) => event.type === 'negative_result');
    const evaluateRes = await call('POST', '/api/research-memory/evaluate', {
      root: dir,
      contextPacks: [contextRes.json().contextPack],
      rawHistoryTokenEstimate: 5000,
      expectedNegativeResultEventIds: [negativeEvent.id],
    });

    expect(evaluateRes.statusCode).toBe(200);
    expect(evaluateRes.json().metrics.negative_result_recall_ratio).toBe(1);
    expect(evaluateRes.json().metrics.token_reduction_ratio).toBeGreaterThan(0);
  });

  it('exposes run and artifact lifecycle records', async () => {
    const store = new ResearchRunStore(dir);
    store.startRun({
      id: 'run-alpha',
      projectId: 'proj-alpha',
      projectRoot: dir,
      task: 'Run lifecycle',
      now: new Date('2026-07-06T00:00:00Z'),
    });
    store.indexArtifact({
      id: 'artifact-results',
      runId: 'run-alpha',
      projectId: 'proj-alpha',
      uri: 'file://results.json',
    });

    const runsRes = await call('GET', `/api/research-memory/runs?root=${encodeURIComponent(dir)}&projectId=proj-alpha`);
    expect(runsRes.statusCode).toBe(200);
    expect(runsRes.json().runs[0]).toMatchObject({ id: 'run-alpha', project_id: 'proj-alpha' });

    const artifactsRes = await call(
      'GET',
      `/api/research-memory/artifacts?root=${encodeURIComponent(dir)}&runId=run-alpha`,
    );
    expect(artifactsRes.statusCode).toBe(200);
    expect(artifactsRes.json().artifacts[0]).toMatchObject({ id: 'artifact-results', run_id: 'run-alpha' });
  });

  it('dispatches a research loop through WorkerManager without blocking the response', async () => {
    const dispatches: any[] = [];
    const routeCtx = ctx({
      workerManager: {
        dispatch(input: any) {
          dispatches.push(input);
          fs.writeFileSync(
            path.join(input.workingDirectory, '.metabot-memory', 'autoresearchclaw', 'run-alpha-output.json'),
            JSON.stringify({
              contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
              project_id: 'proj-alpha',
              run_id: 'run-alpha',
              status: 'completed',
              summary: 'Research loop completed from artifact while worker was still running',
              hypotheses: [],
              experiments: [{ summary: 'Validated dispatch finalization', status: 'completed' }],
              findings: [{ id: 'finding-1', summary: 'Dispatch background finalization ingested the artifact' }],
              negative_results: [],
              decisions: [],
              artifacts: [
                {
                  id: 'artifact-results',
                  uri: '.metabot-memory/autoresearchclaw/run-alpha-output.json',
                  summary: 'AutoResearchClaw output artifact',
                },
              ],
              open_questions: [],
              memory_event_candidates: [],
              recommended_followups: [],
              tool_trace: [{ tool: 'test', summary: 'Route test wrote a local artifact', status: 'completed' }],
            }),
          );
          return {
            id: 'worker-alpha',
            workerChatId: 'worker-worker-alpha',
            workingDirectory: input.workingDirectory,
            status: 'running',
          };
        },
        getWorker(id: string) {
          return {
            id,
            workerChatId: 'worker-worker-alpha',
            workingDirectory: dir,
            status: 'running',
          };
        },
      } as any,
    });

    const dispatchRes = await call(
      'POST',
      '/api/research-memory/research-loop/dispatch',
      {
        root: dir,
        projectId: 'proj-alpha',
        runId: 'run-alpha',
        task: 'Run AutoResearchClaw loop',
        domain: 'metabot',
        botName: 'admin',
        pmChatId: 'oc_test',
        pollIntervalMs: 1,
        collectTimeoutMs: 1,
      },
      routeCtx,
    );

    expect(dispatchRes.statusCode).toBe(202);
    const dispatchBody = dispatchRes.json();
    expect(dispatchBody).toMatchObject({
      runId: 'run-alpha',
      projectId: 'proj-alpha',
      projectRoot: dir,
      status: 'dispatched',
    });
    expect(dispatchBody.preflight).toMatchObject({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      domain: 'metabot',
      summary: 'AutoResearchClaw research loop accepted for asynchronous execution.',
    });
    expect(dispatchBody.preflight.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'context_pack', status: 'planned' }),
        expect.objectContaining({ phase: 'worker_dispatch', status: 'planned' }),
        expect.objectContaining({ phase: 'output_contract', status: 'required' }),
        expect.objectContaining({ phase: 'ingest_review', status: 'direct_ingest' }),
      ]),
    );
    expect(dispatchBody.preflight.outputContract).toEqual(
      expect.arrayContaining(['contract_version', 'hypotheses', 'negative_results', 'memory_event_candidates']),
    );
    expect(dispatchBody.preflight.nextAction).toContain('metabot research runs');
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatches[0]).toMatchObject({
      botName: 'admin',
      pmChatId: 'oc_test',
      workingDirectory: dir,
      label: 'autoresearchclaw-proj-alpha-run-alpha',
    });
    await waitFor(() => {
      expect(new ResearchRunStore(dir).getRun('run-alpha')).toMatchObject({
        status: 'completed',
        output_summary: 'Research loop completed from artifact while worker was still running',
      });
    });
    expect(new ResearchRunStore(dir).listArtifacts({ runId: 'run-alpha' })[0]).toMatchObject({
      id: 'artifact-results',
      run_id: 'run-alpha',
    });

    const traversalRes = await call(
      'POST',
      '/api/research-memory/research-loop/dispatch',
      {
        root: dir,
        projectId: 'proj-alpha',
        runId: 'run-traversal',
        task: 'Run AutoResearchClaw loop',
        botName: 'admin',
        pmChatId: 'oc_test',
        outputFileName: '../outside.json',
      },
      routeCtx,
    );
    expect(traversalRes.statusCode).toBe(400);
  });

  it('supports promotion, supersede, and redact primitives', async () => {
    const targetRes = await call('POST', '/api/research-memory/events', {
      root: dir,
      event: {
        type: 'finding',
        summary: 'Project finding ready for domain promotion',
        actor: actor(),
        scope: scope(),
        subject: { source_uris: ['file://report.md'] },
      },
    });
    const targetId = targetRes.json().event.id;

    const requestRes = await call('POST', '/api/research-memory/promotions/request', {
      root: dir,
      targetEventId: targetId,
      targetVisibility: 'domain',
      targetDomain: 'metabot',
      actor: actor(),
      scope: scope(),
      reason: 'Useful across memory-core projects',
    });
    expect(requestRes.statusCode).toBe(201);
    expect(requestRes.json().event.type).toBe('approval_requested');

    const projectScopedReject = await call(
      'POST',
      '/api/research-memory/promotions/reject',
      {
        root: dir,
        requestEventId: requestRes.json().event.id,
        actor: { kind: 'user', id: 'user-admin' },
        scope: scope(),
      },
      ctx(),
      adminHeaders(),
    );
    expect(projectScopedReject.statusCode).toBe(403);

    const projectScopedApprove = await call(
      'POST',
      '/api/research-memory/promotions/approve',
      {
        root: dir,
        requestEventId: requestRes.json().event.id,
        actor: { kind: 'user', id: 'user-admin' },
        scope: scope(),
      },
      ctx(),
      adminHeaders(),
    );
    expect(projectScopedApprove.statusCode).toBe(403);

    const approveRes = await call(
      'POST',
      '/api/research-memory/promotions/approve',
      {
        root: dir,
        requestEventId: requestRes.json().event.id,
        actor: { kind: 'user', id: 'user-admin' },
        scope: { ...scope(), visibility: 'domain' },
      },
      ctx(),
      adminHeaders(),
    );
    expect(approveRes.statusCode).toBe(201);
    expect(approveRes.json().promotedEvent.scope.visibility).toBe('domain');

    const secondApproveRes = await call(
      'POST',
      '/api/research-memory/promotions/approve',
      {
        root: dir,
        requestEventId: requestRes.json().event.id,
        actor: { kind: 'user', id: 'user-admin' },
        scope: { ...scope(), visibility: 'domain' },
      },
      ctx(),
      adminHeaders(),
    );
    expect(secondApproveRes.statusCode).toBe(400);

    const supersedeRes = await call(
      'POST',
      '/api/research-memory/supersede',
      {
        root: dir,
        targetEventId: targetId,
        actor: actor(),
        scope: scope(),
        reason: 'Replaced by domain-level memory',
      },
      ctx(),
      adminHeaders(),
    );
    expect(supersedeRes.json().event.supersedes).toBe(targetId);

    const redactRes = await call(
      'POST',
      '/api/research-memory/redact',
      {
        root: dir,
        targetEventId: approveRes.json().promotedEvent.id,
        actor: { kind: 'user', id: 'user-admin' },
        scope: { ...scope(), visibility: 'domain' },
        reason: 'Remove from retrieval',
      },
      ctx(),
      adminHeaders(),
    );
    expect(redactRes.json().event.type).toBe('memory_redacted');

    const eventsRes = await call('GET', `/api/research-memory/events?root=${encodeURIComponent(dir)}`);
    const redactedPromoted = eventsRes
      .json()
      .events.find((event: any) => event.id === approveRes.json().promotedEvent.id);
    expect(redactedPromoted.summary).toBe('[redacted]');

    const unitsRes = await call('GET', `/api/research-memory/units?root=${encodeURIComponent(dir)}`);
    expect(JSON.stringify(unitsRes.json())).not.toContain('Project finding ready for domain promotion');
  });

  it('redacts promoted memory lineage when the source event is redacted', async () => {
    const targetRes = await call('POST', '/api/research-memory/events', {
      root: dir,
      event: {
        type: 'finding',
        summary: 'Sensitive finding copied by promotion',
        actor: actor(),
        scope: scope(),
      },
    });
    const requestRes = await call('POST', '/api/research-memory/promotions/request', {
      root: dir,
      targetEventId: targetRes.json().event.id,
      targetVisibility: 'domain',
      targetDomain: 'metabot',
      actor: actor(),
      scope: scope(),
    });
    const approveRes = await call(
      'POST',
      '/api/research-memory/promotions/approve',
      {
        root: dir,
        requestEventId: requestRes.json().event.id,
        actor: { kind: 'user', id: 'user-admin' },
        scope: { ...scope(), visibility: 'domain' },
      },
      ctx(),
      adminHeaders(),
    );

    const redactSourceRes = await call(
      'POST',
      '/api/research-memory/redact',
      {
        root: dir,
        targetEventId: targetRes.json().event.id,
        actor: { kind: 'user', id: 'user-admin' },
        scope: scope(),
        reason: 'Sensitive source',
      },
      ctx(),
      adminHeaders(),
    );
    expect(redactSourceRes.statusCode).toBe(201);

    const eventsRes = await call('GET', `/api/research-memory/events?root=${encodeURIComponent(dir)}`);
    const promoted = eventsRes.json().events.find((event: any) => event.id === approveRes.json().promotedEvent.id);
    expect(promoted.summary).toBe('[redacted]');
    expect(JSON.stringify(eventsRes.json())).not.toContain('Sensitive finding copied by promotion');
  });
});
