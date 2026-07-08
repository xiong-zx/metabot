import { createHash } from 'node:crypto';
import { MemoryCoreError, MemoryEventLedger } from './event-ledger.js';
import { buildContextPack } from './context-pack-builder.js';
import { buildRedactedEventIds, deriveMemoryUnits } from './memory-curator.js';
import { autoResearchClawOutputToMemoryEvents, type AutoResearchClawOutput } from './autoresearchclaw-contract.js';
import { evaluateMemoryCore, type MemoryCoreEvaluationInput } from './memory-evaluator.js';
import { InMemorySemanticMemoryProvider, type SemanticSearchQuery } from './semantic-provider.js';
import type {
  AppendMemoryEventInput,
  ContextPack,
  ContextPackPurpose,
  ContextPackScopeFilter,
  MemoryActor,
  MemoryEvent,
  MemoryEventType,
  MemoryScope,
  MemoryUnit,
  MemoryVisibility,
} from './types.js';

export interface MemoryCoreServiceOptions {
  rootDir: string;
}

export interface CreateServiceContextPackInput {
  purpose: ContextPackPurpose;
  query: string;
  tokenBudget: number;
  scopeFilter?: ContextPackScopeFilter;
  includeCandidates?: boolean;
  actor?: MemoryActor;
  scope?: MemoryScope;
  now?: Date;
}

export interface IngestAutoResearchClawOutputInput {
  output: AutoResearchClawOutput | unknown;
  actor: MemoryActor;
  scope: MemoryScope;
  workerEventId?: string;
  timestamp?: string;
  reviewRequired?: boolean;
}

export type LogMemoryEventInput = AppendMemoryEventInput;

export interface PromotionRequestInput {
  targetEventId: string;
  targetVisibility: MemoryVisibility;
  targetDomain?: string;
  actor: MemoryActor;
  scope: MemoryScope;
  reason?: string;
}

export interface ApprovePromotionInput {
  requestEventId: string;
  actor: MemoryActor;
  scope: MemoryScope;
  reason?: string;
}

export interface RejectPromotionInput {
  requestEventId: string;
  actor: MemoryActor;
  scope: MemoryScope;
  reason?: string;
}

export interface SupersedeMemoryInput {
  targetEventId: string;
  replacementEventId?: string;
  actor: MemoryActor;
  scope: MemoryScope;
  reason?: string;
}

export interface RedactMemoryInput {
  targetEventId: string;
  actor: MemoryActor;
  scope: MemoryScope;
  reason?: string;
}

export class MemoryCoreService {
  private readonly ledger: MemoryEventLedger;
  private readonly rootDir: string;

  constructor(options: MemoryCoreServiceOptions) {
    this.rootDir = options.rootDir;
    this.ledger = new MemoryEventLedger(options.rootDir);
  }

  appendEvent(input: AppendMemoryEventInput): MemoryEvent {
    return this.ledger.append(input);
  }

  logEvent(input: LogMemoryEventInput): MemoryEvent {
    validateControlledLogEvent(input);
    return this.ledger.append({
      ...input,
      status: input.status ?? 'live',
    });
  }

  readEvents(): MemoryEvent[] {
    return sanitizeRedactedEvents(this.readRawEvents());
  }

  readRawEvents(): MemoryEvent[] {
    return this.ledger.readAll();
  }

  deriveUnits(): MemoryUnit[] {
    return deriveMemoryUnits(this.readEvents()).filter((unit) => unit.state === 'active');
  }

  async search(query: SemanticSearchQuery): Promise<Array<{ unit: MemoryUnit; score: number }>> {
    const provider = new InMemorySemanticMemoryProvider();
    await provider.rebuildFromEvents(this.readEvents());
    return provider.search(query);
  }

  createContextPack(input: CreateServiceContextPackInput): { contextPack: ContextPack; event?: MemoryEvent } {
    const events = this.readEvents();
    const contextPack = buildContextPack({
      purpose: input.purpose,
      query: input.query,
      tokenBudget: input.tokenBudget,
      events,
      scopeFilter: input.scopeFilter,
      includeCandidates: input.includeCandidates,
      now: input.now,
    });

    if (input.actor === undefined || input.scope === undefined) {
      return { contextPack };
    }

    const event = this.appendEvent({
      id: stableServiceEventId('context_pack_created', contextPack.id),
      type: 'context_pack_created',
      summary: `Context pack created: ${input.query}`,
      timestamp: input.now?.toISOString(),
      actor: input.actor,
      scope: input.scope,
      evidence_event_ids: contextPack.included_event_ids,
      metadata: {
        context_pack_id: contextPack.id,
        purpose: contextPack.purpose,
        token_budget: contextPack.token_budget,
        included_memory_unit_ids: contextPack.included_memory_unit_ids,
      },
    });
    return { contextPack, event };
  }

  ingestAutoResearchClawOutput(input: IngestAutoResearchClawOutputInput): MemoryEvent[] {
    validateIngestScope(input.scope);
    const events = autoResearchClawOutputToMemoryEvents(input.output, {
      actor: input.actor,
      scope: input.scope,
      workerEventId: input.workerEventId,
      timestamp: input.timestamp,
      defaultStatus: input.reviewRequired === true ? 'candidate' : undefined,
      stagedForReview: input.reviewRequired === true,
      projectRoot: this.rootDir,
    });
    return events.map((event) => this.appendEvent(event));
  }

  evaluate(input: Omit<MemoryCoreEvaluationInput, 'events'>) {
    return evaluateMemoryCore({
      ...input,
      events: this.readEvents(),
    });
  }

  requestPromotion(input: PromotionRequestInput): MemoryEvent {
    const target = this.requirePromotableEvent(input.targetEventId);
    validatePromotionTarget(target, input.targetVisibility, input.targetDomain);
    return this.appendEvent({
      id: stableServiceEventId(
        'approval_requested',
        target.id,
        input.targetVisibility,
        input.targetDomain ?? '',
        input.reason ?? '',
      ),
      type: 'approval_requested',
      summary: `Promotion requested for memory event: ${target.summary}`,
      body: input.reason,
      actor: input.actor,
      scope: input.scope,
      evidence_event_ids: [target.id],
      status: 'candidate',
      metadata: {
        target_event_id: target.id,
        target_visibility: input.targetVisibility,
        target_domain: input.targetDomain,
      },
    });
  }

  approvePromotion(input: ApprovePromotionInput): { approvalEvent: MemoryEvent; promotedEvent: MemoryEvent } {
    const request = this.requirePromotionRequest(input.requestEventId);
    const targetEventId = requireMetadataString(request, 'target_event_id');
    const targetVisibility = requireMetadataString(request, 'target_visibility') as MemoryVisibility;
    const targetDomain = optionalMetadataString(request, 'target_domain');
    const target = this.requirePromotableEvent(targetEventId);
    validatePromotionTarget(target, targetVisibility, targetDomain);
    validateAuthority(input.scope, targetVisibility);

    const approvalEvent = this.appendEvent({
      id: stableServiceEventId('approval_granted', request.id, target.id, input.reason ?? ''),
      type: 'approval_granted',
      summary: `Promotion approved for memory event: ${target.summary}`,
      body: input.reason,
      actor: input.actor,
      scope: input.scope,
      evidence_event_ids: [request.id, target.id],
      supersedes: request.id,
      metadata: {
        target_event_id: target.id,
        target_visibility: targetVisibility,
        target_domain: targetDomain,
        approval_request_event_id: request.id,
      },
    });

    const promotedEvent = this.appendEvent({
      id: stableServiceEventId('memory_promoted', target.id, approvalEvent.id, targetVisibility, targetDomain ?? ''),
      type: target.type,
      summary: target.summary,
      body: target.body,
      timestamp: approvalEvent.timestamp,
      actor: input.actor,
      scope: {
        ...target.scope,
        visibility: targetVisibility,
        domain: targetDomain ?? target.scope.domain,
        run_id: undefined,
        worker_id: undefined,
      },
      subject: target.subject,
      outcome: target.outcome,
      confidence: Math.max(target.confidence ?? 0.7, 0.85),
      evidence_event_ids: [...new Set([approvalEvent.id, target.id, ...(target.evidence_event_ids ?? [])])],
      status: 'approved',
      metadata: {
        ...(target.metadata ?? {}),
        promoted_from_event_id: target.id,
        promotion_approval_event_id: approvalEvent.id,
      },
    });
    return { approvalEvent, promotedEvent };
  }

  rejectPromotion(input: RejectPromotionInput): MemoryEvent {
    const request = this.requirePromotionRequest(input.requestEventId);
    const targetVisibility = requireMetadataString(request, 'target_visibility') as MemoryVisibility;
    validateAuthority(input.scope, targetVisibility);
    return this.appendEvent({
      id: stableServiceEventId('approval_rejected', request.id, input.reason ?? ''),
      type: 'approval_rejected',
      summary: `Promotion rejected for memory event: ${requireMetadataString(request, 'target_event_id')}`,
      body: input.reason,
      actor: input.actor,
      scope: input.scope,
      evidence_event_ids: [request.id],
      supersedes: request.id,
      status: 'approved',
      metadata: {
        target_event_id: requireMetadataString(request, 'target_event_id'),
        approval_request_event_id: request.id,
      },
    });
  }

  supersede(input: SupersedeMemoryInput): MemoryEvent {
    const target = this.requireActiveEvent(input.targetEventId);
    validateAuthority(input.scope, target.scope.visibility);
    const replacement =
      input.replacementEventId === undefined ? undefined : this.requireActiveEvent(input.replacementEventId);
    if (replacement !== undefined) {
      validateReplacementCompatibility(target, replacement);
    }
    return this.appendEvent({
      id: stableServiceEventId(
        'memory_superseded',
        input.targetEventId,
        input.replacementEventId ?? '',
        input.reason ?? '',
      ),
      type: 'memory_superseded',
      summary: `Memory superseded: ${input.targetEventId}`,
      body: input.reason,
      actor: input.actor,
      scope: input.scope,
      evidence_event_ids: [input.targetEventId, input.replacementEventId].filter((id): id is string => Boolean(id)),
      supersedes: input.targetEventId,
      status: 'approved',
      metadata: {
        target_event_id: input.targetEventId,
        replacement_event_id: input.replacementEventId,
      },
    });
  }

  redact(input: RedactMemoryInput): MemoryEvent {
    const target = this.requireActiveEvent(input.targetEventId);
    if (input.actor.kind !== 'user' && input.actor.kind !== 'system') {
      throw new MemoryCoreError('redaction_requires_admin_actor', 'Redaction requires a user or system actor');
    }
    validateAuthority(input.scope, target.scope.visibility);
    return this.appendEvent({
      id: stableServiceEventId('memory_redacted', input.targetEventId, input.reason ?? ''),
      type: 'memory_redacted',
      summary: `Memory redacted: ${input.targetEventId}`,
      body: input.reason,
      actor: input.actor,
      scope: target.scope,
      evidence_event_ids: [input.targetEventId],
      supersedes: input.targetEventId,
      status: 'approved',
      metadata: {
        target_event_id: input.targetEventId,
      },
    });
  }

  private requireEvent(id: string): MemoryEvent {
    const event = this.ledger.findById(id);
    if (event === undefined) {
      throw new MemoryCoreError('memory_event_not_found', `Memory event not found: ${id}`);
    }
    return event;
  }

  private requireActiveEvent(id: string): MemoryEvent {
    const event = this.requireEvent(id);
    const sanitized = this.readEvents().find((candidate) => candidate.id === id);
    if (sanitized === undefined || sanitized.status === 'redacted') {
      throw new MemoryCoreError('memory_event_redacted', `Memory event has been redacted: ${id}`);
    }
    const unit = deriveMemoryUnits(this.readEvents(), { includeRejected: true }).find((candidate) =>
      candidate.source_event_ids.includes(id),
    );
    if (unit !== undefined && unit.state !== 'active') {
      throw new MemoryCoreError('memory_event_not_active', `Memory event is not active: ${id}`);
    }
    if (event.status === 'candidate' || event.status === 'rejected' || event.status === 'superseded') {
      throw new MemoryCoreError('memory_event_not_active', `Memory event is not active: ${id}`);
    }
    if (event.status === 'redacted') {
      throw new MemoryCoreError('memory_event_redacted', `Memory event has been redacted: ${id}`);
    }
    return event;
  }

  private requirePromotableEvent(id: string): MemoryEvent {
    const event = this.requireActiveEvent(id);
    if (isAdministrativeEventType(event.type)) {
      throw new MemoryCoreError('memory_event_not_promotable', `Memory event cannot be promoted: ${id}`);
    }
    return event;
  }

  private requirePromotionRequest(id: string): MemoryEvent {
    const request = this.requireEvent(id);
    if (request.type !== 'approval_requested') {
      throw new MemoryCoreError('invalid_approval_request', `Event is not a promotion request: ${id}`);
    }
    const closingDecision = this.readEvents().find(
      (event) =>
        event.supersedes === id &&
        (event.type === 'approval_granted' || event.type === 'approval_rejected') &&
        (event.status === undefined || event.status === 'live' || event.status === 'approved'),
    );
    if (closingDecision !== undefined) {
      throw new MemoryCoreError('approval_request_not_active', `Promotion request is no longer active: ${id}`);
    }
    const unit = deriveMemoryUnits(this.readEvents(), { includeRejected: true }).find((candidate) =>
      candidate.source_event_ids.includes(id),
    );
    if (unit !== undefined && unit.state !== 'active' && unit.state !== 'candidate') {
      throw new MemoryCoreError('approval_request_not_active', `Promotion request is no longer active: ${id}`);
    }
    if (request.status === 'rejected' || request.status === 'redacted' || request.status === 'superseded') {
      throw new MemoryCoreError('approval_request_not_active', `Promotion request is no longer active: ${id}`);
    }
    requireMetadataString(request, 'target_event_id');
    requireMetadataString(request, 'target_visibility');
    return request;
  }
}

const ADMINISTRATIVE_EVENT_TYPES = new Set<MemoryEventType>([
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

const CONTROLLED_LOG_DENIED_TYPES = new Set<MemoryEventType>([
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'memory_promoted',
  'memory_superseded',
  'memory_redacted',
  'context_pack_created',
]);

const VISIBILITY_RANK: Record<MemoryVisibility, number> = {
  private: 0,
  project: 1,
  domain: 2,
  global: 3,
};

function validateControlledLogEvent(input: LogMemoryEventInput): void {
  if (CONTROLLED_LOG_DENIED_TYPES.has(input.type)) {
    throw new MemoryCoreError(
      'event_type_requires_controlled_endpoint',
      `${input.type} requires a controlled endpoint`,
    );
  }
  if (input.id !== undefined) {
    throw new MemoryCoreError('event_id_not_allowed', 'Controlled log API does not accept caller-provided event ids');
  }
  if (input.supersedes !== undefined) {
    throw new MemoryCoreError('supersedes_not_allowed', 'Controlled log API cannot supersede memory');
  }
  if (input.status !== undefined && input.status !== 'live' && input.status !== 'candidate') {
    throw new MemoryCoreError('event_status_not_allowed', 'Controlled log API only accepts live or candidate status');
  }
  if (input.scope.visibility === 'domain' || input.scope.visibility === 'global') {
    throw new MemoryCoreError('visibility_requires_promotion', 'Domain/global memory requires promotion approval');
  }
}

function validateIngestScope(scope: MemoryScope): void {
  if (scope.visibility === 'domain' || scope.visibility === 'global') {
    throw new MemoryCoreError(
      'visibility_requires_promotion',
      'AutoResearchClaw ingest cannot directly create domain/global memory',
    );
  }
}

function validatePromotionTarget(
  target: MemoryEvent,
  targetVisibility: MemoryVisibility,
  targetDomain: string | undefined,
): void {
  if (!(targetVisibility in VISIBILITY_RANK)) {
    throw new MemoryCoreError('invalid_promotion_visibility', 'Promotion target visibility is unsupported');
  }
  if (targetVisibility === 'private') {
    throw new MemoryCoreError('invalid_promotion_visibility', 'Promotion target visibility cannot be private');
  }
  if (VISIBILITY_RANK[targetVisibility] <= VISIBILITY_RANK[target.scope.visibility]) {
    throw new MemoryCoreError('invalid_promotion_visibility', 'Promotion target visibility must broaden the scope');
  }
  if (targetVisibility === 'domain' && targetDomain === undefined) {
    throw new MemoryCoreError('domain_required_for_promotion', 'Domain promotion requires targetDomain');
  }
}

function validateAuthority(scope: MemoryScope, targetVisibility: MemoryVisibility): void {
  if (VISIBILITY_RANK[scope.visibility] < VISIBILITY_RANK[targetVisibility]) {
    throw new MemoryCoreError('insufficient_memory_authority', 'Operation scope is narrower than target memory scope');
  }
}

function validateReplacementCompatibility(target: MemoryEvent, replacement: MemoryEvent): void {
  if (isAdministrativeEventType(replacement.type)) {
    throw new MemoryCoreError('invalid_replacement_event', 'Administrative events cannot replace memory content');
  }
  if (VISIBILITY_RANK[replacement.scope.visibility] < VISIBILITY_RANK[target.scope.visibility]) {
    throw new MemoryCoreError('invalid_replacement_scope', 'Replacement memory scope cannot be narrower than target');
  }
  if (
    target.scope.visibility === 'project' &&
    replacement.scope.visibility === 'project' &&
    target.scope.project_id !== replacement.scope.project_id
  ) {
    throw new MemoryCoreError('invalid_replacement_scope', 'Project replacement must match project_id');
  }
  if (target.scope.visibility === 'domain') {
    if (replacement.scope.visibility !== 'domain' && replacement.scope.visibility !== 'global') {
      throw new MemoryCoreError('invalid_replacement_scope', 'Domain memory must be replaced by domain/global memory');
    }
    if (replacement.scope.visibility === 'domain' && replacement.scope.domain !== target.scope.domain) {
      throw new MemoryCoreError('invalid_replacement_scope', 'Domain replacement must match domain');
    }
  }
  if (target.scope.visibility === 'global' && replacement.scope.visibility !== 'global') {
    throw new MemoryCoreError('invalid_replacement_scope', 'Global memory must be replaced by global memory');
  }
}

function sanitizeRedactedEvents(events: MemoryEvent[]): MemoryEvent[] {
  const redactedEventIds = buildRedactedEventIds(events);
  const redactions = new Map<string, MemoryEvent>();
  for (const event of events) {
    if (
      event.type === 'memory_redacted' &&
      event.supersedes !== undefined &&
      (event.status === undefined || event.status === 'live' || event.status === 'approved')
    ) {
      redactions.set(event.supersedes, event);
    }
  }

  return events.map((event) => {
    if (!redactedEventIds.has(event.id)) {
      return event;
    }
    const redaction = redactions.get(event.id);
    return {
      id: event.id,
      type: event.type,
      summary: '[redacted]',
      timestamp: event.timestamp,
      actor: event.actor,
      scope: event.scope,
      evidence_event_ids: [],
      status: 'redacted',
      metadata: {
        ...(redaction === undefined ? {} : { redacted_by_event_id: redaction.id }),
      },
    };
  });
}

function isAdministrativeEventType(type: MemoryEventType): boolean {
  return ADMINISTRATIVE_EVENT_TYPES.has(type);
}

function requireMetadataString(event: MemoryEvent, key: string): string {
  const value = event.metadata?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryCoreError('invalid_memory_metadata', `${event.id} metadata.${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalMetadataString(event: MemoryEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stableServiceEventId(...parts: string[]): string {
  return `mem_evt_service_${sha256(parts.join('\0')).slice(0, 24)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
