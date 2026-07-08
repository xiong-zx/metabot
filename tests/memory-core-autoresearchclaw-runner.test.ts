import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
  AUTORESEARCHCLAW_REVIEW_CONTRACT_VERSION,
  MemoryEventLedger,
  ResearchLoopRunner,
  deriveMemoryUnits,
  type AutoResearchClawOutput,
  type AutoResearchClawReviewOutput,
  type AutoResearchClawWorkerAdapter,
  type ResearchWorkerDispatchInput,
  type ResearchWorkerHandle,
  type SemanticMemoryProvider,
} from '../src/memory-core/index.js';

let dir: string;
let ledger: MemoryEventLedger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-arc-runner-'));
  ledger = new MemoryEventLedger(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function output(overrides: Partial<AutoResearchClawOutput> = {}): AutoResearchClawOutput {
  return {
    contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
    project_id: 'proj-alpha',
    run_id: 'run-alpha',
    status: 'completed',
    summary: 'Validated compact retrieval research loop',
    hypotheses: [{ id: 'hyp-1', summary: 'Context packs reduce repeated analysis', confidence: 0.6 }],
    experiments: [
      {
        id: 'exp-1',
        summary: 'Compared full history against context pack',
        outcome: 'worked',
        artifact_ids: ['artifact-results'],
      },
    ],
    findings: [
      {
        id: 'finding-1',
        summary: 'Context pack preserved the previous negative result',
        confidence: 0.9,
        artifact_ids: ['artifact-results'],
      },
    ],
    negative_results: [
      {
        id: 'neg-1',
        summary: 'Full chat history injection exceeded the token budget',
        reason: 'Prompt exceeded target budget.',
        confidence: 0.8,
      },
    ],
    decisions: [{ id: 'decision-1', summary: 'Keep research worker memory writes behind curator validation' }],
    artifacts: [{ id: 'artifact-results', uri: 'file://results.json', summary: 'Research results JSON' }],
    open_questions: [{ id: 'oq-1', summary: 'When should a finding promote to domain memory?' }],
    memory_event_candidates: [
      {
        type: 'note',
        summary: 'Candidate shared lesson from research loop',
        status: 'approved',
        confidence: 1,
      },
    ],
    recommended_followups: [{ summary: 'Run on a second project', priority: 'medium' }],
    tool_trace: [{ tool: 'vitest', summary: 'Focused tests passed', status: 'completed' }],
    metrics: [{ id: 'metric-1', summary: 'Context pack tokens were lower than raw history', value: 1200 }],
    ...overrides,
  };
}

function review(): AutoResearchClawReviewOutput {
  return {
    contract_version: AUTORESEARCHCLAW_REVIEW_CONTRACT_VERSION,
    project_id: 'proj-alpha',
    run_id: 'run-alpha',
    decision: 'changes_requested',
    summary: 'Finding is useful but promotion needs another project',
    issues: [{ id: 'review-issue-1', summary: 'Do not promote to domain memory yet' }],
    recommended_followups: [{ summary: 'Collect independent evidence', priority: 'high' }],
  };
}

describe('ResearchLoopRunner', () => {
  it('runs context pack -> worker artifact -> curator events -> semantic/meta hooks', async () => {
    const priorNegative = ledger.append({
      type: 'negative_result',
      summary: 'Embedding-only retrieval missed local constraints',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      evidence_event_ids: ['evt_external_report'],
    });
    const dispatches: ResearchWorkerDispatchInput[] = [];
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(input) {
        dispatches.push(input);
        return {
          workerId: 'worker-alpha',
          workerChatId: 'worker-worker-alpha',
          artifactUri: 'file://autoresearchclaw-output.json',
        };
      },
      async collectOutput() {
        return output();
      },
    };
    const semanticProvider = {
      rebuildFromEvents: vi.fn(async () => []),
      search: vi.fn(),
      deleteIndexOnly: vi.fn(),
      clear: vi.fn(),
    } satisfies SemanticMemoryProvider;
    const publishRunSummary = vi.fn(async () => undefined);
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      semanticProvider,
      publishRunSummary,
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Test token-efficient research loop',
      domain: 'metabot',
      tokenBudget: 900,
      actor: { kind: 'agent', id: 'agent-pm' },
      now: new Date('2026-07-06T00:00:00Z'),
    });
    const events = ledger.readAll();
    const units = deriveMemoryUnits(events, { includeRejected: true });

    expect(result.status).toBe('completed');
    expect(dispatches[0].prompt).toContain(AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION);
    expect(dispatches[0].contextPack.included_event_ids).toContain(priorNegative.id);
    expect(events.some((event) => event.type === 'research_run_started')).toBe(true);
    expect(events.some((event) => event.type === 'context_pack_created')).toBe(true);
    expect(events.some((event) => event.type === 'worker_dispatched')).toBe(true);
    expect(events.some((event) => event.type === 'worker_completed')).toBe(true);
    expect(events.some((event) => event.type === 'finding')).toBe(true);
    expect(
      events.some((event) => event.type === 'negative_result' && event.summary.includes('Full chat history')),
    ).toBe(true);
    expect(events.some((event) => event.type === 'artifact_created')).toBe(true);
    expect(events.find((event) => event.summary === 'Candidate shared lesson from research loop')?.status).toBe(
      'candidate',
    );
    expect(units.some((unit) => unit.kind === 'negative_result')).toBe(true);
    expect(semanticProvider.rebuildFromEvents).toHaveBeenCalled();
    expect(publishRunSummary).toHaveBeenCalled();
  });

  it('rejects invalid artifacts without ingesting research findings', async () => {
    const semanticProvider = {
      rebuildFromEvents: vi.fn(async (events) => deriveMemoryUnits(events)),
      search: vi.fn(),
      deleteIndexOnly: vi.fn(),
      clear: vi.fn(),
    } satisfies SemanticMemoryProvider;
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-bad' };
      },
      async collectOutput() {
        return { contract_version: 'wrong', project_id: 'proj-alpha', run_id: 'run-alpha' };
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      semanticProvider,
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with invalid artifact',
      actor: { kind: 'agent', id: 'agent-pm' },
    });
    const events = ledger.readAll();

    expect(result.status).toBe('failed');
    expect(events.some((event) => event.type === 'worker_failed' && event.metadata?.invalid_artifact === true)).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'finding')).toBe(false);
    expect(events.some((event) => event.type === 'decision')).toBe(false);
    expect(deriveMemoryUnits(events).filter((unit) => unit.state === 'active')).toHaveLength(0);
    expect(semanticProvider.rebuildFromEvents).toHaveBeenCalled();
  });

  it('records independent reviewer conclusions as candidate memory', async () => {
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-alpha' };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      reviewer: {
        async dispatchReview() {
          return { workerId: 'reviewer-alpha', workerChatId: 'worker-reviewer-alpha' };
        },
        async collectReview() {
          return review();
        },
      },
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with reviewer',
      actor: { kind: 'agent', id: 'agent-pm' },
      reviewRequired: true,
    });
    const reviewEvent = ledger.readAll().find((event) => event.metadata?.autoresearchclaw_review === true);

    expect(result.status).toBe('partial');
    expect(result.review?.decision).toBe('changes_requested');
    expect(reviewEvent?.type).toBe('note');
    expect(reviewEvent?.status).toBe('candidate');
    expect(reviewEvent?.summary).toContain('changes_requested');
    expect(ledger.readAll().filter((event) => event.type === 'worker_dispatched')).toHaveLength(2);
    expect(
      deriveMemoryUnits(ledger.readAll()).find((unit) => unit.summary.includes('Context pack preserved'))?.state,
    ).toBe('candidate');
  });

  it('applies reviewer approvals and rejections through append-only replacement events', async () => {
    let approvedEventId = '';
    let rejectedEventId = '';
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-alpha' };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      reviewer: {
        async dispatchReview(input) {
          approvedEventId =
            input.memoryEvents.find((event) => event.type === 'finding' && event.summary.includes('preserved'))?.id ??
            '';
          rejectedEventId =
            input.memoryEvents.find((event) => event.type === 'decision' && event.summary.includes('curator'))?.id ??
            '';
          return { workerId: 'reviewer-alpha' };
        },
        async collectReview() {
          return {
            ...review(),
            decision: 'changes_requested',
            approved_event_ids: [approvedEventId],
            rejected_event_ids: [rejectedEventId],
          } satisfies AutoResearchClawReviewOutput;
        },
      },
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with selective reviewer approval',
      actor: { kind: 'agent', id: 'agent-pm' },
      reviewRequired: true,
    });
    const units = deriveMemoryUnits(ledger.readAll(), { includeRejected: true });
    const approvedOriginal = units.find((unit) => unit.source_event_ids.includes(approvedEventId));
    const approvedReplacement = units.find(
      (unit) => unit.supersedes === approvedEventId && unit.summary.includes('Context pack preserved'),
    );
    const rejectedOriginal = units.find((unit) => unit.source_event_ids.includes(rejectedEventId));

    expect(result.status).toBe('partial');
    expect(approvedOriginal?.state).toBe('superseded');
    expect(approvedReplacement?.state).toBe('active');
    expect(rejectedOriginal?.state).toBe('superseded');
    expect(
      ledger.readAll().some((event) => event.type === 'memory_superseded' && event.supersedes === rejectedEventId),
    ).toBe(true);
  });

  it('keeps reviewer failures controlled and leaves staged output out of active memory', async () => {
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-alpha' };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      reviewer: {
        async dispatchReview() {
          return { workerId: 'reviewer-bad' };
        },
        async collectReview() {
          return { contract_version: 'bad' };
        },
      },
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with invalid reviewer',
      actor: { kind: 'agent', id: 'agent-pm' },
      reviewRequired: true,
    });
    const events = ledger.readAll();

    expect(result.status).toBe('partial');
    expect(result.errors.some((error) => error.includes('Invalid reviewer artifact'))).toBe(true);
    expect(events.some((event) => event.type === 'worker_failed' && event.metadata?.reviewer === true)).toBe(true);
    expect(deriveMemoryUnits(events).filter((unit) => unit.state === 'active')).toHaveLength(0);
  });

  it('rejects contradictory review decisions without activating staged output', async () => {
    let stagedFindingId = '';
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-alpha' };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      reviewer: {
        async dispatchReview(input) {
          stagedFindingId =
            input.memoryEvents.find((event) => event.type === 'finding' && event.summary.includes('preserved'))?.id ??
            '';
          return { workerId: 'reviewer-conflict' };
        },
        async collectReview() {
          return {
            ...review(),
            decision: 'approved',
            rejected_event_ids: [stagedFindingId],
          } satisfies AutoResearchClawReviewOutput;
        },
      },
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with contradictory reviewer',
      actor: { kind: 'agent', id: 'agent-pm' },
      reviewRequired: true,
    });

    expect(result.status).toBe('partial');
    expect(result.errors.some((error) => error.includes('invalid_review_decision'))).toBe(true);
    expect(deriveMemoryUnits(ledger.readAll()).filter((unit) => unit.state === 'active')).toHaveLength(0);
  });

  it('rejects rejected review decisions that try to approve staged memory', async () => {
    let stagedFindingId = '';
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-alpha' };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      reviewer: {
        async dispatchReview(input) {
          stagedFindingId =
            input.memoryEvents.find((event) => event.type === 'finding' && event.summary.includes('preserved'))?.id ??
            '';
          return { workerId: 'reviewer-rejected-conflict' };
        },
        async collectReview() {
          return {
            ...review(),
            decision: 'rejected',
            approved_event_ids: [stagedFindingId],
          } satisfies AutoResearchClawReviewOutput;
        },
      },
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with rejected reviewer conflict',
      actor: { kind: 'agent', id: 'agent-pm' },
      reviewRequired: true,
    });

    expect(result.status).toBe('partial');
    expect(result.errors.some((error) => error.includes('invalid_review_decision'))).toBe(true);
    expect(deriveMemoryUnits(ledger.readAll()).filter((unit) => unit.state === 'active')).toHaveLength(0);
  });

  it('does not let reviewers supersede memory outside the staged run output', async () => {
    const priorDecision = ledger.append({
      type: 'decision',
      summary: 'Prior active project decision',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
    });
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-alpha' };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      reviewer: {
        async dispatchReview() {
          return { workerId: 'reviewer-out-of-scope' };
        },
        async collectReview() {
          return {
            ...review(),
            decision: 'changes_requested',
            rejected_event_ids: [priorDecision.id],
          } satisfies AutoResearchClawReviewOutput;
        },
      },
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with out-of-scope reviewer target',
      actor: { kind: 'agent', id: 'agent-pm' },
      reviewRequired: true,
    });
    const units = deriveMemoryUnits(ledger.readAll());

    expect(result.status).toBe('partial');
    expect(result.errors.some((error) => error.includes('Reviewer can only target staged events'))).toBe(true);
    expect(units.find((unit) => unit.source_event_ids.includes(priorDecision.id))?.state).toBe('active');
    expect(
      ledger.readAll().some((event) => event.type === 'memory_superseded' && event.supersedes === priorDecision.id),
    ).toBe(false);
  });

  it('treats duplicate generated memory event ids as an invalid artifact', async () => {
    const duplicateOutput = output({
      findings: [
        { id: 'same', summary: 'Duplicate finding', body: 'same body' },
        { id: 'same', summary: 'Duplicate finding', body: 'same body' },
      ],
    });
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-duplicate' };
      },
      async collectOutput() {
        return duplicateOutput;
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with duplicate event ids',
      actor: { kind: 'agent', id: 'agent-pm' },
    });

    expect(result.status).toBe('failed');
    expect(result.errors.some((error) => error.includes('duplicate_autoresearchclaw_event_id'))).toBe(true);
    expect(ledger.readAll().filter((event) => event.type === 'finding')).toHaveLength(0);
  });

  it('rejects AutoResearchClaw candidates that try to emit controlled supersede events', async () => {
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-controlled-candidate' };
      },
      async collectOutput() {
        return output({
          findings: [],
          memory_event_candidates: [
            {
              type: 'memory_superseded',
              summary: 'Candidate tries to supersede directly',
              supersedes: 'mem_evt_target',
            },
          ],
        });
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run with controlled candidate',
      actor: { kind: 'agent', id: 'agent-pm' },
    });

    expect(result.status).toBe('failed');
    expect(result.errors.some((error) => error.includes('autoresearchclaw_candidate_type_not_allowed'))).toBe(true);
    expect(ledger.readAll().some((event) => event.type === 'memory_superseded')).toBe(false);
  });
});
