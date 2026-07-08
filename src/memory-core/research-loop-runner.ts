import { createHash, randomUUID } from 'node:crypto';
import { MemoryCoreError } from './event-ledger.js';
import { buildContextPack } from './context-pack-builder.js';
import {
  autoResearchClawOutputToMemoryEvents,
  autoResearchClawReviewToMemoryEvents,
  buildAutoResearchClawPrompt,
  normalizeAutoResearchClawReviewOutput,
  validateAutoResearchClawOutput,
  type AutoResearchClawOutput,
  type AutoResearchClawReviewOutput,
} from './autoresearchclaw-contract.js';
import type { SemanticMemoryProvider } from './semantic-provider.js';
import type { ResearchRunStoreLike } from './research-run-store.js';
import type {
  AppendMemoryEventInput,
  ContextPack,
  ContextPackScopeFilter,
  MemoryActor,
  MemoryEvent,
  MemoryScope,
} from './types.js';

export interface ResearchWorkerDispatchInput {
  projectId: string;
  runId: string;
  projectRoot: string;
  task: string;
  prompt: string;
  contextPack: ContextPack;
}

export interface ResearchWorkerHandle {
  workerId: string;
  workerChatId?: string;
  artifactUri?: string;
  metadata?: Record<string, unknown>;
}

export interface AutoResearchClawWorkerAdapter {
  dispatch(input: ResearchWorkerDispatchInput): Promise<ResearchWorkerHandle>;
  collectOutput(handle: ResearchWorkerHandle): Promise<unknown>;
}

export interface ResearchReviewInput {
  projectId: string;
  runId: string;
  projectRoot: string;
  output: AutoResearchClawOutput;
  memoryEvents: MemoryEvent[];
}

export interface ResearchReviewHandle {
  workerId: string;
  workerChatId?: string;
  metadata?: Record<string, unknown>;
}

export interface AutoResearchClawReviewerAdapter {
  dispatchReview(input: ResearchReviewInput): Promise<ResearchReviewHandle>;
  collectReview(handle: ResearchReviewHandle): Promise<unknown>;
}

export interface RunAutoResearchLoopInput {
  projectId: string;
  runId?: string;
  projectRoot: string;
  task: string;
  domain?: string;
  tokenBudget?: number;
  actor: MemoryActor;
  scope?: Partial<MemoryScope>;
  contextScopeFilter?: ContextPackScopeFilter;
  reviewRequired?: boolean;
  now?: Date;
}

export interface ResearchLoopRunnerOptions {
  readEvents: () => MemoryEvent[] | Promise<MemoryEvent[]>;
  appendEvent: (event: AppendMemoryEventInput) => MemoryEvent | Promise<MemoryEvent>;
  worker: AutoResearchClawWorkerAdapter;
  reviewer?: AutoResearchClawReviewerAdapter;
  semanticProvider?: SemanticMemoryProvider;
  runStore?: ResearchRunStoreLike;
  publishRunSummary?: (input: {
    projectId: string;
    runId: string;
    events: MemoryEvent[];
    contextPack: ContextPack;
  }) => Promise<unknown>;
}

export interface ResearchLoopRunResult {
  projectId: string;
  runId: string;
  status: 'completed' | 'partial' | 'failed';
  contextPack: ContextPack;
  output?: AutoResearchClawOutput;
  review?: AutoResearchClawReviewOutput;
  appendedEvents: MemoryEvent[];
  errors: string[];
}

export class ResearchLoopRunner {
  constructor(private readonly options: ResearchLoopRunnerOptions) {}

  async run(input: RunAutoResearchLoopInput): Promise<ResearchLoopRunResult> {
    const runId = input.runId ?? `run_${randomUUID()}`;
    const scope = createRunScope(input, runId);
    const appendedEvents: MemoryEvent[] = [];
    const errors: string[] = [];
    let events = await this.options.readEvents();

    const append = async (event: AppendMemoryEventInput): Promise<MemoryEvent> => {
      const existing = [...events, ...appendedEvents].find((candidate) => candidate.id === event.id);
      if (existing !== undefined) {
        if (hasAppendConflict(existing, event)) {
          throw new MemoryCoreError(
            'duplicate_event_id_conflict',
            `Memory event id already exists with different content: ${event.id}`,
          );
        }
        return existing;
      }
      const appended = await this.options.appendEvent(event);
      appendedEvents.push(appended);
      events = [...events, appended];
      return appended;
    };

    const runStarted = await append({
      id: stableRunnerEventId('research_run_started', input.projectId, runId),
      type: 'research_run_started',
      summary: `Research run started: ${input.task}`,
      timestamp: input.now?.toISOString(),
      actor: input.actor,
      scope,
      metadata: {
        project_root: input.projectRoot,
      },
    });
    this.startRunStore({
      id: runId,
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      task: input.task,
      domain: input.domain,
      now: input.now,
    });

    const contextPack = buildContextPack({
      purpose: 'research',
      query: input.task,
      tokenBudget: input.tokenBudget ?? 4000,
      events,
      scopeFilter: input.contextScopeFilter ?? {
        project_id: input.projectId,
        run_id: runId,
        domain: input.domain,
      },
      now: input.now,
    });

    await append({
      id: stableRunnerEventId('context_pack_created', runId, contextPack.id),
      type: 'context_pack_created',
      summary: `Context pack created for research run: ${input.task}`,
      timestamp: input.now?.toISOString(),
      actor: input.actor,
      scope,
      evidence_event_ids: contextPack.included_event_ids,
      metadata: {
        context_pack_id: contextPack.id,
        token_budget: contextPack.token_budget,
        included_memory_unit_ids: contextPack.included_memory_unit_ids,
      },
    });
    this.updateRunStore(runId, {
      status: 'context_ready',
      contextPackId: contextPack.id,
      now: input.now,
    });

    const prompt = buildAutoResearchClawPrompt({
      project_id: input.projectId,
      run_id: runId,
      task: input.task,
      project_root: input.projectRoot,
      context_pack_markdown: contextPack.markdown,
      token_budget: contextPack.token_budget,
    });

    let handle: ResearchWorkerHandle;
    try {
      handle = await this.options.worker.dispatch({
        projectId: input.projectId,
        runId,
        projectRoot: input.projectRoot,
        task: input.task,
        prompt,
        contextPack,
      });
    } catch (error) {
      const failure = await append(
        createWorkerFailureEvent(input, runId, scope, `Worker dispatch failed: ${errorMessage(error)}`),
      );
      errors.push(failure.summary);
      this.failRunStore(runId, errors, input.now);
      await this.rebuildAndPublish(input.projectId, runId, events, contextPack, errors);
      return { projectId: input.projectId, runId, status: 'failed', contextPack, appendedEvents, errors };
    }

    await append({
      id: stableRunnerEventId('worker_dispatched', runId, handle.workerId),
      type: 'worker_dispatched',
      summary: `AutoResearchClaw worker dispatched for run ${runId}`,
      timestamp: input.now?.toISOString(),
      actor: input.actor,
      scope: { ...scope, worker_id: handle.workerId },
      evidence_event_ids: [runStarted.id, ...contextPack.included_event_ids],
      metadata: {
        worker_id: handle.workerId,
        worker_chat_id: handle.workerChatId,
        artifact_uri: handle.artifactUri,
        ...handle.metadata,
      },
    });
    this.updateRunStore(runId, {
      status: 'worker_dispatched',
      workerId: handle.workerId,
      workerChatId: handle.workerChatId,
      artifactUri: handle.artifactUri,
      now: input.now,
    });

    let rawOutput: unknown;
    try {
      rawOutput = await this.options.worker.collectOutput(handle);
    } catch (error) {
      const failure = await append(
        createWorkerFailureEvent(
          input,
          runId,
          { ...scope, worker_id: handle.workerId },
          `Worker output collection failed: ${errorMessage(error)}`,
        ),
      );
      errors.push(failure.summary);
      this.failRunStore(runId, errors, input.now);
      await this.rebuildAndPublish(input.projectId, runId, events, contextPack, errors);
      return { projectId: input.projectId, runId, status: 'failed', contextPack, appendedEvents, errors };
    }

    let output: AutoResearchClawOutput;
    try {
      output = validateAutoResearchClawOutput(rawOutput, {
        expectedProjectId: input.projectId,
        expectedRunId: runId,
        projectRoot: input.projectRoot,
      });
    } catch (error) {
      const failure = await append(
        createWorkerFailureEvent(
          input,
          runId,
          { ...scope, worker_id: handle.workerId },
          `Invalid AutoResearchClaw artifact: ${errorMessage(error)}`,
          {
            invalid_artifact: true,
          },
        ),
      );
      errors.push(failure.summary);
      this.failRunStore(runId, errors, input.now);
      await this.rebuildAndPublish(input.projectId, runId, events, contextPack, errors);
      return { projectId: input.projectId, runId, status: 'failed', contextPack, appendedEvents, errors };
    }

    const workerTerminalEvent = await append({
      id: stableRunnerEventId(`worker_${output.status}`, runId, handle.workerId, outputHash(output)),
      type: output.status === 'failed' ? 'worker_failed' : 'worker_completed',
      summary: `AutoResearchClaw worker ${output.status}: ${output.summary}`,
      timestamp: input.now?.toISOString(),
      actor: input.actor,
      scope: { ...scope, worker_id: handle.workerId },
      outcome: output.status === 'completed' ? 'worked' : output.status === 'partial' ? 'partial' : 'failed',
      evidence_event_ids: [runStarted.id],
      status: input.reviewRequired === true ? 'candidate' : undefined,
      metadata: {
        worker_id: handle.workerId,
        worker_chat_id: handle.workerChatId,
        artifact_uri: handle.artifactUri,
        autoresearchclaw_status: output.status,
        autoresearchclaw_output_hash: outputHash(output),
      },
    });

    let outputEvents: AppendMemoryEventInput[];
    try {
      outputEvents = autoResearchClawOutputToMemoryEvents(output, {
        actor: input.actor,
        scope,
        workerEventId: workerTerminalEvent.id,
        timestamp: input.now?.toISOString(),
        defaultStatus: input.reviewRequired === true ? 'candidate' : undefined,
        stagedForReview: input.reviewRequired === true,
        projectRoot: input.projectRoot,
      });
    } catch (error) {
      const failure = await append(
        createWorkerFailureEvent(
          input,
          runId,
          { ...scope, worker_id: handle.workerId },
          `Invalid AutoResearchClaw memory events: ${errorMessage(error)}`,
          {
            invalid_artifact: true,
          },
        ),
      );
      errors.push(failure.summary);
      this.failRunStore(runId, errors, input.now);
      await this.rebuildAndPublish(input.projectId, runId, events, contextPack, errors);
      return { projectId: input.projectId, runId, status: 'failed', contextPack, output, appendedEvents, errors };
    }

    try {
      for (const event of outputEvents) {
        await append(event);
      }

      let review: AutoResearchClawReviewOutput | undefined;
      if (input.reviewRequired === true && this.options.reviewer !== undefined) {
        review = await this.runReview(input, runId, scope, output, events, append, errors);
      }

      await this.rebuildAndPublish(input.projectId, runId, events, contextPack, errors);
      const status = resolveRunStatus(output.status, input.reviewRequired === true, review);
      this.updateRunStore(runId, {
        status,
        outputSummary: output.summary,
        errorMessages: errors,
        artifactIds: output.artifacts.map((artifact) => artifact.id),
        completedAt: (input.now ?? new Date()).toISOString(),
        now: input.now,
      });
      this.indexRunArtifacts(input, runId, output);
      return {
        projectId: input.projectId,
        runId,
        status,
        contextPack,
        output,
        review,
        appendedEvents,
        errors,
      };
    } catch (error) {
      errors.push(`Research run finalization failed: ${errorMessage(error)}`);
      this.failRunStore(runId, errors, input.now);
      return { projectId: input.projectId, runId, status: 'failed', contextPack, output, appendedEvents, errors };
    }
  }

  private startRunStore(input: Parameters<ResearchRunStoreLike['startRun']>[0]): void {
    if (this.options.runStore === undefined) {
      return;
    }
    try {
      this.options.runStore.startRun(input);
    } catch {
      // Run-store persistence is an observability layer; memory events remain the source of truth.
    }
  }

  private updateRunStore(runId: string, patch: Parameters<ResearchRunStoreLike['updateRun']>[1]): void {
    if (this.options.runStore === undefined) {
      return;
    }
    try {
      this.options.runStore.updateRun(runId, patch);
    } catch {
      // Keep research execution and memory ingestion moving even if the lifecycle index is unavailable.
    }
  }

  private failRunStore(runId: string, errors: string[], now: Date | undefined): void {
    this.updateRunStore(runId, {
      status: 'failed',
      errorMessages: errors,
      completedAt: (now ?? new Date()).toISOString(),
      now,
    });
  }

  private indexRunArtifacts(input: RunAutoResearchLoopInput, runId: string, output: AutoResearchClawOutput): void {
    if (this.options.runStore === undefined) {
      return;
    }
    for (const artifact of output.artifacts) {
      try {
        this.options.runStore.indexArtifact({
          id: artifact.id,
          runId,
          projectId: input.projectId,
          uri: artifact.uri,
          summary: artifact.summary,
          metadata: {
            run_status: output.status,
          },
          now: input.now,
        });
      } catch {
        // Artifact index is secondary to the append-only memory ledger.
      }
    }
  }

  private async runReview(
    input: RunAutoResearchLoopInput,
    runId: string,
    scope: MemoryScope,
    output: AutoResearchClawOutput,
    events: MemoryEvent[],
    append: (event: AppendMemoryEventInput) => Promise<MemoryEvent>,
    errors: string[],
  ): Promise<AutoResearchClawReviewOutput | undefined> {
    if (this.options.reviewer === undefined) {
      return undefined;
    }

    let handle: ResearchReviewHandle;
    try {
      handle = await this.options.reviewer.dispatchReview({
        projectId: input.projectId,
        runId,
        projectRoot: input.projectRoot,
        output,
        memoryEvents: events,
      });
    } catch (error) {
      const failure = await append(
        createWorkerFailureEvent(input, runId, scope, `Reviewer dispatch failed: ${errorMessage(error)}`, {
          reviewer: true,
        }),
      );
      errors.push(failure.summary);
      return undefined;
    }

    await append({
      id: stableRunnerEventId('review_worker_dispatched', runId, handle.workerId),
      type: 'worker_dispatched',
      summary: `Reviewer worker dispatched for research run ${runId}`,
      timestamp: input.now?.toISOString(),
      actor: input.actor,
      scope: { ...scope, worker_id: handle.workerId },
      metadata: {
        reviewer: true,
        worker_id: handle.workerId,
        worker_chat_id: handle.workerChatId,
        ...handle.metadata,
      },
    });

    let rawReview: unknown;
    try {
      rawReview = await this.options.reviewer.collectReview(handle);
    } catch (error) {
      const failure = await append(
        createWorkerFailureEvent(
          input,
          runId,
          { ...scope, worker_id: handle.workerId },
          `Reviewer output collection failed: ${errorMessage(error)}`,
          { reviewer: true },
        ),
      );
      errors.push(failure.summary);
      return undefined;
    }

    let review: AutoResearchClawReviewOutput;
    let reviewEvents: AppendMemoryEventInput[];
    try {
      review = normalizeAutoResearchClawReviewOutput(rawReview);
      resolveReviewDecision(review, getStagedReviewEvents(events, input.projectId, runId));
      reviewEvents = autoResearchClawReviewToMemoryEvents(review, {
        actor: input.actor,
        scope: { ...scope, worker_id: handle.workerId },
        workerEventId: stableRunnerEventId('review_worker_completed', runId, handle.workerId),
        timestamp: input.now?.toISOString(),
      });
    } catch (error) {
      const failure = await append(
        createWorkerFailureEvent(
          input,
          runId,
          { ...scope, worker_id: handle.workerId },
          `Invalid reviewer artifact: ${errorMessage(error)}`,
          { reviewer: true, invalid_artifact: true },
        ),
      );
      errors.push(failure.summary);
      return undefined;
    }

    const workerCompleted = await append({
      id: stableRunnerEventId('review_worker_completed', runId, handle.workerId),
      type: 'worker_completed',
      summary: `Reviewer worker completed for research run ${runId}`,
      timestamp: input.now?.toISOString(),
      actor: input.actor,
      scope: { ...scope, worker_id: handle.workerId },
      metadata: {
        reviewer: true,
        worker_id: handle.workerId,
        worker_chat_id: handle.workerChatId,
      },
    });

    const appendedReviewEvents: MemoryEvent[] = [];
    for (const event of reviewEvents.map((event) => ({
      ...event,
      evidence_event_ids: [...new Set([workerCompleted.id, ...(event.evidence_event_ids ?? [])])],
    }))) {
      appendedReviewEvents.push(await append(event));
    }

    const reviewEvent = appendedReviewEvents.find((event) => event.metadata?.autoresearchclaw_review === true);
    if (reviewEvent !== undefined) {
      await applyReviewDecision(input, runId, review, reviewEvent, events, append);
    }

    return review;
  }

  private async rebuildAndPublish(
    projectId: string,
    runId: string,
    events: MemoryEvent[],
    contextPack: ContextPack,
    errors: string[],
  ): Promise<void> {
    try {
      await this.options.semanticProvider?.rebuildFromEvents(events);
    } catch (error) {
      errors.push(`Semantic index rebuild failed: ${errorMessage(error)}`);
    }

    try {
      await this.options.publishRunSummary?.({ projectId, runId, events, contextPack });
    } catch (error) {
      errors.push(`MetaMemory summary publish failed: ${errorMessage(error)}`);
    }
  }
}

function createRunScope(input: RunAutoResearchLoopInput, runId: string): MemoryScope {
  return {
    project_id: input.projectId,
    run_id: runId,
    domain: input.domain ?? input.scope?.domain,
    visibility: input.scope?.visibility ?? 'project',
    chat_id: input.scope?.chat_id,
    agent_id: input.scope?.agent_id,
    worker_id: input.scope?.worker_id,
  };
}

async function applyReviewDecision(
  input: RunAutoResearchLoopInput,
  runId: string,
  review: AutoResearchClawReviewOutput,
  reviewEvent: MemoryEvent,
  events: MemoryEvent[],
  append: (event: AppendMemoryEventInput) => Promise<MemoryEvent>,
): Promise<void> {
  const stagedEvents = getStagedReviewEvents(events, input.projectId, runId);
  const { approvedIds, rejectedIds } = resolveReviewDecision(review, stagedEvents);

  for (const eventId of approvedIds) {
    const original = events.find((event) => event.id === eventId);
    if (original === undefined || original.status !== 'candidate') {
      continue;
    }
    await append(createApprovedReplacementEvent(input, runId, original, reviewEvent));
  }

  for (const eventId of rejectedIds) {
    const original = events.find((event) => event.id === eventId);
    if (original === undefined) {
      continue;
    }
    await append(createReviewRejectedSupersedeEvent(input, runId, original, reviewEvent));
  }
}

function getStagedReviewEvents(events: MemoryEvent[], projectId: string, runId: string): MemoryEvent[] {
  return events.filter(
    (event) =>
      event.scope.project_id === projectId &&
      event.scope.run_id === runId &&
      event.status === 'candidate' &&
      event.metadata?.autoresearchclaw_staged_for_review === true,
  );
}

function resolveReviewDecision(
  review: AutoResearchClawReviewOutput,
  stagedEvents: MemoryEvent[],
): {
  approvedIds: Set<string>;
  rejectedIds: Set<string>;
} {
  const stagedIds = new Set(stagedEvents.map((event) => event.id));
  const explicitApprovedIds = new Set(review.approved_event_ids ?? []);
  const explicitRejectedIds = new Set(review.rejected_event_ids ?? []);

  for (const eventId of [...explicitApprovedIds, ...explicitRejectedIds]) {
    if (!stagedIds.has(eventId)) {
      throw new MemoryCoreError(
        'invalid_review_decision',
        `Reviewer can only target staged events from this run: ${eventId}`,
      );
    }
  }

  for (const eventId of explicitApprovedIds) {
    if (explicitRejectedIds.has(eventId)) {
      throw new MemoryCoreError(
        'invalid_review_decision',
        `Reviewer cannot both approve and reject the same event: ${eventId}`,
      );
    }
  }

  if (review.decision === 'approved') {
    if (explicitRejectedIds.size > 0) {
      throw new MemoryCoreError(
        'invalid_review_decision',
        'approved review decisions cannot include rejected_event_ids; use changes_requested for selective rejection',
      );
    }
    return { approvedIds: new Set(stagedIds), rejectedIds: new Set() };
  }

  if (review.decision === 'rejected') {
    if (explicitApprovedIds.size > 0) {
      throw new MemoryCoreError(
        'invalid_review_decision',
        'rejected review decisions cannot include approved_event_ids; use changes_requested for selective approval',
      );
    }
    return { approvedIds: new Set(), rejectedIds: new Set(stagedIds) };
  }

  return { approvedIds: explicitApprovedIds, rejectedIds: explicitRejectedIds };
}

function createApprovedReplacementEvent(
  input: RunAutoResearchLoopInput,
  runId: string,
  original: MemoryEvent,
  reviewEvent: MemoryEvent,
): AppendMemoryEventInput {
  return {
    id: stableRunnerEventId('review_approved', runId, original.id, reviewEvent.id, eventHash(original)),
    type: original.type,
    summary: original.summary,
    body: original.body,
    timestamp: input.now?.toISOString(),
    actor: input.actor,
    scope: original.scope,
    subject: original.subject,
    outcome: original.outcome,
    confidence: original.confidence,
    evidence_event_ids: unique([reviewEvent.id, original.id, ...(original.evidence_event_ids ?? [])]),
    supersedes: original.id,
    status: 'approved',
    metadata: {
      ...(original.metadata ?? {}),
      autoresearchclaw_approved_by_review_event_id: reviewEvent.id,
      autoresearchclaw_original_event_id: original.id,
      autoresearchclaw_staged_for_review: false,
    },
  };
}

function createReviewRejectedSupersedeEvent(
  input: RunAutoResearchLoopInput,
  runId: string,
  original: MemoryEvent,
  reviewEvent: MemoryEvent,
): AppendMemoryEventInput {
  return {
    id: stableRunnerEventId('review_rejected', runId, original.id, reviewEvent.id),
    type: 'memory_superseded',
    summary: `Reviewer rejected memory event: ${original.summary}`,
    timestamp: input.now?.toISOString(),
    actor: input.actor,
    scope: original.scope,
    evidence_event_ids: unique([reviewEvent.id, original.id]),
    supersedes: original.id,
    status: 'approved',
    metadata: {
      autoresearchclaw_rejected_by_review_event_id: reviewEvent.id,
      autoresearchclaw_original_event_id: original.id,
    },
  };
}

function createWorkerFailureEvent(
  input: RunAutoResearchLoopInput,
  runId: string,
  scope: MemoryScope,
  summary: string,
  metadata: Record<string, unknown> = {},
): AppendMemoryEventInput {
  return {
    id: stableRunnerEventId('worker_failed', runId, summary),
    type: 'worker_failed',
    summary,
    timestamp: input.now?.toISOString(),
    actor: input.actor,
    scope,
    outcome: 'failed',
    status: 'candidate',
    metadata,
  };
}

function resolveRunStatus(
  outputStatus: AutoResearchClawOutput['status'],
  reviewRequired: boolean,
  review: AutoResearchClawReviewOutput | undefined,
): ResearchLoopRunResult['status'] {
  if (!reviewRequired) {
    return outputStatus;
  }
  if (review === undefined) {
    return outputStatus === 'failed' ? 'failed' : 'partial';
  }
  if (review.decision === 'approved') {
    return outputStatus;
  }
  if (review.decision === 'rejected') {
    return 'failed';
  }
  return outputStatus === 'failed' ? 'failed' : 'partial';
}

function stableRunnerEventId(...parts: string[]): string {
  return `mem_evt_arc_runner_${sha256(parts.join('\0')).slice(0, 24)}`;
}

function outputHash(output: AutoResearchClawOutput): string {
  return sha256(JSON.stringify(output));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function eventHash(event: MemoryEvent): string {
  return sha256(stableStringify(comparableMemoryEvent(event)));
}

function hasAppendConflict(existing: MemoryEvent, next: AppendMemoryEventInput): boolean {
  return stableStringify(comparableMemoryEvent(existing)) !== stableStringify(comparableAppendInput(next));
}

function comparableMemoryEvent(event: MemoryEvent): Record<string, unknown> {
  return {
    type: event.type,
    summary: event.summary,
    body: event.body,
    actor: event.actor,
    scope: event.scope,
    subject: event.subject,
    outcome: event.outcome,
    confidence: event.confidence,
    evidence_event_ids: event.evidence_event_ids,
    supersedes: event.supersedes,
    status: event.status ?? 'live',
    metadata: event.metadata,
  };
}

function comparableAppendInput(event: AppendMemoryEventInput): Record<string, unknown> {
  return {
    type: event.type,
    summary: event.summary,
    body: event.body,
    actor: event.actor,
    scope: event.scope,
    subject: event.subject,
    outcome: event.outcome,
    confidence: event.confidence,
    evidence_event_ids: event.evidence_event_ids,
    supersedes: event.supersedes,
    status: event.status ?? 'live',
    metadata: event.metadata,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof MemoryCoreError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
