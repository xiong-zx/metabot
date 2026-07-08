import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { MemoryCoreError, validateMemoryEvent } from './event-ledger.js';
import type {
  AppendMemoryEventInput,
  MemoryActor,
  MemoryEvent,
  MemoryEventStatus,
  MemoryEventType,
  MemoryOutcome,
  MemoryScope,
} from './types.js';

export const AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION = 'autoresearchclaw.output.v2' as const;
export const AUTORESEARCHCLAW_REVIEW_CONTRACT_VERSION = 'autoresearchclaw.review.v1' as const;

const DENIED_MEMORY_EVENT_CANDIDATE_TYPES = new Set<MemoryEventType>([
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'memory_promoted',
  'memory_superseded',
  'memory_redacted',
  'context_pack_created',
  'metamemory_summary_published',
  'metamemory_human_edit',
]);

export type AutoResearchClawRunStatus = 'completed' | 'partial' | 'failed';
export type AutoResearchClawReviewDecision = 'approved' | 'changes_requested' | 'rejected';

export interface AutoResearchClawInput {
  project_id: string;
  run_id: string;
  task: string;
  project_root: string;
  context_pack_markdown: string;
  token_budget?: number;
  run_config?: Record<string, unknown>;
}

export interface AutoResearchClawEvidenceBearingItem {
  id?: string;
  summary: string;
  body?: string;
  confidence?: number;
  evidence_event_ids?: string[];
  artifact_ids?: string[];
  source_uris?: string[];
  metadata?: Record<string, unknown>;
}

export type AutoResearchClawHypothesis = AutoResearchClawEvidenceBearingItem;

export type AutoResearchClawFinding = AutoResearchClawEvidenceBearingItem;

export interface AutoResearchClawNegativeResult extends AutoResearchClawEvidenceBearingItem {
  reason?: string;
}

export interface AutoResearchClawDecision extends AutoResearchClawEvidenceBearingItem {
  approval_required?: boolean;
}

export type AutoResearchClawOpenQuestion = AutoResearchClawEvidenceBearingItem;

export interface AutoResearchClawPivot extends AutoResearchClawEvidenceBearingItem {
  supersedes?: string;
}

export interface AutoResearchClawMetric extends AutoResearchClawEvidenceBearingItem {
  name?: string;
  value?: string | number | boolean;
}

export interface AutoResearchClawExperiment extends AutoResearchClawEvidenceBearingItem {
  outcome?: MemoryOutcome;
  status?: AutoResearchClawRunStatus;
  metric_ids?: string[];
}

export interface AutoResearchClawArtifact {
  id: string;
  uri: string;
  summary: string;
  kind?: string;
  sha256?: string;
  source_uris?: string[];
  metadata?: Record<string, unknown>;
}

export interface AutoResearchClawFollowup {
  summary: string;
  priority?: 'low' | 'medium' | 'high';
  metadata?: Record<string, unknown>;
}

export interface AutoResearchClawToolTrace {
  tool: string;
  summary: string;
  status?: AutoResearchClawRunStatus;
  artifact_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface AutoResearchClawMemoryEventCandidate {
  type: MemoryEventType;
  summary: string;
  body?: string;
  outcome?: MemoryOutcome;
  confidence?: number;
  evidence_event_ids?: string[];
  subject?: AppendMemoryEventInput['subject'];
  supersedes?: string;
  status?: MemoryEventStatus;
  metadata?: Record<string, unknown>;
}

export interface AutoResearchClawOutput {
  contract_version: typeof AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION;
  project_id: string;
  run_id: string;
  status: AutoResearchClawRunStatus;
  summary: string;
  hypotheses: AutoResearchClawHypothesis[];
  experiments: AutoResearchClawExperiment[];
  findings: AutoResearchClawFinding[];
  negative_results: AutoResearchClawNegativeResult[];
  decisions: AutoResearchClawDecision[];
  artifacts: AutoResearchClawArtifact[];
  open_questions: AutoResearchClawOpenQuestion[];
  memory_event_candidates: AutoResearchClawMemoryEventCandidate[];
  recommended_followups: AutoResearchClawFollowup[];
  tool_trace: AutoResearchClawToolTrace[];
  metrics?: AutoResearchClawMetric[];
  pivots?: AutoResearchClawPivot[];
}

export interface AutoResearchClawReviewOutput {
  contract_version: typeof AUTORESEARCHCLAW_REVIEW_CONTRACT_VERSION;
  project_id: string;
  run_id: string;
  decision: AutoResearchClawReviewDecision;
  summary: string;
  issues: AutoResearchClawEvidenceBearingItem[];
  approved_event_ids?: string[];
  rejected_event_ids?: string[];
  recommended_followups?: AutoResearchClawFollowup[];
}

export interface ValidateAutoResearchClawOutputOptions {
  expectedProjectId?: string;
  expectedRunId?: string;
  projectRoot?: string;
}

export interface AutoResearchClawIngestOptions {
  actor: MemoryActor;
  scope: MemoryScope;
  workerEventId?: string;
  timestamp?: string;
  defaultStatus?: MemoryEventStatus;
  stagedForReview?: boolean;
  projectRoot?: string;
}

export function buildAutoResearchClawPrompt(input: AutoResearchClawInput): string {
  return [
    '# AutoResearchClaw Run',
    '',
    `Project: ${input.project_id}`,
    `Run: ${input.run_id}`,
    `Project root: ${input.project_root}`,
    '',
    '## Task',
    input.task,
    '',
    '## Context Pack',
    input.context_pack_markdown.trim() || '(empty)',
    '',
    '## Required Output',
    `Write a JSON artifact named autoresearchclaw-output.json using contract ${AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION}.`,
    'The JSON artifact is authoritative; chat text is not accepted as memory.',
    'Do not write accepted long-term memory directly. Put uncertain items in memory_event_candidates.',
    'Do not dispatch nested workers, subagents, background tasks, or reminders. Complete the research loop in this worker and write the JSON artifact yourself.',
    'Do not call worker_dispatch, research_loop_dispatch, metabot talk, or any equivalent orchestration command from inside this worker.',
    '',
    'Required top-level keys:',
    [
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
    ].join(', '),
    '',
    'Required nested shape:',
    '- Every hypothesis, finding, negative_result, decision, open_question, metric, and pivot item must include a non-empty summary string.',
    '- Every experiment item must include a non-empty summary string; status may be completed, partial, or failed.',
    '- Every artifact item must include id, uri, and summary. Artifact paths must stay inside the project root.',
    '- Every memory_event_candidates item must include a non-empty type and summary. Use ordinary memory event types such as note, finding, decision, negative_result, open_question, or hypothesis; do not use approval_requested, approval_granted, approval_rejected, memory_promoted, memory_superseded, memory_redacted, context_pack_created, or any other controlled event type.',
    '- memory_event_candidates must not set supersedes. If there is no candidate memory, write an empty array.',
    '- Every recommended_followups item must include summary.',
    '- Every tool_trace item must include tool and summary.',
    '',
    'Minimal valid smoke output example:',
    JSON.stringify(
      {
        contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
        project_id: input.project_id,
        run_id: input.run_id,
        status: 'completed',
        summary: 'PASS: minimal contract artifact was produced.',
        hypotheses: [{ summary: 'Smoke run can produce a valid contract artifact.' }],
        experiments: [{ summary: 'Validated minimal artifact generation without network access.', status: 'completed' }],
        findings: [{ summary: 'Required top-level and nested fields are present.' }],
        negative_results: [],
        decisions: [{ summary: 'Keep r6 smoke run local and minimal.', approval_required: false }],
        artifacts: [],
        open_questions: [],
        memory_event_candidates: [],
        recommended_followups: [],
        tool_trace: [{ tool: 'local', summary: 'No network or nested worker dispatch used.', status: 'completed' }],
      },
      null,
      2,
    ),
    '',
  ].join('\n');
}

export function normalizeAutoResearchClawOutput(value: unknown): AutoResearchClawOutput {
  const output = ensureRecord(value, 'AutoResearchClaw output');
  const normalized: AutoResearchClawOutput = {
    contract_version: ensureLiteral(
      output.contract_version,
      AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
      'contract_version',
    ),
    project_id: ensureNonEmptyString(output.project_id, 'project_id'),
    run_id: ensureNonEmptyString(output.run_id, 'run_id'),
    status: ensureRunStatus(output.status, 'status'),
    summary: ensureNonEmptyString(output.summary, 'summary'),
    hypotheses: normalizeEvidenceItems(output.hypotheses, 'hypotheses'),
    experiments: normalizeExperiments(output.experiments, 'experiments'),
    findings: normalizeEvidenceItems(output.findings, 'findings'),
    negative_results: normalizeEvidenceItems(output.negative_results, 'negative_results'),
    decisions: normalizeDecisions(output.decisions, 'decisions'),
    artifacts: normalizeArtifacts(output.artifacts, 'artifacts'),
    open_questions: normalizeEvidenceItems(output.open_questions, 'open_questions'),
    memory_event_candidates: normalizeMemoryEventCandidates(output.memory_event_candidates, 'memory_event_candidates'),
    recommended_followups: normalizeFollowups(output.recommended_followups, 'recommended_followups'),
    tool_trace: normalizeToolTrace(output.tool_trace, 'tool_trace'),
  };

  const metrics = normalizeOptionalEvidenceItems(output.metrics, 'metrics');
  if (metrics !== undefined) {
    normalized.metrics = metrics;
  }
  const pivots = normalizeOptionalPivots(output.pivots, 'pivots');
  if (pivots !== undefined) {
    normalized.pivots = pivots;
  }
  return normalized;
}

export function validateAutoResearchClawOutput(
  value: unknown,
  options: ValidateAutoResearchClawOutputOptions = {},
): AutoResearchClawOutput {
  const output = normalizeAutoResearchClawOutput(value);
  if (options.expectedProjectId !== undefined && output.project_id !== options.expectedProjectId) {
    throw new MemoryCoreError(
      'autoresearchclaw_project_mismatch',
      `AutoResearchClaw project_id mismatch: expected ${options.expectedProjectId}, got ${output.project_id}`,
    );
  }
  if (options.expectedRunId !== undefined && output.run_id !== options.expectedRunId) {
    throw new MemoryCoreError(
      'autoresearchclaw_run_mismatch',
      `AutoResearchClaw run_id mismatch: expected ${options.expectedRunId}, got ${output.run_id}`,
    );
  }
  if (options.projectRoot !== undefined) {
    validateArtifactUris(output, options.projectRoot);
  }
  return output;
}

export function normalizeAutoResearchClawReviewOutput(value: unknown): AutoResearchClawReviewOutput {
  const output = ensureRecord(value, 'AutoResearchClaw review output');
  return {
    contract_version: ensureLiteral(
      output.contract_version,
      AUTORESEARCHCLAW_REVIEW_CONTRACT_VERSION,
      'contract_version',
    ),
    project_id: ensureNonEmptyString(output.project_id, 'project_id'),
    run_id: ensureNonEmptyString(output.run_id, 'run_id'),
    decision: ensureReviewDecision(output.decision, 'decision'),
    summary: ensureNonEmptyString(output.summary, 'summary'),
    issues: normalizeEvidenceItems(output.issues, 'issues'),
    approved_event_ids: normalizeOptionalStringArray(output.approved_event_ids, 'approved_event_ids'),
    rejected_event_ids: normalizeOptionalStringArray(output.rejected_event_ids, 'rejected_event_ids'),
    recommended_followups: normalizeOptionalFollowups(output.recommended_followups, 'recommended_followups'),
  };
}

export function autoResearchClawOutputToMemoryEvents(
  value: unknown,
  options: AutoResearchClawIngestOptions,
): AppendMemoryEventInput[] {
  const output = validateAutoResearchClawOutput(value, {
    expectedProjectId: options.scope.project_id,
    expectedRunId: options.scope.run_id,
    projectRoot: options.projectRoot,
  });
  const baseScope = canonicalResearchScope(options.scope, output);
  const eventOptions = { ...options, scope: baseScope };
  const events: AppendMemoryEventInput[] = [];

  output.hypotheses.forEach((item, index) => {
    events.push(itemToEvent(output, 'hypothesis', item, index, eventOptions, { status: 'candidate' }));
  });
  output.experiments.forEach((item, index) => {
    events.push(
      itemToEvent(output, 'experiment_result', item, index, eventOptions, {
        outcome: item.outcome ?? statusToOutcome(item.status),
      }),
    );
  });
  (output.metrics ?? []).forEach((item, index) => {
    events.push(itemToEvent(output, 'metric_observed', item, index, eventOptions));
  });
  output.findings.forEach((item, index) => {
    events.push(itemToEvent(output, 'finding', item, index, eventOptions));
  });
  output.negative_results.forEach((item, index) => {
    events.push(
      itemToEvent(output, 'negative_result', item, index, eventOptions, {
        outcome: 'failed',
        bodySuffix: item.reason,
      }),
    );
  });
  output.decisions.forEach((item, index) => {
    events.push(
      itemToEvent(output, 'decision', item, index, eventOptions, {
        status: item.approval_required === true ? 'candidate' : undefined,
      }),
    );
  });
  (output.pivots ?? []).forEach((item, index) => {
    events.push(itemToEvent(output, 'pivot', item, index, eventOptions, { supersedes: item.supersedes }));
  });
  output.open_questions.forEach((item, index) => {
    events.push(itemToEvent(output, 'open_question', item, index, eventOptions, { status: 'candidate' }));
  });
  output.artifacts.forEach((artifact, index) => {
    events.push(artifactToEvent(output, artifact, index, eventOptions));
  });
  output.memory_event_candidates.forEach((candidate, index) => {
    events.push(candidateToEvent(output, candidate, index, eventOptions));
  });

  ensureUniqueGeneratedEventIds(events);
  return events.map((event) => {
    validateAppendInput(event);
    return event;
  });
}

export function autoResearchClawReviewToMemoryEvents(
  value: unknown,
  options: AutoResearchClawIngestOptions,
): AppendMemoryEventInput[] {
  const output = normalizeAutoResearchClawReviewOutput(value);
  if (options.scope.project_id !== undefined && output.project_id !== options.scope.project_id) {
    throw new MemoryCoreError('autoresearchclaw_review_project_mismatch', 'Review project_id does not match run scope');
  }
  if (options.scope.run_id !== undefined && output.run_id !== options.scope.run_id) {
    throw new MemoryCoreError('autoresearchclaw_review_run_mismatch', 'Review run_id does not match run scope');
  }

  const evidenceIds = unique([
    options.workerEventId,
    ...(output.approved_event_ids ?? []),
    ...(output.rejected_event_ids ?? []),
  ]);
  const reviewEvent: AppendMemoryEventInput = {
    id: stableEventId(output.run_id, 'review', output.decision, output.summary),
    type: 'note',
    summary: `Reviewer ${output.decision}: ${output.summary}`,
    body: output.issues.map((issue) => `- ${issue.summary}`).join('\n') || undefined,
    timestamp: options.timestamp,
    actor: options.actor,
    scope: canonicalResearchScope(options.scope, output),
    evidence_event_ids: evidenceIds,
    status: output.decision === 'approved' ? 'live' : 'candidate',
    metadata: {
      autoresearchclaw_review: true,
      review_decision: output.decision,
      approved_event_ids: output.approved_event_ids ?? [],
      rejected_event_ids: output.rejected_event_ids ?? [],
    },
  };
  validateAppendInput(reviewEvent);
  return [reviewEvent];
}

function itemToEvent(
  output: AutoResearchClawOutput,
  type: MemoryEventType,
  item: AutoResearchClawEvidenceBearingItem,
  index: number,
  options: AutoResearchClawIngestOptions,
  overrides: {
    status?: MemoryEventStatus;
    outcome?: MemoryOutcome;
    bodySuffix?: string;
    supersedes?: string;
  } = {},
): AppendMemoryEventInput {
  const bodyParts = [item.body, overrides.bodySuffix].filter((part): part is string => typeof part === 'string');
  const status = overrides.status ?? options.defaultStatus;
  return {
    id: stableEventId(output.run_id, type, item.id ?? String(index), item.summary, itemSignature(item, overrides)),
    type,
    summary: item.summary,
    body: bodyParts.length > 0 ? bodyParts.join('\n\n') : undefined,
    timestamp: options.timestamp,
    actor: options.actor,
    scope: options.scope,
    subject: {
      artifact_ids: item.artifact_ids,
      source_uris: item.source_uris,
    },
    outcome: overrides.outcome,
    confidence: item.confidence,
    evidence_event_ids: unique([options.workerEventId, ...(item.evidence_event_ids ?? [])]),
    supersedes: overrides.supersedes,
    status,
    metadata: {
      ...(item.metadata ?? {}),
      autoresearchclaw: true,
      autoresearchclaw_run_id: output.run_id,
      autoresearchclaw_item_id: item.id,
      autoresearchclaw_item_index: index,
      autoresearchclaw_staged_for_review:
        options.stagedForReview === true && overrides.status === undefined && status === 'candidate',
    },
  };
}

function artifactToEvent(
  output: AutoResearchClawOutput,
  artifact: AutoResearchClawArtifact,
  index: number,
  options: AutoResearchClawIngestOptions,
): AppendMemoryEventInput {
  return {
    id: stableEventId(output.run_id, 'artifact_created', artifact.id, artifact.summary, JSON.stringify(artifact)),
    type: 'artifact_created',
    summary: artifact.summary,
    timestamp: options.timestamp,
    actor: options.actor,
    scope: options.scope,
    subject: {
      artifact_ids: [artifact.id],
      source_uris: unique([artifact.uri, ...(artifact.source_uris ?? [])]),
    },
    evidence_event_ids: unique([options.workerEventId]),
    status: options.defaultStatus,
    metadata: {
      ...(artifact.metadata ?? {}),
      autoresearchclaw: true,
      autoresearchclaw_run_id: output.run_id,
      autoresearchclaw_staged_for_review: options.stagedForReview === true && options.defaultStatus === 'candidate',
      artifact_kind: artifact.kind,
      artifact_sha256: artifact.sha256,
      artifact_uri: artifact.uri,
      artifact_index: index,
    },
  };
}

function candidateToEvent(
  output: AutoResearchClawOutput,
  candidate: AutoResearchClawMemoryEventCandidate,
  index: number,
  options: AutoResearchClawIngestOptions,
): AppendMemoryEventInput {
  return {
    id: stableEventId(
      output.run_id,
      'candidate',
      String(index),
      candidate.type,
      candidate.summary,
      JSON.stringify(candidate),
    ),
    type: candidate.type,
    summary: candidate.summary,
    body: candidate.body,
    timestamp: options.timestamp,
    actor: options.actor,
    scope: options.scope,
    subject: candidate.subject,
    outcome: candidate.outcome,
    confidence: candidate.confidence,
    evidence_event_ids: unique([options.workerEventId, ...(candidate.evidence_event_ids ?? [])]),
    supersedes: candidate.supersedes,
    status: 'candidate',
    metadata: {
      ...(candidate.metadata ?? {}),
      autoresearchclaw: true,
      autoresearchclaw_candidate: true,
      autoresearchclaw_run_id: output.run_id,
      autoresearchclaw_candidate_index: index,
      requested_status: candidate.status,
    },
  };
}

function ensureUniqueGeneratedEventIds(events: AppendMemoryEventInput[]): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.id === undefined) {
      continue;
    }
    if (seen.has(event.id)) {
      throw new MemoryCoreError(
        'duplicate_autoresearchclaw_event_id',
        `AutoResearchClaw output generated duplicate memory event id: ${event.id}`,
      );
    }
    seen.add(event.id);
  }
}

function itemSignature(
  item: AutoResearchClawEvidenceBearingItem,
  overrides: {
    status?: MemoryEventStatus;
    outcome?: MemoryOutcome;
    bodySuffix?: string;
    supersedes?: string;
  },
): string {
  return JSON.stringify({
    body: item.body,
    confidence: item.confidence,
    evidence_event_ids: item.evidence_event_ids,
    artifact_ids: item.artifact_ids,
    source_uris: item.source_uris,
    metadata: item.metadata,
    overrides,
  });
}

function canonicalResearchScope(
  scope: MemoryScope,
  output: Pick<AutoResearchClawOutput | AutoResearchClawReviewOutput, 'project_id' | 'run_id'>,
): MemoryScope {
  return {
    ...scope,
    project_id: output.project_id,
    run_id: output.run_id,
    visibility: scope.visibility,
  };
}

function validateAppendInput(input: AppendMemoryEventInput): void {
  validateMemoryEvent({
    ...input,
    id: input.id ?? `mem_evt_${randomUUID()}`,
    timestamp: input.timestamp ?? new Date(0).toISOString(),
    status: input.status ?? 'live',
  } as MemoryEvent);
}

function normalizeEvidenceItems(value: unknown, field: string): AutoResearchClawEvidenceBearingItem[] {
  return ensureArray(value, field).map((item, index) => normalizeEvidenceItem(item, `${field}[${index}]`));
}

function normalizeOptionalEvidenceItems(
  value: unknown,
  field: string,
): AutoResearchClawEvidenceBearingItem[] | undefined {
  return value === undefined ? undefined : normalizeEvidenceItems(value, field);
}

function normalizeExperiments(value: unknown, field: string): AutoResearchClawExperiment[] {
  return ensureArray(value, field).map((item, index) => {
    const normalized = normalizeEvidenceItem(item, `${field}[${index}]`);
    const record = ensureRecord(item, `${field}[${index}]`);
    return {
      ...normalized,
      outcome: record.outcome === undefined ? undefined : ensureOutcome(record.outcome, `${field}[${index}].outcome`),
      status: record.status === undefined ? undefined : ensureRunStatus(record.status, `${field}[${index}].status`),
      metric_ids: normalizeOptionalStringArray(record.metric_ids, `${field}[${index}].metric_ids`),
    };
  });
}

function normalizeDecisions(value: unknown, field: string): AutoResearchClawDecision[] {
  return ensureArray(value, field).map((item, index) => {
    const normalized = normalizeEvidenceItem(item, `${field}[${index}]`);
    const record = ensureRecord(item, `${field}[${index}]`);
    return {
      ...normalized,
      approval_required:
        record.approval_required === undefined
          ? undefined
          : ensureBoolean(record.approval_required, `${field}[${index}].approval_required`),
    };
  });
}

function normalizeOptionalPivots(value: unknown, field: string): AutoResearchClawPivot[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureArray(value, field).map((item, index) => {
    const normalized = normalizeEvidenceItem(item, `${field}[${index}]`);
    const record = ensureRecord(item, `${field}[${index}]`);
    return {
      ...normalized,
      supersedes:
        record.supersedes === undefined
          ? undefined
          : ensureNonEmptyString(record.supersedes, `${field}[${index}].supersedes`),
    };
  });
}

function normalizeEvidenceItem(value: unknown, field: string): AutoResearchClawEvidenceBearingItem {
  const record = ensureRecord(value, field);
  const confidence =
    record.confidence === undefined ? undefined : ensureConfidence(record.confidence, `${field}.confidence`);
  return {
    id: optionalNonEmptyString(record.id, `${field}.id`),
    summary: ensureNonEmptyString(record.summary, `${field}.summary`),
    body: optionalNonEmptyString(record.body, `${field}.body`),
    confidence,
    evidence_event_ids: normalizeOptionalStringArray(record.evidence_event_ids, `${field}.evidence_event_ids`),
    artifact_ids: normalizeOptionalStringArray(record.artifact_ids, `${field}.artifact_ids`),
    source_uris: normalizeOptionalStringArray(record.source_uris, `${field}.source_uris`),
    metadata: normalizeOptionalRecord(record.metadata, `${field}.metadata`),
  };
}

function normalizeArtifacts(value: unknown, field: string): AutoResearchClawArtifact[] {
  return ensureArray(value, field).map((item, index) => {
    const record = ensureRecord(item, `${field}[${index}]`);
    return {
      id: ensureNonEmptyString(record.id, `${field}[${index}].id`),
      uri: ensureNonEmptyString(record.uri, `${field}[${index}].uri`),
      summary: ensureNonEmptyString(record.summary, `${field}[${index}].summary`),
      kind: optionalNonEmptyString(record.kind, `${field}[${index}].kind`),
      sha256: optionalNonEmptyString(record.sha256, `${field}[${index}].sha256`),
      source_uris: normalizeOptionalStringArray(record.source_uris, `${field}[${index}].source_uris`),
      metadata: normalizeOptionalRecord(record.metadata, `${field}[${index}].metadata`),
    };
  });
}

function validateArtifactUris(output: AutoResearchClawOutput, projectRoot: string): void {
  for (const [index, artifact] of output.artifacts.entries()) {
    validateArtifactUri(artifact.uri, projectRoot, `artifacts[${index}].uri`);
    for (const [sourceIndex, sourceUri] of (artifact.source_uris ?? []).entries()) {
      validateArtifactUri(sourceUri, projectRoot, `artifacts[${index}].source_uris[${sourceIndex}]`);
    }
  }
}

function validateArtifactUri(uri: string, projectRoot: string, field: string): void {
  if (isExternalUri(uri)) {
    return;
  }
  const filePath = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  const resolved = path.resolve(projectRoot, filePath);
  const resolvedRoot = path.resolve(projectRoot);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MemoryCoreError('artifact_uri_outside_project_root', `${field} escapes project root: ${uri}`);
  }
}

function isExternalUri(uri: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(uri) && !uri.startsWith('file://');
}

function normalizeMemoryEventCandidates(value: unknown, field: string): AutoResearchClawMemoryEventCandidate[] {
  return ensureArray(value, field).map((item, index) => {
    const record = ensureRecord(item, `${field}[${index}]`);
    const type = ensureNonEmptyString(record.type, `${field}[${index}].type`) as MemoryEventType;
    if (DENIED_MEMORY_EVENT_CANDIDATE_TYPES.has(type)) {
      throw new MemoryCoreError(
        'autoresearchclaw_candidate_type_not_allowed',
        `${field}[${index}].type cannot be a controlled memory event type`,
      );
    }
    if (record.supersedes !== undefined) {
      throw new MemoryCoreError(
        'autoresearchclaw_candidate_supersedes_not_allowed',
        `${field}[${index}].supersedes cannot be set by AutoResearchClaw candidates`,
      );
    }
    return {
      type,
      summary: ensureNonEmptyString(record.summary, `${field}[${index}].summary`),
      body: optionalNonEmptyString(record.body, `${field}[${index}].body`),
      outcome: record.outcome === undefined ? undefined : ensureOutcome(record.outcome, `${field}[${index}].outcome`),
      confidence:
        record.confidence === undefined
          ? undefined
          : ensureConfidence(record.confidence, `${field}[${index}].confidence`),
      evidence_event_ids: normalizeOptionalStringArray(
        record.evidence_event_ids,
        `${field}[${index}].evidence_event_ids`,
      ),
      subject:
        record.subject === undefined
          ? undefined
          : (ensureRecord(record.subject, `${field}[${index}].subject`) as AppendMemoryEventInput['subject']),
      supersedes: undefined,
      status:
        record.status === undefined
          ? undefined
          : (ensureNonEmptyString(record.status, `${field}[${index}].status`) as MemoryEventStatus),
      metadata: normalizeOptionalRecord(record.metadata, `${field}[${index}].metadata`),
    };
  });
}

function normalizeFollowups(value: unknown, field: string): AutoResearchClawFollowup[] {
  return ensureArray(value, field).map((item, index) => normalizeFollowup(item, `${field}[${index}]`));
}

function normalizeOptionalFollowups(value: unknown, field: string): AutoResearchClawFollowup[] | undefined {
  return value === undefined ? undefined : normalizeFollowups(value, field);
}

function normalizeFollowup(value: unknown, field: string): AutoResearchClawFollowup {
  const record = ensureRecord(value, field);
  return {
    summary: ensureNonEmptyString(record.summary, `${field}.summary`),
    priority:
      record.priority === undefined
        ? undefined
        : ensureOneOf(record.priority, ['low', 'medium', 'high'] as const, `${field}.priority`),
    metadata: normalizeOptionalRecord(record.metadata, `${field}.metadata`),
  };
}

function normalizeToolTrace(value: unknown, field: string): AutoResearchClawToolTrace[] {
  return ensureArray(value, field).map((item, index) => {
    const record = ensureRecord(item, `${field}[${index}]`);
    return {
      tool: ensureNonEmptyString(record.tool, `${field}[${index}].tool`),
      summary: ensureNonEmptyString(record.summary, `${field}[${index}].summary`),
      status: record.status === undefined ? undefined : ensureRunStatus(record.status, `${field}[${index}].status`),
      artifact_ids: normalizeOptionalStringArray(record.artifact_ids, `${field}[${index}].artifact_ids`),
      metadata: normalizeOptionalRecord(record.metadata, `${field}[${index}].metadata`),
    };
  });
}

function ensureLiteral<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    throw new MemoryCoreError('invalid_autoresearchclaw_contract', `${field} must be ${expected}`);
  }
  return expected;
}

function ensureRunStatus(value: unknown, field: string): AutoResearchClawRunStatus {
  return ensureOneOf(value, ['completed', 'partial', 'failed'] as const, field);
}

function ensureReviewDecision(value: unknown, field: string): AutoResearchClawReviewDecision {
  return ensureOneOf(value, ['approved', 'changes_requested', 'rejected'] as const, field);
}

function ensureOutcome(value: unknown, field: string): MemoryOutcome {
  return ensureOneOf(value, ['worked', 'failed', 'partial', 'unknown'] as const, field);
}

function ensureOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new MemoryCoreError('invalid_autoresearchclaw_field', `${field} has unsupported value: ${String(value)}`);
  }
  return value as T;
}

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryCoreError('invalid_autoresearchclaw_field', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureNonEmptyString(value, field);
}

function ensureBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new MemoryCoreError('invalid_autoresearchclaw_field', `${field} must be a boolean`);
  }
  return value;
}

function ensureConfidence(value: unknown, field: string): number {
  if (typeof value !== 'number' || value < 0 || value > 1) {
    throw new MemoryCoreError('invalid_autoresearchclaw_field', `${field} must be between 0 and 1`);
  }
  return value;
}

function ensureArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new MemoryCoreError('invalid_autoresearchclaw_field', `${field} must be an array`);
  }
  return value;
}

function normalizeOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const array = ensureArray(value, field);
  for (const [index, item] of array.entries()) {
    ensureNonEmptyString(item, `${field}[${index}]`);
  }
  return array.map((item) => String(item).trim());
}

function normalizeOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureRecord(value, field);
}

function ensureRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryCoreError('invalid_autoresearchclaw_field', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function statusToOutcome(status: AutoResearchClawRunStatus | undefined): MemoryOutcome | undefined {
  switch (status) {
    case 'completed':
      return 'worked';
    case 'partial':
      return 'partial';
    case 'failed':
      return 'failed';
    case undefined:
      return undefined;
  }
}

function stableEventId(...parts: string[]): string {
  return `mem_evt_arc_${sha256(parts.join('\0')).slice(0, 24)}`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
