import { createHash, randomUUID } from 'node:crypto';
import { MemoryCoreError } from './event-ledger.js';
import { deriveMemoryUnits } from './memory-curator.js';
import type {
  AppendMemoryEventInput,
  MemoryActor,
  MemoryEvent,
  MemoryEventType,
  MemoryScope,
  MemoryUnit,
  MemoryUnitKind,
} from './types.js';

export type MetaMemoryRole =
  | 'project_summary'
  | 'run_summary'
  | 'architecture_doc'
  | 'human_note'
  | 'weekly_report'
  | 'global_lesson';

export type MetaMemorySyncState = 'derived' | 'human_edited' | 'needs_reconcile' | 'archived';

const META_MEMORY_ROLES: readonly MetaMemoryRole[] = [
  'project_summary',
  'run_summary',
  'architecture_doc',
  'human_note',
  'weekly_report',
  'global_lesson',
];

const META_MEMORY_SYNC_STATES: readonly MetaMemorySyncState[] = [
  'derived',
  'human_edited',
  'needs_reconcile',
  'archived',
];

export interface MetaMemoryDocumentMetadata {
  doc_id?: string;
  doc_path: string;
  memory_role: MetaMemoryRole;
  source_event_ids: string[];
  source_memory_unit_ids: string[];
  source_context_pack_ids: string[];
  sync_state: MetaMemorySyncState;
  last_compiled_at?: string;
}

export interface DerivedMetaMemoryDocument {
  title: string;
  path: string;
  content: string;
  tags: string[];
  metadata: MetaMemoryDocumentMetadata;
}

export interface CompileMetaMemorySummaryInput {
  title: string;
  path: string;
  memoryRole: MetaMemoryRole;
  events: MemoryEvent[];
  memoryUnits?: MemoryUnit[];
  sourceContextPackIds?: string[];
  tags?: string[];
  now?: Date;
}

export interface CreateMetaMemoryEventInput {
  actor: MemoryActor;
  scope: MemoryScope;
  timestamp?: string;
}

export interface CreateMetaMemoryHumanEditEventInput extends CreateMetaMemoryEventInput {
  docId?: string;
  docPath: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  editSummary?: string;
}

export interface ReconcileMetaMemoryEditInput {
  event: MemoryEvent;
  candidateType?: Extract<MemoryEventType, 'note' | 'decision' | 'memory_superseded' | 'memory_redacted'>;
}

export interface MetaMemoryDocument {
  id: string;
  path: string;
  title: string;
  content: string;
  tags: string[];
}

export interface CreateMetaMemoryDocumentInput {
  title: string;
  path: string;
  content: string;
  tags: string[];
}

export interface UpdateMetaMemoryDocumentInput {
  title?: string;
  content?: string;
  tags?: string[];
}

export interface MetaMemorySearchResult {
  id: string;
  path: string;
  title: string;
}

export interface MetaMemoryDocumentClient {
  getDocument(idOrPath: string): Promise<MetaMemoryDocument | null>;
  createDocument(input: CreateMetaMemoryDocumentInput): Promise<MetaMemoryDocument>;
  updateDocument(idOrPath: string, patch: UpdateMetaMemoryDocumentInput): Promise<MetaMemoryDocument>;
  search(query: string, limit?: number): Promise<MetaMemorySearchResult[]>;
}

export interface MetaMemoryBridgeOptions {
  client: MetaMemoryDocumentClient;
  appendEvent: (event: AppendMemoryEventInput) => MemoryEvent | Promise<MemoryEvent>;
}

export interface PublishDerivedSummaryInput extends CompileMetaMemorySummaryInput, CreateMetaMemoryEventInput {
  existingEvents?: MemoryEvent[];
  force?: boolean;
}

export interface RecordHumanEditInput extends CreateMetaMemoryHumanEditEventInput {
  existingEvents?: MemoryEvent[];
}

export interface ReconcileMetaMemoryDocumentInput {
  documents: MetaMemoryDocument[];
  existingEvents: MemoryEvent[];
  actor: MemoryActor;
  scope: MemoryScope;
}

export interface ReconcileIgnored {
  doc_path: string;
  reason: 'missing_metadata' | 'derived_doc' | 'archived_doc' | 'already_recorded';
}

const METADATA_START = '<!-- metabot-memory-metadata';
const METADATA_END = '-->';

const SECTION_TITLES: Record<MemoryUnitKind, string> = {
  fact: 'Facts',
  claim: 'Claims',
  method: 'Methods',
  decision: 'Decisions',
  lesson: 'Lessons',
  negative_result: 'Negative Results',
  constraint: 'Constraints',
  preference: 'Preferences',
  open_question: 'Open Questions',
};

export class MetaMemoryBridge {
  constructor(private readonly options: MetaMemoryBridgeOptions) {}

  async publishDerivedSummary(
    input: PublishDerivedSummaryInput,
  ): Promise<{ document: MetaMemoryDocument; event: MemoryEvent }> {
    const derived = compileMetaMemorySummary(input);
    const existingDocument = await this.options.client.getDocument(derived.path);
    const contentHash = metaMemoryContentHash(derived.content);
    const existingEvent = findPublishedEvent(input.existingEvents ?? [], derived.path, contentHash);

    if (existingDocument !== null) {
      const existingMetadata = extractMetaMemoryMetadata(existingDocument.content);
      if (
        input.force !== true &&
        (existingMetadata?.sync_state === 'human_edited' || existingMetadata?.sync_state === 'needs_reconcile')
      ) {
        throw new MemoryCoreError(
          'metamemory_doc_needs_reconcile',
          `Refusing to overwrite curated MetaMemory document: ${existingDocument.path}`,
        );
      }

      if (existingEvent !== undefined && metaMemoryContentHash(existingDocument.content) === contentHash) {
        return { document: existingDocument, event: existingEvent };
      }
    } else if (existingEvent !== undefined) {
      throw new MemoryCoreError(
        'metamemory_audit_without_document',
        `Found MetaMemory publish event but no document at path: ${derived.path}`,
      );
    }

    const eventDocument: DerivedMetaMemoryDocument = {
      ...derived,
      metadata: { ...derived.metadata, doc_id: existingDocument?.id },
    };
    const event = await this.options.appendEvent(createMetaMemorySummaryPublishedEvent(eventDocument, input));
    const savedDocument =
      existingDocument === null
        ? await this.options.client.createDocument({
            title: derived.title,
            path: derived.path,
            content: derived.content,
            tags: derived.tags,
          })
        : metaMemoryContentHash(existingDocument.content) === contentHash
          ? existingDocument
          : await this.options.client.updateDocument(existingDocument.id, {
              title: derived.title,
              content: derived.content,
              tags: derived.tags,
            });
    return { document: savedDocument, event };
  }

  async recordHumanEdit(input: RecordHumanEditInput): Promise<{ event: MemoryEvent }> {
    const afterHash = sha256(input.afterMarkdown);
    const existing = findHumanEditEvent(input.existingEvents ?? [], input.docPath, afterHash);
    if (existing !== undefined) {
      return { event: existing };
    }

    const event = await this.options.appendEvent(createMetaMemoryHumanEditEvent(input));
    return { event };
  }

  reconcile(input: ReconcileMetaMemoryDocumentInput): {
    candidates: AppendMemoryEventInput[];
    ignored: ReconcileIgnored[];
  } {
    const candidates: AppendMemoryEventInput[] = [];
    const ignored: ReconcileIgnored[] = [];

    for (const document of input.documents) {
      const metadata = extractMetaMemoryMetadata(document.content);
      if (metadata === undefined) {
        ignored.push({ doc_path: document.path, reason: 'missing_metadata' });
        continue;
      }
      if (metadata.sync_state === 'derived') {
        ignored.push({ doc_path: document.path, reason: 'derived_doc' });
        continue;
      }
      if (metadata.sync_state === 'archived') {
        ignored.push({ doc_path: document.path, reason: 'archived_doc' });
        continue;
      }

      const afterHash = sha256(document.content);
      if (findHumanEditEvent(input.existingEvents, document.path, afterHash) !== undefined) {
        ignored.push({ doc_path: document.path, reason: 'already_recorded' });
        continue;
      }

      const candidate = createMetaMemoryHumanEditEvent({
        docId: document.id,
        docPath: document.path,
        beforeMarkdown: '',
        afterMarkdown: document.content,
        editSummary: `Reconcile detected MetaMemory document edit: ${document.path}`,
        actor: input.actor,
        scope: input.scope,
      });
      candidate.id = `mem_evt_metamemory_edit_${sha256(`${document.path}:${afterHash}`).slice(0, 24)}`;
      candidates.push(candidate);
    }

    return { candidates, ignored };
  }
}

export function compileMetaMemorySummary(input: CompileMetaMemorySummaryInput): DerivedMetaMemoryDocument {
  const activeUnits = getActiveUnits(input.events, input.memoryUnits);
  const sourceEventIds = unique(activeUnits.flatMap((unit) => unit.source_event_ids));
  const sourceUnitIds = activeUnits.map((unit) => unit.id);
  const metadata: MetaMemoryDocumentMetadata = {
    doc_path: input.path,
    memory_role: input.memoryRole,
    source_event_ids: sourceEventIds,
    source_memory_unit_ids: sourceUnitIds,
    source_context_pack_ids: input.sourceContextPackIds ?? [],
    sync_state: 'derived',
    last_compiled_at: (input.now ?? new Date()).toISOString(),
  };
  const body = buildSummaryBody(input.title, activeUnits);
  return {
    title: input.title,
    path: input.path,
    content: attachMetaMemoryMetadata(body, metadata),
    tags: input.tags ?? ['metabot', 'memory-core', input.memoryRole],
    metadata,
  };
}

export function attachMetaMemoryMetadata(markdown: string, metadata: MetaMemoryDocumentMetadata): string {
  return `${METADATA_START}\n${JSON.stringify(metadata, null, 2)}\n${METADATA_END}\n\n${stripMetaMemoryMetadata(markdown).trim()}\n`;
}

export function extractMetaMemoryMetadata(markdown: string): MetaMemoryDocumentMetadata | undefined {
  const escapedStart = escapeRegExp(METADATA_START);
  const escapedEnd = escapeRegExp(METADATA_END);
  const match = markdown.match(new RegExp(`${escapedStart}\\n([\\s\\S]*?)\\n${escapedEnd}`));
  if (match === null) {
    return undefined;
  }

  const parsed = JSON.parse(match[1]) as MetaMemoryDocumentMetadata;
  validateMetaMemoryMetadata(parsed);
  return parsed;
}

export function stripMetaMemoryMetadata(markdown: string): string {
  const escapedStart = escapeRegExp(METADATA_START);
  const escapedEnd = escapeRegExp(METADATA_END);
  return markdown.replace(new RegExp(`${escapedStart}\\n[\\s\\S]*?\\n${escapedEnd}\\n*`), '').trim();
}

export function createMetaMemorySummaryPublishedEvent(
  document: DerivedMetaMemoryDocument,
  input: CreateMetaMemoryEventInput,
): AppendMemoryEventInput {
  return {
    id: `mem_evt_${randomUUID()}`,
    type: 'metamemory_summary_published',
    summary: `Published derived MetaMemory document: ${document.title}`,
    timestamp: input.timestamp,
    actor: input.actor,
    scope: input.scope,
    subject: {
      source_uris: [document.path],
    },
    evidence_event_ids: document.metadata.source_event_ids,
    metadata: {
      doc_id: document.metadata.doc_id,
      doc_path: document.path,
      doc_title: document.title,
      doc_hash: metaMemoryContentHash(document.content),
      source_memory_unit_ids: document.metadata.source_memory_unit_ids,
      source_context_pack_ids: document.metadata.source_context_pack_ids,
      sync_state: document.metadata.sync_state,
    },
  };
}

export function createMetaMemoryHumanEditEvent(input: CreateMetaMemoryHumanEditEventInput): AppendMemoryEventInput {
  const beforeMetadata = extractMetaMemoryMetadata(input.beforeMarkdown);
  const afterMetadata = extractMetaMemoryMetadata(input.afterMarkdown);
  return {
    id: `mem_evt_${randomUUID()}`,
    type: 'metamemory_human_edit',
    summary: `MetaMemory document edited: ${input.docPath}`,
    body: input.editSummary ?? summarizeMarkdownChange(input.beforeMarkdown, input.afterMarkdown),
    timestamp: input.timestamp,
    actor: input.actor,
    scope: input.scope,
    subject: {
      source_uris: [input.docPath],
    },
    evidence_event_ids: beforeMetadata?.source_event_ids ?? [],
    status: 'candidate',
    metadata: {
      doc_id: input.docId,
      doc_path: input.docPath,
      before_hash: sha256(input.beforeMarkdown),
      after_hash: sha256(input.afterMarkdown),
      before_source_event_ids: beforeMetadata?.source_event_ids ?? [],
      after_source_event_ids: afterMetadata?.source_event_ids ?? [],
      before_sync_state: beforeMetadata?.sync_state,
      after_sync_state: afterMetadata?.sync_state,
    },
  };
}

export function createMetaMemoryEditCandidates(input: ReconcileMetaMemoryEditInput): AppendMemoryEventInput[] {
  if (input.event.type !== 'metamemory_human_edit') {
    return [];
  }

  const candidateType = input.candidateType ?? inferCandidateType(input.event);
  return [
    {
      type: candidateType,
      summary: `Candidate from MetaMemory edit: ${input.event.summary}`,
      body: input.event.body,
      actor: input.event.actor,
      scope: input.event.scope,
      subject: input.event.subject,
      evidence_event_ids: [input.event.id],
      status: 'candidate',
      metadata: {
        derived_from_metamemory_edit: input.event.id,
        doc_path: stringMetadata(input.event, 'doc_path'),
      },
    },
  ];
}

function getActiveUnits(events: MemoryEvent[], memoryUnits: MemoryUnit[] | undefined): MemoryUnit[] {
  const units = memoryUnits ?? deriveMemoryUnits(events, { includeRejected: true });
  return units.filter((unit) => unit.state === 'active');
}

function buildSummaryBody(title: string, units: MemoryUnit[]): string {
  const sections = [`# ${title}`];
  for (const kind of Object.keys(SECTION_TITLES) as MemoryUnitKind[]) {
    const sectionUnits = units.filter((unit) => unit.kind === kind);
    if (sectionUnits.length === 0) {
      continue;
    }
    sections.push(`## ${SECTION_TITLES[kind]}\n${sectionUnits.map(formatUnitLine).join('\n')}`);
  }

  if (units.length > 0) {
    sections.push(
      `## Source Index\n${units.map((unit) => `- ${unit.id}: ${unit.source_event_ids.join(', ')}`).join('\n')}`,
    );
  }

  return `${sections.join('\n\n')}\n`;
}

function formatUnitLine(unit: MemoryUnit): string {
  return `- [${unit.id}] ${unit.summary}`;
}

function inferCandidateType(
  event: MemoryEvent,
): Extract<MemoryEventType, 'note' | 'decision' | 'memory_superseded' | 'memory_redacted'> {
  const text = `${event.summary}\n${event.body ?? ''}`.toLowerCase();
  if (text.includes('supersede') || text.includes('replace')) {
    return 'memory_superseded';
  }
  if (text.includes('redact') || text.includes('remove sensitive')) {
    return 'memory_redacted';
  }
  if (text.includes('decision') || text.includes('decide')) {
    return 'decision';
  }
  return 'note';
}

function findPublishedEvent(events: MemoryEvent[], docPath: string, contentHash: string): MemoryEvent | undefined {
  return events.find(
    (event) =>
      event.type === 'metamemory_summary_published' &&
      event.metadata?.doc_path === docPath &&
      event.metadata?.doc_hash === contentHash,
  );
}

function findHumanEditEvent(events: MemoryEvent[], docPath: string, afterHash: string): MemoryEvent | undefined {
  return events.find(
    (event) =>
      event.type === 'metamemory_human_edit' &&
      event.metadata?.doc_path === docPath &&
      event.metadata?.after_hash === afterHash,
  );
}

function summarizeMarkdownChange(beforeMarkdown: string, afterMarkdown: string): string {
  return `before_hash=${sha256(beforeMarkdown)}\nafter_hash=${sha256(afterMarkdown)}`;
}

function validateMetaMemoryMetadata(metadata: MetaMemoryDocumentMetadata): void {
  if (typeof metadata.doc_path !== 'string' || metadata.doc_path.length === 0) {
    throw new Error('MetaMemory metadata doc_path must be a non-empty string');
  }
  if (!META_MEMORY_ROLES.includes(metadata.memory_role)) {
    throw new Error(`MetaMemory metadata memory_role is invalid: ${String(metadata.memory_role)}`);
  }
  if (!META_MEMORY_SYNC_STATES.includes(metadata.sync_state)) {
    throw new Error(`MetaMemory metadata sync_state is invalid: ${String(metadata.sync_state)}`);
  }
  validateStringArray(metadata.source_event_ids, 'source_event_ids');
  validateStringArray(metadata.source_memory_unit_ids, 'source_memory_unit_ids');
  validateStringArray(metadata.source_context_pack_ids, 'source_context_pack_ids');
}

function validateStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`MetaMemory metadata ${field} must be a string array`);
  }
}

function stringMetadata(event: MemoryEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function metaMemoryContentHash(markdown: string): string {
  return sha256(stripMetaMemoryMetadata(markdown));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
