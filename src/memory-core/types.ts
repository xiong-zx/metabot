export const MEMORY_EVENT_TYPES = [
  'issue',
  'hypothesis',
  'attempt',
  'fix',
  'decision',
  'note',
  'project_created',
  'project_updated',
  'agent_instruction',
  'worker_dispatched',
  'worker_completed',
  'worker_failed',
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'memory_promoted',
  'memory_superseded',
  'memory_redacted',
  'metamemory_summary_published',
  'metamemory_human_edit',
  'context_pack_created',
  'research_project_registered',
  'research_run_started',
  'research_plan',
  'literature_observation',
  'experiment_started',
  'experiment_result',
  'metric_observed',
  'finding',
  'negative_result',
  'open_question',
  'pivot',
  'artifact_created',
  'report_generated',
] as const;

export const MEMORY_VISIBILITIES = ['private', 'project', 'domain', 'global'] as const;
export const MEMORY_EVENT_STATUSES = ['live', 'candidate', 'approved', 'rejected', 'superseded', 'redacted'] as const;
export const MEMORY_OUTCOMES = ['worked', 'failed', 'partial', 'unknown'] as const;
export const MEMORY_UNIT_KINDS = [
  'fact',
  'claim',
  'method',
  'decision',
  'lesson',
  'negative_result',
  'constraint',
  'preference',
  'open_question',
] as const;
export const MEMORY_UNIT_STATES = [
  'candidate',
  'active',
  'pending_review',
  'rejected',
  'superseded',
  'redacted',
] as const;
export const CONTEXT_PACK_PURPOSES = ['coding', 'research', 'review', 'planning', 'ops', 'report'] as const;

export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];
export type MemoryEventStatus = (typeof MEMORY_EVENT_STATUSES)[number];
export type MemoryOutcome = (typeof MEMORY_OUTCOMES)[number];
export type MemoryUnitKind = (typeof MEMORY_UNIT_KINDS)[number];
export type MemoryUnitState = (typeof MEMORY_UNIT_STATES)[number];
export type ContextPackPurpose = (typeof CONTEXT_PACK_PURPOSES)[number];
export type MemoryActorKind = 'user' | 'bot' | 'agent' | 'worker' | 'system';

export interface MemoryActor {
  kind: MemoryActorKind;
  id: string;
}

export interface MemoryScope {
  chat_id?: string;
  project_id?: string;
  run_id?: string;
  worker_id?: string;
  agent_id?: string;
  domain?: string;
  visibility: MemoryVisibility;
}

export interface MemorySubject {
  file_paths?: string[];
  artifact_ids?: string[];
  source_uris?: string[];
  commit?: string;
  command?: string;
  dataset?: string;
  paper_id?: string;
}

export interface MemoryEvent {
  id: string;
  type: MemoryEventType;
  summary: string;
  body?: string;
  timestamp: string;
  actor: MemoryActor;
  scope: MemoryScope;
  subject?: MemorySubject;
  outcome?: MemoryOutcome;
  confidence?: number;
  evidence_event_ids?: string[];
  supersedes?: string;
  status?: MemoryEventStatus;
  metadata?: Record<string, unknown>;
}

export type AppendMemoryEventInput = Omit<MemoryEvent, 'id' | 'timestamp'> &
  Partial<Pick<MemoryEvent, 'id' | 'timestamp'>>;

export interface MemoryUnitScope {
  project_id?: string;
  run_id?: string;
  agent_id?: string;
  user_id?: string;
  domain?: string;
  visibility: MemoryVisibility;
}

export interface MemoryUnit {
  id: string;
  kind: MemoryUnitKind;
  text: string;
  summary: string;
  source_event_ids: string[];
  evidence_event_ids: string[];
  scope: MemoryUnitScope;
  state: MemoryUnitState;
  confidence: number;
  tags: string[];
  supersedes?: string;
  superseded_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ContextPackScopeFilter {
  chat_id?: string;
  project_id?: string;
  run_id?: string;
  agent_id?: string;
  user_id?: string;
  domain?: string;
  include_visibilities?: MemoryVisibility[];
}

export interface ContextPack {
  id: string;
  purpose: ContextPackPurpose;
  query: string;
  token_budget: number;
  scope_filter: ContextPackScopeFilter;
  included_event_ids: string[];
  included_memory_unit_ids: string[];
  excluded_ids: Array<{ id: string; reason: string }>;
  markdown: string;
  source_index: Array<{
    id: string;
    type: 'event' | 'memory_unit' | 'metamemory_doc';
    title: string;
  }>;
  created_at: string;
}
