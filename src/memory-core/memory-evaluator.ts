import { deriveMemoryUnits } from './memory-curator.js';
import { estimateTokens } from './context-pack-builder.js';
import type { ContextPack, ContextPackScopeFilter, MemoryEvent, MemoryEventType, MemoryUnit } from './types.js';

export interface MemoryCoreEvaluationThresholds {
  maxUnsafeInjections?: number;
  minEvidenceCoverage?: number;
  minNegativeResultRecall?: number;
  maxOrphanEvidenceIds?: number;
}

export interface MemoryCoreEvaluationInput {
  events: MemoryEvent[];
  contextPacks: ContextPack[];
  rawHistoryMarkdown?: string;
  rawHistoryTokenEstimate?: number;
  expectedNegativeResultEventIds?: string[];
  claimEventTypes?: MemoryEventType[];
  thresholds?: MemoryCoreEvaluationThresholds;
}

export interface MemoryCoreEvaluationIssue {
  code:
    | 'unsafe_context_injection'
    | 'claim_without_evidence'
    | 'orphan_evidence_event'
    | 'negative_result_not_recalled'
    | 'token_reduction_below_zero';
  severity: 'error' | 'warning';
  message: string;
  event_id?: string;
  memory_unit_id?: string;
  context_pack_id?: string;
}

export interface MemoryCoreEvaluationMetrics {
  raw_history_tokens?: number;
  context_pack_tokens: number;
  token_reduction_ratio?: number;
  unsafe_injection_count: number;
  evidence_coverage_ratio: number;
  claims_checked: number;
  claims_with_evidence: number;
  orphan_evidence_event_ids: string[];
  negative_result_recall_ratio?: number;
  expected_negative_results: number;
  recalled_negative_results: number;
  memory_unit_count: number;
  active_memory_unit_count: number;
}

export interface MemoryCoreEvaluationReport {
  passed: boolean;
  metrics: MemoryCoreEvaluationMetrics;
  issues: MemoryCoreEvaluationIssue[];
  markdown: string;
}

const DEFAULT_CLAIM_EVENT_TYPES: MemoryEventType[] = [
  'fix',
  'decision',
  'finding',
  'experiment_result',
  'metric_observed',
  'negative_result',
];

export function evaluateMemoryCore(input: MemoryCoreEvaluationInput): MemoryCoreEvaluationReport {
  const thresholds = {
    maxUnsafeInjections: 0,
    minEvidenceCoverage: 1,
    minNegativeResultRecall:
      input.expectedNegativeResultEventIds && input.expectedNegativeResultEventIds.length > 0 ? 1 : 0,
    maxOrphanEvidenceIds: 0,
    ...input.thresholds,
  };
  const units = deriveMemoryUnits(input.events, { includeRejected: true });
  const eventById = new Map(input.events.map((event) => [event.id, event]));
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const unitByEventId = buildUnitByEventId(units);
  const issues: MemoryCoreEvaluationIssue[] = [];

  for (const pack of input.contextPacks) {
    const eventIdsAlreadyChecked = new Set(pack.included_event_ids);
    for (const eventId of pack.included_event_ids) {
      const event = eventById.get(eventId);
      const unit = unitByEventId.get(eventId);
      const unsafeReason = getUnsafeInjectionReason(event, unit, pack.scope_filter);
      if (unsafeReason !== undefined) {
        issues.push({
          code: 'unsafe_context_injection',
          severity: 'error',
          message: unsafeReason,
          event_id: eventId,
          context_pack_id: pack.id,
        });
      }
    }

    for (const unitId of pack.included_memory_unit_ids) {
      const unit = unitById.get(unitId);
      if (unit !== undefined && unit.source_event_ids.some((eventId) => eventIdsAlreadyChecked.has(eventId))) {
        continue;
      }
      const event = unit === undefined ? undefined : eventById.get(unit.source_event_ids[0]);
      const unsafeReason = getUnsafeInjectionReason(event, unit, pack.scope_filter);
      if (unsafeReason !== undefined) {
        issues.push({
          code: 'unsafe_context_injection',
          severity: 'error',
          message: unsafeReason,
          event_id: event?.id,
          memory_unit_id: unitId,
          context_pack_id: pack.id,
        });
      }
    }
  }

  const claimTypes = input.claimEventTypes ?? DEFAULT_CLAIM_EVENT_TYPES;
  const claims = input.events.filter((event) => isLongTermClaim(event, claimTypes));
  const claimsWithEvidence = claims.filter((claim) => hasVerifiedEvidence(claim, eventById));
  for (const claim of claims) {
    if (!hasVerifiedEvidence(claim, eventById)) {
      issues.push({
        code: 'claim_without_evidence',
        severity: 'warning',
        message: `Long-term claim has no evidence: ${claim.summary}`,
        event_id: claim.id,
      });
    }
  }

  const orphanEvidenceEventIds = unique(
    input.events.flatMap((event) => event.evidence_event_ids ?? []).filter((id) => !eventById.has(id)),
  );
  for (const eventId of orphanEvidenceEventIds) {
    issues.push({
      code: 'orphan_evidence_event',
      severity: 'error',
      message: `Evidence event id does not exist: ${eventId}`,
      event_id: eventId,
    });
  }

  const expectedNegativeResultEventIds = input.expectedNegativeResultEventIds ?? [];
  const recalledNegativeResults = expectedNegativeResultEventIds.filter((id) =>
    input.contextPacks.some(
      (pack) =>
        pack.included_event_ids.includes(id) ||
        pack.included_memory_unit_ids.some((unitId) => unitById.get(unitId)?.source_event_ids.includes(id) === true),
    ),
  );
  for (const id of expectedNegativeResultEventIds) {
    if (!recalledNegativeResults.includes(id)) {
      issues.push({
        code: 'negative_result_not_recalled',
        severity: 'warning',
        message: `Expected negative result was not recalled: ${id}`,
        event_id: id,
      });
    }
  }

  const rawHistoryTokens =
    input.rawHistoryTokenEstimate ??
    (input.rawHistoryMarkdown === undefined ? undefined : estimateTokens(input.rawHistoryMarkdown));
  const contextPackTokens = input.contextPacks.reduce((total, pack) => total + estimateTokens(pack.markdown), 0);
  const tokenReductionRatio =
    rawHistoryTokens === undefined || rawHistoryTokens === 0
      ? undefined
      : (rawHistoryTokens - contextPackTokens) / rawHistoryTokens;
  if (tokenReductionRatio !== undefined && tokenReductionRatio < 0) {
    issues.push({
      code: 'token_reduction_below_zero',
      severity: 'warning',
      message: `Context packs use more tokens than raw history: ${tokenReductionRatio.toFixed(3)}`,
    });
  }

  const unsafeInjectionCount = issues.filter((issue) => issue.code === 'unsafe_context_injection').length;
  const evidenceCoverageRatio = claims.length === 0 ? 1 : claimsWithEvidence.length / claims.length;
  const negativeResultRecallRatio =
    expectedNegativeResultEventIds.length === 0
      ? undefined
      : recalledNegativeResults.length / expectedNegativeResultEventIds.length;

  const metrics: MemoryCoreEvaluationMetrics = {
    raw_history_tokens: rawHistoryTokens,
    context_pack_tokens: contextPackTokens,
    token_reduction_ratio: tokenReductionRatio,
    unsafe_injection_count: unsafeInjectionCount,
    evidence_coverage_ratio: evidenceCoverageRatio,
    claims_checked: claims.length,
    claims_with_evidence: claimsWithEvidence.length,
    orphan_evidence_event_ids: orphanEvidenceEventIds,
    negative_result_recall_ratio: negativeResultRecallRatio,
    expected_negative_results: expectedNegativeResultEventIds.length,
    recalled_negative_results: recalledNegativeResults.length,
    memory_unit_count: units.length,
    active_memory_unit_count: units.filter((unit) => unit.state === 'active').length,
  };

  const passed =
    metrics.unsafe_injection_count <= thresholds.maxUnsafeInjections &&
    metrics.evidence_coverage_ratio >= thresholds.minEvidenceCoverage &&
    metrics.orphan_evidence_event_ids.length <= thresholds.maxOrphanEvidenceIds &&
    (metrics.negative_result_recall_ratio ?? 1) >= thresholds.minNegativeResultRecall &&
    !issues.some((issue) => issue.severity === 'error');

  return {
    passed,
    metrics,
    issues,
    markdown: compileMemoryCoreEvaluationMarkdown(metrics, issues, passed),
  };
}

export function compileMemoryCoreEvaluationMarkdown(
  metrics: MemoryCoreEvaluationMetrics,
  issues: MemoryCoreEvaluationIssue[],
  passed: boolean,
): string {
  const lines = [
    '# Memory Core Evaluation',
    '',
    `Status: ${passed ? 'passed' : 'failed'}`,
    '',
    '## Metrics',
    `- Context pack tokens: ${metrics.context_pack_tokens}`,
    metrics.raw_history_tokens === undefined ? undefined : `- Raw history tokens: ${metrics.raw_history_tokens}`,
    metrics.token_reduction_ratio === undefined
      ? undefined
      : `- Token reduction ratio: ${metrics.token_reduction_ratio.toFixed(3)}`,
    `- Unsafe injections: ${metrics.unsafe_injection_count}`,
    `- Evidence coverage: ${metrics.claims_with_evidence}/${metrics.claims_checked} (${metrics.evidence_coverage_ratio.toFixed(3)})`,
    `- Orphan evidence ids: ${metrics.orphan_evidence_event_ids.length}`,
    metrics.negative_result_recall_ratio === undefined
      ? undefined
      : `- Negative result recall: ${metrics.recalled_negative_results}/${metrics.expected_negative_results} (${metrics.negative_result_recall_ratio.toFixed(3)})`,
    `- Memory units: ${metrics.active_memory_unit_count}/${metrics.memory_unit_count} active`,
    '',
    '## Issues',
    issues.length === 0
      ? '- None'
      : issues.map((issue) => `- ${issue.severity}: ${issue.code}: ${issue.message}`).join('\n'),
    '',
  ];
  return `${lines.filter((line): line is string => line !== undefined).join('\n')}\n`;
}

function buildUnitByEventId(units: MemoryUnit[]): Map<string, MemoryUnit> {
  const unitByEventId = new Map<string, MemoryUnit>();
  for (const unit of units) {
    for (const eventId of unit.source_event_ids) {
      unitByEventId.set(eventId, unit);
    }
  }
  return unitByEventId;
}

function getUnsafeInjectionReason(
  event: MemoryEvent | undefined,
  unit: MemoryUnit | undefined,
  scopeFilter: ContextPackScopeFilter,
): string | undefined {
  if (event === undefined || unit === undefined) {
    return 'Context pack included a non-canonical event id';
  }
  if (event.status === 'rejected' || unit.state === 'rejected') {
    return 'Context pack included rejected memory';
  }
  if (event.status === 'redacted' || unit.state === 'redacted') {
    return 'Context pack included redacted memory';
  }
  if (event.status === 'superseded' || unit.state === 'superseded') {
    return 'Context pack included superseded memory';
  }
  if (event.status === 'candidate' || unit.state === 'candidate') {
    return 'Context pack included candidate memory';
  }
  if (unit.scope.visibility === 'private' && !privateScopeMatches(unit, scopeFilter)) {
    return 'Context pack included private memory outside owner scope';
  }
  if (
    scopeFilter.project_id !== undefined &&
    unit.scope.project_id !== undefined &&
    unit.scope.project_id !== scopeFilter.project_id
  ) {
    return 'Context pack included memory from a different project';
  }
  if (scopeFilter.run_id !== undefined && unit.scope.run_id !== undefined && unit.scope.run_id !== scopeFilter.run_id) {
    return 'Context pack included memory from a different run';
  }
  if (scopeFilter.domain !== undefined && unit.scope.domain !== undefined && unit.scope.domain !== scopeFilter.domain) {
    return 'Context pack included memory from a different domain';
  }
  return undefined;
}

function privateScopeMatches(unit: MemoryUnit, scopeFilter: ContextPackScopeFilter): boolean {
  if (scopeFilter.user_id !== undefined && unit.scope.user_id === scopeFilter.user_id) {
    return true;
  }
  if (scopeFilter.agent_id !== undefined && unit.scope.agent_id === scopeFilter.agent_id) {
    return true;
  }
  return false;
}

function isLongTermClaim(event: MemoryEvent, claimTypes: MemoryEventType[]): boolean {
  if (!claimTypes.includes(event.type)) {
    return false;
  }
  return event.status !== 'candidate' && event.status !== 'rejected' && event.status !== 'redacted';
}

function hasVerifiedEvidence(event: MemoryEvent, eventById: Map<string, MemoryEvent>): boolean {
  return (
    (event.evidence_event_ids !== undefined && event.evidence_event_ids.some((id) => eventById.has(id))) ||
    (event.subject?.artifact_ids !== undefined && event.subject.artifact_ids.length > 0) ||
    (event.subject?.source_uris !== undefined && event.subject.source_uris.length > 0) ||
    event.subject?.commit !== undefined ||
    event.subject?.dataset !== undefined ||
    event.subject?.paper_id !== undefined
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
