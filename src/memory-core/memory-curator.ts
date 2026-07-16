import type { MemoryEvent, MemoryUnit, MemoryUnitKind, MemoryUnitState } from './types.js';

export interface DeriveMemoryUnitsOptions {
  includeRejected?: boolean;
}

export function deriveMemoryUnits(events: MemoryEvent[], options: DeriveMemoryUnitsOptions = {}): MemoryUnit[] {
  const supersededBy = buildSupersededBy(events);
  const redactedEventIds = buildRedactedEventIds(events);

  return events
    .map((event) => deriveMemoryUnit(event, supersededBy.get(event.id), redactedEventIds.has(event.id), options))
    .filter((unit): unit is MemoryUnit => unit !== undefined);
}

export function buildSupersededBy(events: MemoryEvent[]): Map<string, string> {
  const supersededBy = new Map<string, string>();
  for (const event of events) {
    if (
      event.supersedes !== undefined &&
      isSupersedingEvent(event) &&
      (event.status === undefined || event.status === 'live' || event.status === 'approved')
    ) {
      supersededBy.set(event.supersedes, event.id);
    }
  }
  return supersededBy;
}

function isSupersedingEvent(event: MemoryEvent): boolean {
  return (
    event.type === 'memory_superseded' ||
    event.type === 'memory_redacted' ||
    event.type === 'approval_granted' ||
    event.type === 'approval_rejected' ||
    (event.status === 'approved' && typeof event.metadata?.autoresearchclaw_approved_by_review_event_id === 'string')
  );
}

export function buildRedactedEventIds(events: MemoryEvent[]): Set<string> {
  const lineage = buildPromotionLineage(events);
  const redacted = new Set<string>();
  for (const event of events) {
    if (
      event.type === 'memory_redacted' &&
      event.supersedes !== undefined &&
      (event.status === undefined || event.status === 'live' || event.status === 'approved')
    ) {
      for (const eventId of connectedLineageIds(event.supersedes, lineage)) {
        redacted.add(eventId);
      }
    }
  }
  return redacted;
}

function buildPromotionLineage(events: MemoryEvent[]): Map<string, Set<string>> {
  const lineage = new Map<string, Set<string>>();
  for (const event of events) {
    const promotedFrom = event.metadata?.promoted_from_event_id;
    if (typeof promotedFrom !== 'string' || promotedFrom.trim().length === 0) {
      const targetEventId = event.metadata?.target_event_id;
      if (typeof targetEventId === 'string' && targetEventId.trim().length > 0) {
        connectLineage(lineage, event.id, targetEventId.trim());
      }
      continue;
    }
    connectLineage(lineage, event.id, promotedFrom.trim());
    const targetEventId = event.metadata?.target_event_id;
    if (typeof targetEventId === 'string' && targetEventId.trim().length > 0) {
      connectLineage(lineage, event.id, targetEventId.trim());
    }
  }
  return lineage;
}

function connectLineage(lineage: Map<string, Set<string>>, left: string, right: string): void {
  if (!lineage.has(left)) {
    lineage.set(left, new Set());
  }
  if (!lineage.has(right)) {
    lineage.set(right, new Set());
  }
  lineage.get(left)!.add(right);
  lineage.get(right)!.add(left);
}

function connectedLineageIds(start: string, lineage: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of lineage.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

function deriveMemoryUnit(
  event: MemoryEvent,
  supersededBy: string | undefined,
  redactedByPolicy: boolean,
  options: DeriveMemoryUnitsOptions,
): MemoryUnit | undefined {
  if (event.status === 'redacted' || redactedByPolicy) {
    return undefined;
  }

  if (event.status === 'rejected' && options.includeRejected !== true) {
    return undefined;
  }

  const kind = deriveKind(event);
  if (kind === undefined) {
    return undefined;
  }

  const state = deriveState(event, supersededBy);
  return {
    id: `mem_unit_${event.id}`,
    kind,
    text: event.body ? `${event.summary}\n\n${event.body}` : event.summary,
    summary: event.summary,
    source_event_ids: [event.id],
    evidence_event_ids: event.evidence_event_ids ?? [],
    scope: {
      project_id: event.scope.project_id,
      run_id: event.scope.run_id,
      agent_id: event.scope.agent_id,
      user_id: event.actor.kind === 'user' ? event.actor.id : undefined,
      domain: event.scope.domain,
      visibility: event.scope.visibility,
    },
    state,
    confidence: deriveConfidence(event),
    tags: deriveTags(event),
    supersedes: event.supersedes,
    superseded_by: supersededBy,
    created_at: event.timestamp,
    updated_at: event.timestamp,
  };
}

function deriveKind(event: MemoryEvent): MemoryUnitKind | undefined {
  switch (event.type) {
    case 'attempt':
      return event.outcome === 'failed' ? 'negative_result' : 'lesson';
    case 'negative_result':
    case 'worker_failed':
      return 'negative_result';
    case 'decision':
    case 'pivot':
      return 'decision';
    case 'fix':
    case 'finding':
    case 'experiment_result':
    case 'metric_observed':
    case 'literature_observation':
    case 'artifact_created':
      return 'fact';
    case 'hypothesis':
      return 'claim';
    case 'research_plan':
      return 'method';
    case 'open_question':
    case 'issue':
      return 'open_question';
    case 'note':
    case 'agent_instruction':
    case 'metamemory_human_edit':
      return inferNoteKind(event);
    default:
      return undefined;
  }
}

function inferNoteKind(event: MemoryEvent): MemoryUnitKind {
  const text = `${event.summary}\n${event.body ?? ''}`.toLowerCase();
  if (
    text.includes('must') ||
    text.includes('never') ||
    text.includes('constraint') ||
    text.includes('必须') ||
    text.includes('禁止')
  ) {
    return 'constraint';
  }
  if (text.includes('prefer') || text.includes('preference') || text.includes('希望') || text.includes('偏好')) {
    return 'preference';
  }
  return 'lesson';
}

function deriveState(event: MemoryEvent, supersededBy: string | undefined): MemoryUnitState {
  if (supersededBy !== undefined || event.status === 'superseded') {
    return 'superseded';
  }

  switch (event.status) {
    case 'candidate':
      return 'candidate';
    case 'rejected':
      return 'rejected';
    case 'redacted':
      return 'redacted';
    case 'approved':
    case 'live':
    case undefined:
      return 'active';
  }
}

function deriveConfidence(event: MemoryEvent): number {
  if (event.confidence !== undefined) {
    return clampConfidence(event.confidence);
  }

  if (event.status === 'candidate') {
    return 0.4;
  }

  switch (event.type) {
    case 'fix':
    case 'finding':
    case 'experiment_result':
    case 'metric_observed':
      return 0.85;
    case 'negative_result':
    case 'attempt':
      return event.outcome === 'failed' ? 0.8 : 0.65;
    case 'decision':
    case 'pivot':
      return 0.75;
    case 'hypothesis':
      return 0.55;
    default:
      return event.status === 'approved' ? 0.9 : 0.6;
  }
}

function deriveTags(event: MemoryEvent): string[] {
  const tags = new Set<string>([event.type]);
  if (event.outcome !== undefined) {
    tags.add(`outcome:${event.outcome}`);
  }
  if (event.scope.domain !== undefined) {
    tags.add(`domain:${event.scope.domain}`);
  }
  if (event.scope.visibility !== undefined) {
    tags.add(`visibility:${event.scope.visibility}`);
  }
  return [...tags];
}

function clampConfidence(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
