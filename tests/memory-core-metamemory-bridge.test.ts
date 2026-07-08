import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryEventLedger,
  MetaMemoryBridge,
  attachMetaMemoryMetadata,
  compileMetaMemorySummary,
  createMetaMemoryEditCandidates,
  createMetaMemoryHumanEditEvent,
  createMetaMemorySummaryPublishedEvent,
  deriveMemoryUnits,
  extractMetaMemoryMetadata,
  stripMetaMemoryMetadata,
  type CreateMetaMemoryDocumentInput,
  type MetaMemoryDocument,
  type UpdateMetaMemoryDocumentInput,
  type MemoryEvent,
} from '../src/memory-core/index.js';

let dir: string;
let ledger: MemoryEventLedger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-metamemory-bridge-'));
  ledger = new MemoryEventLedger(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedEvents(): MemoryEvent[] {
  const failed = ledger.append({
    type: 'attempt',
    summary: 'Full history prompt injection exceeded token budget',
    outcome: 'failed',
    actor: { kind: 'agent', id: 'agent-reviewer' },
    scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
  });
  const old = ledger.append({
    type: 'decision',
    summary: 'Use full chat history as worker context',
    actor: { kind: 'agent', id: 'agent-reviewer' },
    scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
  });
  const current = ledger.append({
    type: 'decision',
    summary: 'Use compact context packs as worker context',
    actor: { kind: 'agent', id: 'agent-reviewer' },
    scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    evidence_event_ids: [failed.id],
  });
  ledger.append({
    type: 'memory_superseded',
    summary: 'Retire full history worker context decision',
    actor: { kind: 'agent', id: 'agent-reviewer' },
    scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    evidence_event_ids: [failed.id, current.id],
    supersedes: old.id,
    status: 'approved',
  });
  ledger.append({
    type: 'finding',
    summary: 'Rejected finding must not enter summary',
    status: 'rejected',
    actor: { kind: 'agent', id: 'agent-reviewer' },
    scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
  });
  ledger.append({
    type: 'note',
    summary: 'Candidate note still needs review',
    status: 'candidate',
    actor: { kind: 'agent', id: 'agent-reviewer' },
    scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
  });
  return ledger.readAll();
}

describe('MetaMemory bridge', () => {
  function createMockDocumentClient() {
    const documents = new Map<string, MetaMemoryDocument>();
    const creates: CreateMetaMemoryDocumentInput[] = [];
    const updates: Array<{ idOrPath: string; patch: UpdateMetaMemoryDocumentInput }> = [];
    return {
      creates,
      updates,
      documents,
      client: {
        async getDocument(idOrPath: string): Promise<MetaMemoryDocument | null> {
          return (
            documents.get(idOrPath) ?? [...documents.values()].find((document) => document.path === idOrPath) ?? null
          );
        },
        async createDocument(input: CreateMetaMemoryDocumentInput): Promise<MetaMemoryDocument> {
          creates.push(input);
          const document = { id: `doc_${creates.length}`, ...input };
          documents.set(document.id, document);
          documents.set(document.path, document);
          return document;
        },
        async updateDocument(idOrPath: string, patch: UpdateMetaMemoryDocumentInput): Promise<MetaMemoryDocument> {
          updates.push({ idOrPath, patch });
          const existing = documents.get(idOrPath);
          if (existing === undefined) {
            throw new Error(`missing document ${idOrPath}`);
          }
          const updated = {
            ...existing,
            title: patch.title ?? existing.title,
            content: patch.content ?? existing.content,
            tags: patch.tags ?? existing.tags,
          };
          documents.set(updated.id, updated);
          documents.set(updated.path, updated);
          return updated;
        },
        async search(): Promise<Array<{ id: string; path: string; title: string }>> {
          return [...documents.values()].map((document) => ({
            id: document.id,
            path: document.path,
            title: document.title,
          }));
        },
      },
    };
  }

  it('compiles a derived summary document with traceable metadata and active memory only', () => {
    const events = seedEvents();
    const doc = compileMetaMemorySummary({
      title: 'Project Alpha Memory Summary',
      path: '/metabot/projects/proj-alpha-summary',
      memoryRole: 'project_summary',
      events,
      sourceContextPackIds: ['ctx_123'],
      now: new Date('2026-07-06T00:00:00Z'),
    });
    const metadata = extractMetaMemoryMetadata(doc.content);

    expect(metadata).toMatchObject({
      doc_path: '/metabot/projects/proj-alpha-summary',
      memory_role: 'project_summary',
      source_context_pack_ids: ['ctx_123'],
      sync_state: 'derived',
      last_compiled_at: '2026-07-06T00:00:00.000Z',
    });
    expect(metadata?.source_event_ids).toContain(events[0].id);
    expect(metadata?.source_event_ids).not.toContain(events[1].id);
    expect(doc.content).toContain('Negative Results');
    expect(doc.content).toContain('Use compact context packs as worker context');
    expect(doc.content).not.toContain('Rejected finding must not enter summary');
    expect(doc.content).not.toContain('Candidate note still needs review');
    expect(stripMetaMemoryMetadata(doc.content).startsWith('# Project Alpha Memory Summary')).toBe(true);
  });

  it('publishes derived summaries through a narrow client and avoids duplicate publish events', async () => {
    const events = seedEvents();
    const mock = createMockDocumentClient();
    const appended: MemoryEvent[] = [];
    const bridge = new MetaMemoryBridge({
      client: mock.client,
      appendEvent: (event) => {
        const appendedEvent = ledger.append(event);
        appended.push(appendedEvent);
        return appendedEvent;
      },
    });

    const first = await bridge.publishDerivedSummary({
      title: 'Project Alpha Memory Summary',
      path: '/metabot/projects/proj-alpha-summary',
      memoryRole: 'project_summary',
      events,
      actor: { kind: 'bot', id: 'metabot' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      existingEvents: appended,
    });
    const second = await bridge.publishDerivedSummary({
      title: 'Project Alpha Memory Summary',
      path: '/metabot/projects/proj-alpha-summary',
      memoryRole: 'project_summary',
      events,
      actor: { kind: 'bot', id: 'metabot' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      existingEvents: appended,
    });

    expect(first.document.id).toBe('doc_1');
    expect(first.event.id).toBe(second.event.id);
    expect(appended).toHaveLength(1);
    expect(mock.creates).toHaveLength(1);
    expect(mock.updates).toHaveLength(0);
    expect(first.event.metadata?.doc_path).toBe('/metabot/projects/proj-alpha-summary');
  });

  it('refuses to overwrite curated human-edited docs unless forced', async () => {
    const events = seedEvents();
    const existingDoc = compileMetaMemorySummary({
      title: 'Project Alpha Memory Summary',
      path: '/metabot/projects/proj-alpha-summary',
      memoryRole: 'project_summary',
      events,
    });
    const humanEditedContent = attachMetaMemoryMetadata(stripMetaMemoryMetadata(existingDoc.content), {
      ...existingDoc.metadata,
      sync_state: 'human_edited',
    });
    const mock = createMockDocumentClient();
    mock.documents.set('/metabot/projects/proj-alpha-summary', {
      id: 'doc_1',
      path: '/metabot/projects/proj-alpha-summary',
      title: 'Project Alpha Memory Summary',
      content: humanEditedContent,
      tags: [],
    });
    const appended: MemoryEvent[] = [];
    const bridge = new MetaMemoryBridge({
      client: mock.client,
      appendEvent: (event) => {
        const appendedEvent = ledger.append(event);
        appended.push(appendedEvent);
        return appendedEvent;
      },
    });

    await expect(
      bridge.publishDerivedSummary({
        title: 'Project Alpha Memory Summary',
        path: '/metabot/projects/proj-alpha-summary',
        memoryRole: 'project_summary',
        events,
        actor: { kind: 'bot', id: 'metabot' },
        scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
        existingEvents: appended,
      }),
    ).rejects.toThrow(/Refusing to overwrite/);

    expect(appended).toHaveLength(0);
    expect(mock.creates).toHaveLength(0);
    expect(mock.updates).toHaveLength(0);
  });

  it('does not write a document if audit event append fails', async () => {
    const events = seedEvents();
    const mock = createMockDocumentClient();
    const bridge = new MetaMemoryBridge({
      client: mock.client,
      appendEvent: () => {
        throw new Error('append failed');
      },
    });

    await expect(
      bridge.publishDerivedSummary({
        title: 'Project Alpha Memory Summary',
        path: '/metabot/projects/proj-alpha-summary',
        memoryRole: 'project_summary',
        events,
        actor: { kind: 'bot', id: 'metabot' },
        scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      }),
    ).rejects.toThrow(/append failed/);

    expect(mock.creates).toHaveLength(0);
    expect(mock.updates).toHaveLength(0);
  });

  it('creates a summary-published event without turning the document into semantic memory', () => {
    const events = seedEvents();
    const doc = compileMetaMemorySummary({
      title: 'Project Alpha Memory Summary',
      path: '/metabot/projects/proj-alpha-summary',
      memoryRole: 'project_summary',
      events,
    });
    const published = ledger.append(
      createMetaMemorySummaryPublishedEvent(doc, {
        actor: { kind: 'bot', id: 'metabot' },
        scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      }),
    );

    expect(published.type).toBe('metamemory_summary_published');
    expect(published.evidence_event_ids).toEqual(doc.metadata.source_event_ids);
    expect(published.metadata?.source_memory_unit_ids).toEqual(doc.metadata.source_memory_unit_ids);
    expect(deriveMemoryUnits([published])).toEqual([]);
  });

  it('turns a human edit into a candidate event and reconcile candidates only', () => {
    const events = seedEvents();
    const beforeDoc = compileMetaMemorySummary({
      title: 'Project Alpha Memory Summary',
      path: '/metabot/projects/proj-alpha-summary',
      memoryRole: 'project_summary',
      events,
    });
    const afterMetadata = { ...beforeDoc.metadata, sync_state: 'human_edited' as const };
    const afterMarkdown = attachMetaMemoryMetadata(
      `${stripMetaMemoryMetadata(beforeDoc.content)}\n\n## Human Note\nDecision: keep context packs compact.\n`,
      afterMetadata,
    );
    const edit = ledger.append(
      createMetaMemoryHumanEditEvent({
        docId: 'doc_123',
        docPath: beforeDoc.path,
        beforeMarkdown: beforeDoc.content,
        afterMarkdown,
        editSummary: 'Decision: keep context packs compact.',
        actor: { kind: 'user', id: 'user-admin' },
        scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      }),
    );
    const candidates = createMetaMemoryEditCandidates({ event: edit });

    expect(edit.type).toBe('metamemory_human_edit');
    expect(edit.status).toBe('candidate');
    expect(edit.metadata?.doc_id).toBe('doc_123');
    expect(edit.metadata?.before_hash).not.toBe(edit.metadata?.after_hash);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: 'decision',
      status: 'candidate',
      evidence_event_ids: [edit.id],
    });
  });

  it('records human edits idempotently and reconciles documents without side effects', async () => {
    const events = seedEvents();
    const beforeDoc = compileMetaMemorySummary({
      title: 'Project Alpha Memory Summary',
      path: '/metabot/projects/proj-alpha-summary',
      memoryRole: 'project_summary',
      events,
    });
    const afterMarkdown = attachMetaMemoryMetadata(
      `${stripMetaMemoryMetadata(beforeDoc.content)}\n\n## Human Note\nPrefer compact summaries.\n`,
      { ...beforeDoc.metadata, sync_state: 'human_edited' },
    );
    const mock = createMockDocumentClient();
    const appended: MemoryEvent[] = [];
    const bridge = new MetaMemoryBridge({
      client: mock.client,
      appendEvent: (event) => {
        const appendedEvent = ledger.append(event);
        appended.push(appendedEvent);
        return appendedEvent;
      },
    });

    const first = await bridge.recordHumanEdit({
      docId: 'doc_123',
      docPath: beforeDoc.path,
      beforeMarkdown: beforeDoc.content,
      afterMarkdown,
      editSummary: 'Prefer compact summaries.',
      actor: { kind: 'user', id: 'user-admin' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      existingEvents: appended,
    });
    const second = await bridge.recordHumanEdit({
      docId: 'doc_123',
      docPath: beforeDoc.path,
      beforeMarkdown: beforeDoc.content,
      afterMarkdown,
      editSummary: 'Prefer compact summaries.',
      actor: { kind: 'user', id: 'user-admin' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      existingEvents: appended,
    });
    const reconciled = bridge.reconcile({
      documents: [
        { id: 'doc_123', path: beforeDoc.path, title: beforeDoc.title, content: afterMarkdown, tags: beforeDoc.tags },
        { id: 'doc_derived', path: '/derived', title: 'Derived', content: beforeDoc.content, tags: [] },
        {
          id: 'doc_archived',
          path: '/archived',
          title: 'Archived',
          content: attachMetaMemoryMetadata('# Archived\n', {
            ...beforeDoc.metadata,
            doc_path: '/archived',
            sync_state: 'archived',
          }),
          tags: [],
        },
      ],
      existingEvents: appended,
      actor: { kind: 'system', id: 'reconciler' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    });

    expect(first.event.id).toBe(second.event.id);
    expect(appended).toHaveLength(1);
    expect(mock.creates).toHaveLength(0);
    expect(mock.updates).toHaveLength(0);
    expect(reconciled.candidates).toHaveLength(0);
    expect(reconciled.ignored).toContainEqual({ doc_path: beforeDoc.path, reason: 'already_recorded' });
    expect(reconciled.ignored).toContainEqual({ doc_path: '/derived', reason: 'derived_doc' });
    expect(reconciled.ignored).toContainEqual({ doc_path: '/archived', reason: 'archived_doc' });
  });

  it('rejects malformed MetaMemory metadata', () => {
    const malformed = `<!-- metabot-memory-metadata\n${JSON.stringify({
      doc_path: '/bad',
      memory_role: 'bad_role',
      source_event_ids: [],
      source_memory_unit_ids: [],
      source_context_pack_ids: [],
      sync_state: 'derived',
    })}\n-->\n\n# Bad\n`;

    expect(() => extractMetaMemoryMetadata(malformed)).toThrow(/memory_role/);
  });
});
