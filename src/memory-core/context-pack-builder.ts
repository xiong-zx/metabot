import { randomUUID } from 'node:crypto';
import { deriveMemoryUnits } from './memory-curator.js';
import type {
  ContextPack,
  ContextPackPurpose,
  ContextPackScopeFilter,
  MemoryEvent,
  MemoryUnit,
  MemoryUnitKind,
} from './types.js';

export interface BuildContextPackInput {
  purpose: ContextPackPurpose;
  query: string;
  tokenBudget: number;
  events: MemoryEvent[];
  memoryUnits?: MemoryUnit[];
  scopeFilter?: ContextPackScopeFilter;
  includeCandidates?: boolean;
  now?: Date;
}

interface ScoredMemoryUnit {
  unit: MemoryUnit;
  score: number;
}

interface CanonicalMemoryIndex {
  eventsById: Map<string, MemoryEvent>;
  unitsById: Map<string, MemoryUnit>;
  unitsByEventId: Map<string, MemoryUnit>;
}

const SECTION_TITLES: Record<MemoryUnitKind, string> = {
  fact: 'Project Facts',
  claim: 'Hypotheses / Claims',
  method: 'Useful Methods',
  decision: 'Active Decisions',
  lesson: 'Relevant Lessons',
  negative_result: 'Known Failed Attempts / Negative Results',
  constraint: 'Constraints',
  preference: 'Preferences',
  open_question: 'Open Questions',
};

export function buildContextPack(input: BuildContextPackInput): ContextPack {
  const scopeFilter = input.scopeFilter ?? {};
  const canonicalUnits = deriveMemoryUnits(input.events, { includeRejected: true });
  const canonicalIndex = createCanonicalMemoryIndex(input.events, canonicalUnits);
  const units = canonicalizeMemoryUnits(input.memoryUnits ?? canonicalUnits, canonicalIndex);
  const excluded = new Map<string, string>();
  const queryTokens = tokenize(input.query);
  const tokenBudget = Math.max(0, input.tokenBudget);
  const eligible = units
    .map((unit) => {
      const reason = getExclusionReason(unit, scopeFilter, input.includeCandidates === true, canonicalIndex);
      if (reason !== undefined) {
        excluded.set(unit.id, reason);
        for (const eventId of unit.source_event_ids) {
          excluded.set(eventId, reason);
        }
        return undefined;
      }
      return {
        unit,
        score: scoreMemoryUnit(unit, queryTokens, scopeFilter),
      };
    })
    .filter((item): item is ScoredMemoryUnit => item !== undefined)
    .sort((left, right) => right.score - left.score || right.unit.confidence - left.unit.confidence);

  const selected: MemoryUnit[] = [];

  for (const { unit } of eligible) {
    const prospective = [...selected, unit];
    if (estimateTokens(buildMarkdown(input.purpose, input.query, prospective)) > tokenBudget) {
      excluded.set(unit.id, 'token_budget_exceeded');
      continue;
    }
    selected.push(unit);
  }

  const includedEventIds = unique(selected.flatMap((unit) => unit.source_event_ids));
  const includedUnitIds = selected.map((unit) => unit.id);
  const markdown = buildMarkdown(input.purpose, input.query, selected, tokenBudget);
  const sourceIndex = [
    ...selected.map((unit) => ({
      id: unit.id,
      type: 'memory_unit' as const,
      title: unit.summary,
    })),
    ...input.events
      .filter((event) => includedEventIds.includes(event.id))
      .map((event) => ({
        id: event.id,
        type: 'event' as const,
        title: event.summary,
      })),
  ];

  return {
    id: `ctx_${randomUUID()}`,
    purpose: input.purpose,
    query: input.query,
    token_budget: tokenBudget,
    scope_filter: scopeFilter,
    included_event_ids: includedEventIds,
    included_memory_unit_ids: includedUnitIds,
    excluded_ids: [...excluded.entries()].map(([id, reason]) => ({ id, reason })),
    markdown,
    source_index: sourceIndex,
    created_at: (input.now ?? new Date()).toISOString(),
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getExclusionReason(
  unit: MemoryUnit,
  scopeFilter: ContextPackScopeFilter,
  includeCandidates: boolean,
  canonicalIndex: CanonicalMemoryIndex,
): string | undefined {
  const canonicalReason = getCanonicalExclusionReason(unit, includeCandidates, canonicalIndex);
  if (canonicalReason !== undefined) {
    return canonicalReason;
  }

  if (unit.state === 'rejected' || unit.state === 'redacted' || unit.state === 'superseded') {
    return `${unit.state}_memory`;
  }

  if (unit.state === 'candidate' && !includeCandidates) {
    return 'candidate_memory_requires_review';
  }

  if (
    scopeFilter.include_visibilities !== undefined &&
    !scopeFilter.include_visibilities.includes(unit.scope.visibility)
  ) {
    return 'visibility_not_requested';
  }

  if (unit.scope.visibility === 'private' && !matchesPrivateOwner(unit, scopeFilter)) {
    return 'private_scope_mismatch';
  }

  const scopeMismatchReason = getScopeMismatchReason(unit, scopeFilter);
  if (scopeMismatchReason !== undefined) {
    return scopeMismatchReason;
  }

  if (
    unit.scope.visibility === 'project' &&
    scopeFilter.project_id !== undefined &&
    unit.scope.project_id !== scopeFilter.project_id
  ) {
    return 'project_scope_mismatch';
  }

  if (
    unit.scope.visibility === 'domain' &&
    scopeFilter.domain !== undefined &&
    unit.scope.domain !== scopeFilter.domain
  ) {
    return 'domain_scope_mismatch';
  }

  if (
    unit.scope.visibility === 'global' ||
    unit.scope.visibility === 'domain' ||
    unit.scope.visibility === 'project' ||
    unit.scope.visibility === 'private'
  ) {
    return undefined;
  }

  return 'unsupported_visibility';
}

function createCanonicalMemoryIndex(events: MemoryEvent[], units: MemoryUnit[]): CanonicalMemoryIndex {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const unitsByEventId = new Map<string, MemoryUnit>();

  for (const unit of units) {
    for (const eventId of unit.source_event_ids) {
      unitsByEventId.set(eventId, unit);
    }
  }

  return { eventsById, unitsById, unitsByEventId };
}

function canonicalizeMemoryUnits(units: MemoryUnit[], canonicalIndex: CanonicalMemoryIndex): MemoryUnit[] {
  return units.map((unit) => findCanonicalProjection(unit, canonicalIndex) ?? unit);
}

function findCanonicalProjection(unit: MemoryUnit, canonicalIndex: CanonicalMemoryIndex): MemoryUnit | undefined {
  const byId = canonicalIndex.unitsById.get(unit.id);
  if (byId !== undefined) {
    return byId;
  }

  for (const eventId of unit.source_event_ids) {
    const byEvent = canonicalIndex.unitsByEventId.get(eventId);
    if (byEvent !== undefined) {
      return byEvent;
    }
  }

  return undefined;
}

function getCanonicalExclusionReason(
  unit: MemoryUnit,
  includeCandidates: boolean,
  canonicalIndex: CanonicalMemoryIndex,
): string | undefined {
  if (unit.source_event_ids.length === 0) {
    return 'non_canonical_memory_unit';
  }

  for (const eventId of unit.source_event_ids) {
    const event = canonicalIndex.eventsById.get(eventId);
    if (event === undefined) {
      return 'non_canonical_memory_unit';
    }

    if (event.status === 'redacted') {
      return 'redacted_memory';
    }
    if (event.status === 'rejected') {
      return 'rejected_memory';
    }

    const canonicalUnit = canonicalIndex.unitsByEventId.get(eventId);
    if (canonicalUnit === undefined) {
      return 'non_projected_memory_unit';
    }

    if (canonicalUnit.state === 'superseded') {
      return 'superseded_memory';
    }
    if (canonicalUnit.state === 'candidate' && !includeCandidates) {
      return 'candidate_memory_requires_review';
    }
  }

  return undefined;
}

function getScopeMismatchReason(unit: MemoryUnit, scopeFilter: ContextPackScopeFilter): string | undefined {
  if (
    scopeFilter.project_id !== undefined &&
    unit.scope.project_id !== undefined &&
    unit.scope.project_id !== scopeFilter.project_id
  ) {
    return 'project_scope_mismatch';
  }

  if (scopeFilter.run_id !== undefined && unit.scope.run_id !== undefined && unit.scope.run_id !== scopeFilter.run_id) {
    return 'run_scope_mismatch';
  }

  if (scopeFilter.domain !== undefined && unit.scope.domain !== undefined && unit.scope.domain !== scopeFilter.domain) {
    return 'domain_scope_mismatch';
  }

  return undefined;
}

function matchesPrivateOwner(unit: MemoryUnit, scopeFilter: ContextPackScopeFilter): boolean {
  if (scopeFilter.user_id !== undefined && unit.scope.user_id === scopeFilter.user_id) {
    return true;
  }
  if (scopeFilter.agent_id !== undefined && unit.scope.agent_id === scopeFilter.agent_id) {
    return true;
  }
  return false;
}

function scoreMemoryUnit(unit: MemoryUnit, queryTokens: Set<string>, scopeFilter: ContextPackScopeFilter): number {
  let score = kindBaseScore(unit.kind) + unit.confidence * 2;
  if (scopeFilter.project_id !== undefined && unit.scope.project_id === scopeFilter.project_id) {
    score += 4;
  }
  if (scopeFilter.domain !== undefined && unit.scope.domain === scopeFilter.domain) {
    score += 2;
  }

  const unitTokens = tokenize(`${unit.summary}\n${unit.text}\n${unit.tags.join(' ')}`);
  for (const token of queryTokens) {
    if (unitTokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function kindBaseScore(kind: MemoryUnitKind): number {
  switch (kind) {
    case 'negative_result':
      return 8;
    case 'decision':
    case 'constraint':
      return 7;
    case 'lesson':
    case 'method':
      return 6;
    case 'fact':
      return 5;
    case 'preference':
      return 4;
    case 'claim':
      return 3;
    case 'open_question':
      return 2;
  }
}

function buildMarkdown(purpose: ContextPackPurpose, query: string, units: MemoryUnit[], tokenBudget?: number): string {
  const sections = [`## Objective\n${query.trim() || purpose}`];
  for (const kind of Object.keys(SECTION_TITLES) as MemoryUnitKind[]) {
    const sectionUnits = units.filter((unit) => unit.kind === kind);
    if (sectionUnits.length === 0) {
      continue;
    }
    sections.push(`## ${SECTION_TITLES[kind]}\n${sectionUnits.map(formatMemoryUnit).join('\n')}`);
  }

  if (units.length > 0) {
    const sourceLines = units.map((unit) => `- ${unit.id}: events ${unit.source_event_ids.join(', ')}`).join('\n');
    sections.push(`## Source Index\n${sourceLines}`);
  }

  const markdown = `${sections.join('\n\n')}\n`;
  if (tokenBudget !== undefined && units.length === 0 && estimateTokens(markdown) > tokenBudget) {
    return truncateMarkdown(markdown, tokenBudget);
  }
  return markdown;
}

function formatMemoryUnit(unit: MemoryUnit): string {
  return `- [${unit.id}] ${unit.summary} (confidence: ${unit.confidence.toFixed(2)}, events: ${unit.source_event_ids.join(', ')})`;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fa5]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncateMarkdown(markdown: string, tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  if (charBudget <= 0) {
    return '';
  }
  if (markdown.length <= charBudget) {
    return markdown;
  }
  return `${markdown.slice(0, charBudget - 1).trimEnd()}\n`;
}
