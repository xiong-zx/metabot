import { deriveMemoryUnits } from './memory-curator.js';
import type { ContextPackScopeFilter, MemoryEvent, MemoryUnit, MemoryUnitKind } from './types.js';

export interface SemanticSearchQuery {
  query: string;
  limit?: number;
  scopeFilter?: ContextPackScopeFilter;
  kinds?: MemoryUnitKind[];
  includeCandidates?: boolean;
}

export interface SemanticSearchResult {
  unit: MemoryUnit;
  score: number;
  provider_id?: string;
}

export interface SemanticMemoryProvider {
  rebuildFromEvents(events: MemoryEvent[]): Promise<MemoryUnit[]>;
  search(query: SemanticSearchQuery): Promise<SemanticSearchResult[]>;
  deleteIndexOnly(unitId: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemorySemanticMemoryProvider implements SemanticMemoryProvider {
  private readonly units = new Map<string, MemoryUnit>();

  async rebuildFromEvents(events: MemoryEvent[]): Promise<MemoryUnit[]> {
    const units = deriveMemoryUnits(events, { includeRejected: true });
    await this.clear();
    this.indexCanonical(units);
    return units;
  }

  private indexCanonical(units: MemoryUnit[]): void {
    for (const unit of units) {
      this.units.set(unit.id, unit);
    }
  }

  async search(query: SemanticSearchQuery): Promise<SemanticSearchResult[]> {
    const tokens = tokenize(query.query);
    const limit = query.limit ?? 20;
    return [...this.units.values()]
      .filter((unit) => isSearchableUnit(unit, query))
      .map((unit) => ({ unit, score: scoreUnit(unit, tokens, query.scopeFilter) }))
      .filter((result) => result.score > 0 || tokens.size === 0)
      .sort((left, right) => right.score - left.score || right.unit.confidence - left.unit.confidence)
      .slice(0, limit);
  }

  async deleteIndexOnly(unitId: string): Promise<void> {
    this.units.delete(unitId);
  }

  async clear(): Promise<void> {
    this.units.clear();
  }
}

export interface Mem0CompatibleAddInput {
  text: string;
  metadata: Record<string, unknown>;
}

export interface Mem0CompatibleSearchInput {
  query: string;
  filters?: Record<string, unknown>;
  limit?: number;
}

export interface Mem0CompatibleSearchRecord {
  id?: string;
  memory?: string;
  text?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface Mem0CompatibleClient {
  add(input: Mem0CompatibleAddInput): Promise<string | { id?: string } | void>;
  search(input: Mem0CompatibleSearchInput): Promise<Mem0CompatibleSearchRecord[]>;
  delete?(id: string): Promise<void>;
}

export class Mem0SemanticMemoryProvider implements SemanticMemoryProvider {
  private readonly unitsById = new Map<string, MemoryUnit>();
  private readonly providerIdsByUnitId = new Map<string, string>();

  constructor(private readonly client: Mem0CompatibleClient) {}

  async rebuildFromEvents(events: MemoryEvent[]): Promise<MemoryUnit[]> {
    const units = deriveMemoryUnits(events, { includeRejected: true });
    await this.clear();
    for (const unit of units) {
      await this.upsertCanonical(unit);
    }
    return units;
  }

  private async upsertCanonical(unit: MemoryUnit): Promise<void> {
    const oldProviderId = this.providerIdsByUnitId.get(unit.id);
    if (oldProviderId !== undefined && this.client.delete !== undefined) {
      await this.client.delete(oldProviderId);
    }

    const response = await this.client.add({
      text: unit.text,
      metadata: memoryUnitToProviderMetadata(unit),
    });
    const providerId = extractProviderId(response) ?? unit.id;
    this.unitsById.set(unit.id, unit);
    this.providerIdsByUnitId.set(unit.id, providerId);
  }

  async search(query: SemanticSearchQuery): Promise<SemanticSearchResult[]> {
    const records = await this.client.search({
      query: query.query,
      filters: buildProviderFilters(query),
      limit: query.limit,
    });

    return records
      .map((record) => this.hydrateRecord(record))
      .filter((result): result is SemanticSearchResult => result !== undefined)
      .filter((result) => isSearchableUnit(result.unit, query))
      .filter(uniqueSearchResultByUnitId())
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit ?? 20);
  }

  async deleteIndexOnly(unitId: string): Promise<void> {
    const providerId = this.providerIdsByUnitId.get(unitId);
    if (providerId !== undefined && this.client.delete !== undefined) {
      await this.client.delete(providerId);
    }
    this.unitsById.delete(unitId);
    this.providerIdsByUnitId.delete(unitId);
  }

  async clear(): Promise<void> {
    if (this.client.delete !== undefined) {
      for (const providerId of this.providerIdsByUnitId.values()) {
        await this.client.delete(providerId);
      }
    }
    this.unitsById.clear();
    this.providerIdsByUnitId.clear();
  }

  private hydrateRecord(record: Mem0CompatibleSearchRecord): SemanticSearchResult | undefined {
    const unitId = typeof record.metadata?.memory_unit_id === 'string' ? record.metadata.memory_unit_id : record.id;
    if (unitId === undefined) {
      return undefined;
    }

    const unit = this.unitsById.get(unitId);
    if (unit === undefined) {
      return undefined;
    }

    return {
      unit,
      score: typeof record.score === 'number' ? record.score : 0,
      provider_id: record.id,
    };
  }
}

export async function rebuildSemanticIndexFromEvents(
  provider: SemanticMemoryProvider,
  events: MemoryEvent[],
): Promise<MemoryUnit[]> {
  return provider.rebuildFromEvents(events);
}

export function memoryUnitToProviderMetadata(unit: MemoryUnit): Record<string, unknown> {
  return {
    memory_unit_id: unit.id,
    kind: unit.kind,
    state: unit.state,
    confidence: unit.confidence,
    source_event_ids: unit.source_event_ids,
    evidence_event_ids: unit.evidence_event_ids,
    project_id: unit.scope.project_id,
    run_id: unit.scope.run_id,
    agent_id: unit.scope.agent_id,
    user_id: unit.scope.user_id,
    domain: unit.scope.domain,
    visibility: unit.scope.visibility,
    tags: unit.tags,
  };
}

function buildProviderFilters(query: SemanticSearchQuery): Record<string, unknown> {
  return compactRecord({
    kinds: query.kinds,
    project_id: query.scopeFilter?.project_id,
    run_id: query.scopeFilter?.run_id,
    agent_id: query.scopeFilter?.agent_id,
    user_id: query.scopeFilter?.user_id,
    domain: query.scopeFilter?.domain,
    include_visibilities: query.scopeFilter?.include_visibilities,
    include_candidates: query.includeCandidates === true,
  });
}

function extractProviderId(response: string | { id?: string } | void): string | undefined {
  if (typeof response === 'string') {
    return response;
  }
  if (response !== undefined && typeof response.id === 'string') {
    return response.id;
  }
  return undefined;
}

function isSearchableUnit(unit: MemoryUnit, query: SemanticSearchQuery): boolean {
  if (query.kinds !== undefined && !query.kinds.includes(unit.kind)) {
    return false;
  }

  if (unit.state === 'rejected' || unit.state === 'redacted' || unit.state === 'superseded') {
    return false;
  }
  if (unit.state === 'candidate' && query.includeCandidates !== true) {
    return false;
  }

  return matchesScope(unit, query.scopeFilter);
}

function matchesScope(unit: MemoryUnit, scopeFilter: ContextPackScopeFilter | undefined): boolean {
  if (scopeFilter === undefined) {
    return unit.scope.visibility !== 'private';
  }

  if (
    scopeFilter.include_visibilities !== undefined &&
    !scopeFilter.include_visibilities.includes(unit.scope.visibility)
  ) {
    return false;
  }

  if (unit.scope.visibility === 'private' && !matchesPrivateOwner(unit, scopeFilter)) {
    return false;
  }

  if (
    scopeFilter.project_id !== undefined &&
    unit.scope.project_id !== undefined &&
    unit.scope.project_id !== scopeFilter.project_id
  ) {
    return false;
  }
  if (scopeFilter.run_id !== undefined && unit.scope.run_id !== undefined && unit.scope.run_id !== scopeFilter.run_id) {
    return false;
  }
  if (scopeFilter.domain !== undefined && unit.scope.domain !== undefined && unit.scope.domain !== scopeFilter.domain) {
    return false;
  }

  return true;
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

function scoreUnit(
  unit: MemoryUnit,
  queryTokens: Set<string>,
  scopeFilter: ContextPackScopeFilter | undefined,
): number {
  let score = unit.confidence;
  if (scopeFilter?.project_id !== undefined && unit.scope.project_id === scopeFilter.project_id) {
    score += 2;
  }
  if (scopeFilter?.domain !== undefined && unit.scope.domain === scopeFilter.domain) {
    score += 1;
  }

  const unitTokens = tokenize(`${unit.summary}\n${unit.text}\n${unit.tags.join(' ')}`);
  for (const token of queryTokens) {
    if (unitTokens.has(token)) {
      score += 2;
    }
  }
  return score;
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

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function uniqueSearchResultByUnitId(): (result: SemanticSearchResult) => boolean {
  const seen = new Set<string>();
  return (result) => {
    if (seen.has(result.unit.id)) {
      return false;
    }
    seen.add(result.unit.id);
    return true;
  };
}
