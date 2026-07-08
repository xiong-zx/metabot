import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemorySemanticMemoryProvider,
  Mem0SemanticMemoryProvider,
  MemoryEventLedger,
  ProjectMemAdapter,
  buildContextPack,
  deriveMemoryUnits,
  memoryEventToProjectMemEvent,
  memoryUnitToProviderMetadata,
  rebuildSemanticIndexFromEvents,
  type Mem0CompatibleAddInput,
  type Mem0CompatibleSearchInput,
  type Mem0CompatibleSearchRecord,
  type MemoryEvent,
} from '../src/memory-core/index.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-memory-bc-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function writeProjectMemFixture(): void {
  const projectMemDir = path.join(dir, '.projectmem');
  fs.mkdirSync(projectMemDir, { recursive: true });
  fs.writeFileSync(path.join(projectMemDir, 'summary.md'), '# Summary\nProjectMem summary');
  fs.writeFileSync(path.join(projectMemDir, 'PROJECT_MAP.md'), '# Map\nProject structure');
  fs.writeFileSync(path.join(projectMemDir, 'AI_INSTRUCTIONS.md'), '# Instructions\nUse memory precheck');
  fs.writeFileSync(
    path.join(projectMemDir, 'events.jsonl'),
    [
      line({
        id: 'evt_issue',
        timestamp: '2026-07-06T00:00:00Z',
        type: 'issue',
        summary: 'Worker dispatch lost context',
        files: ['src/worker.ts'],
        location: 'src/worker.ts:10',
        notes: 'Observed during mobile approval flow.',
        capture_confidence: 'high',
      }),
      line({
        id: 'evt_attempt',
        timestamp: '2026-07-06T00:01:00Z',
        type: 'attempt',
        summary: 'Tried injecting the full chat history',
        outcome: 'failed',
        issue_id: '0042',
        command: 'npm test',
      }),
      line({
        id: 'evt_decision',
        timestamp: '2026-07-06T00:02:00Z',
        type: 'decision',
        summary: 'Use token-budgeted context packs',
        supersedes: 'evt_old_decision',
      }),
    ].join(''),
  );
}

describe('ProjectMemAdapter', () => {
  it('imports ProjectMem events and briefing files into Memory Core contracts', () => {
    writeProjectMemFixture();
    const adapter = new ProjectMemAdapter(dir, { projectId: 'proj-alpha', domain: 'metabot' });

    const projectMemEvents = adapter.readEvents();
    const memoryEvents = adapter.importEvents(projectMemEvents);
    const briefing = adapter.readBriefing();

    expect(adapter.isInitialized()).toBe(true);
    expect(projectMemEvents).toHaveLength(3);
    expect(memoryEvents.map((event) => event.id)).toEqual(['evt_issue', 'evt_attempt', 'evt_decision']);
    expect(memoryEvents[0].scope).toMatchObject({ project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' });
    expect(memoryEvents[0].subject?.file_paths).toEqual(['src/worker.ts']);
    expect(memoryEvents[0].confidence).toBe(0.9);
    expect(memoryEvents[1].outcome).toBe('failed');
    expect(memoryEvents[2].supersedes).toBe('evt_old_decision');
    expect(briefing.summary).toContain('ProjectMem summary');
    expect(briefing.projectMap).toContain('Project structure');
    expect(briefing.instructions).toContain('Use memory precheck');
    expect(deriveMemoryUnits(memoryEvents).some((unit) => unit.kind === 'negative_result')).toBe(true);
  });

  it('normalizes missing ProjectMem id and timestamp with stable append-only fallbacks', () => {
    const projectMemDir = path.join(dir, '.projectmem');
    fs.mkdirSync(projectMemDir, { recursive: true });
    const duplicate = { type: 'note', summary: '重复的缺失 id 事件' };
    fs.writeFileSync(path.join(projectMemDir, 'events.jsonl'), [line(duplicate), line(duplicate)].join(''));
    const adapter = new ProjectMemAdapter(dir, { projectId: 'proj-alpha' });

    const firstRead = adapter.readEvents();
    const secondRead = adapter.readEvents();
    const imported = adapter.importEvents(firstRead);

    expect(firstRead.map((event) => event.id)).toEqual(secondRead.map((event) => event.id));
    expect(firstRead[0].id).not.toBe(firstRead[1].id);
    expect(imported.map((event) => event.timestamp)).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']);
    expect(imported[0].metadata?.projectmem_generated_id).toBe(true);
    expect(imported[0].metadata?.projectmem_missing_timestamp).toBe(true);
  });

  it('normalizes custom importEvents inputs with stable positional ids', () => {
    const adapter = new ProjectMemAdapter(dir, { projectId: 'proj-alpha' });
    const duplicate = { type: 'note' as const, summary: 'same custom event' };

    const firstImport = adapter.importEvents([duplicate, duplicate]);
    const secondImport = adapter.importEvents([duplicate, duplicate]);

    expect(firstImport.map((event) => event.id)).toEqual(secondImport.map((event) => event.id));
    expect(firstImport[0].id).not.toBe(firstImport[1].id);
    expect(firstImport[0].timestamp).toBe('1970-01-01T00:00:00.000Z');
    expect(firstImport[0].metadata?.projectmem_generated_id).toBe(true);
  });

  it('rejects invalid ProjectMem JSONL field shapes before import', () => {
    const projectMemDir = path.join(dir, '.projectmem');
    fs.mkdirSync(projectMemDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectMemDir, 'events.jsonl'),
      line({ id: 'evt_bad', type: 'note', summary: 'Bad files', files: ['ok.ts', 42] }),
    );
    const adapter = new ProjectMemAdapter(dir, { projectId: 'proj-alpha' });

    expect(() => adapter.readEvents()).toThrow(/files\[1\]/);
  });

  it('rejects non-string ProjectMem ids with controlled errors', () => {
    const projectMemDir = path.join(dir, '.projectmem');
    fs.mkdirSync(projectMemDir, { recursive: true });
    fs.writeFileSync(path.join(projectMemDir, 'events.jsonl'), line({ id: 42, type: 'note', summary: 'Bad id' }));
    const adapter = new ProjectMemAdapter(dir, { projectId: 'proj-alpha' });

    expect(() => adapter.readEvents()).toThrow(/id must be a string/);
  });

  it('exports compatible MemoryEvents back to ProjectMem event shape', () => {
    const adapter = new ProjectMemAdapter(dir, { projectId: 'proj-alpha' });
    const [event] = adapter.importEvents([
      {
        id: 'evt_decision',
        timestamp: '2026-07-06T00:00:00Z',
        type: 'decision',
        summary: 'Use append-only event logs',
        notes: 'The old event stays in history.',
        git_message: 'docs: record memory decision',
        supersedes: 'evt_old',
      },
    ]);

    const projectMemEvent = memoryEventToProjectMemEvent(event);
    const unsupported = memoryEventToProjectMemEvent({
      ...event,
      id: 'mem_evt_finding',
      type: 'finding',
      summary: 'Research-only finding',
    });

    expect(projectMemEvent).toMatchObject({
      id: 'evt_decision',
      type: 'decision',
      summary: 'Use append-only event logs',
      notes: 'The old event stays in history.',
      git_message: 'docs: record memory decision',
      supersedes: 'evt_old',
    });
    expect(unsupported).toBeUndefined();
  });
});

describe('semantic memory providers', () => {
  function seedEvents(): MemoryEvent[] {
    const ledger = new MemoryEventLedger(dir);
    const failed = ledger.append({
      type: 'attempt',
      summary: 'Full history injection failed because it exceeded token budget',
      outcome: 'failed',
      actor: { kind: 'agent', id: 'agent-reviewer' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    });
    ledger.append({
      type: 'decision',
      summary: 'Use compact context packs for worker dispatch',
      actor: { kind: 'agent', id: 'agent-reviewer' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      evidence_event_ids: [failed.id],
    });
    ledger.append({
      type: 'decision',
      summary: 'Candidate global memory policy',
      status: 'candidate',
      actor: { kind: 'agent', id: 'agent-reviewer' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    });
    ledger.append({
      type: 'finding',
      summary: 'Rejected finding should stay out of semantic search',
      status: 'rejected',
      actor: { kind: 'agent', id: 'agent-reviewer' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    });
    return ledger.readAll();
  }

  it('indexes and searches active units with in-memory provider filters', async () => {
    const events = seedEvents();
    const provider = new InMemorySemanticMemoryProvider();
    await rebuildSemanticIndexFromEvents(provider, events);

    const results = await provider.search({
      query: 'token budget context',
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
      limit: 10,
    });
    const candidateResults = await provider.search({
      query: 'candidate global memory',
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
      includeCandidates: true,
    });

    expect(results.map((result) => result.unit.summary)).toContain(
      'Full history injection failed because it exceeded token budget',
    );
    expect(results.some((result) => result.unit.summary.includes('Rejected finding'))).toBe(false);
    expect(candidateResults.map((result) => result.unit.summary)).toContain('Candidate global memory policy');

    const pack = buildContextPack({
      purpose: 'coding',
      query: 'worker context',
      tokenBudget: 700,
      events,
      memoryUnits: results.map((result) => result.unit),
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
    });

    expect(pack.markdown).toContain('Known Failed Attempts / Negative Results');
    expect(pack.included_event_ids.length).toBeGreaterThan(0);
    expect('index' in provider).toBe(false);
    expect('upsert' in provider).toBe(false);
  });

  it('hydrates mem0-compatible search records back to canonical MemoryUnits', async () => {
    const events = seedEvents();
    const adds: Mem0CompatibleAddInput[] = [];
    const deletes: string[] = [];
    const searches: Mem0CompatibleSearchInput[] = [];
    const client = {
      async add(input: Mem0CompatibleAddInput): Promise<{ id: string }> {
        adds.push(input);
        return { id: `provider_${String(input.metadata.memory_unit_id)}` };
      },
      async search(input: Mem0CompatibleSearchInput): Promise<Mem0CompatibleSearchRecord[]> {
        searches.push(input);
        return adds.map((add) => ({
          id: `provider_${String(add.metadata.memory_unit_id)}`,
          score: input.query.includes('context') ? 0.8 : 0.1,
          metadata: add.metadata,
        }));
      },
      async delete(id: string): Promise<void> {
        deletes.push(id);
      },
    };
    const provider = new Mem0SemanticMemoryProvider(client);

    const units = await provider.rebuildFromEvents(events);
    const searchResults = await provider.search({
      query: 'context',
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
      limit: 10,
    });
    await provider.deleteIndexOnly(units[0].id);

    expect(adds[0].metadata).toMatchObject(memoryUnitToProviderMetadata(units[0]));
    expect(searchResults.some((result) => result.unit.state === 'rejected')).toBe(false);
    expect(searchResults.some((result) => result.unit.summary.includes('context packs'))).toBe(true);
    expect(deletes).toContain(`provider_${units[0].id}`);
    expect(Object.values(searches[0].filters ?? {}).some((value) => value === undefined)).toBe(false);
  });

  it('deduplicates mem0-compatible search records by canonical memory unit id', async () => {
    const events = seedEvents();
    const adds: Mem0CompatibleAddInput[] = [];
    const client = {
      async add(input: Mem0CompatibleAddInput): Promise<{ id: string }> {
        adds.push(input);
        return { id: `provider_${adds.length}` };
      },
      async search(): Promise<Mem0CompatibleSearchRecord[]> {
        return adds.map((add) => ({
          id: `provider_${String(add.metadata.memory_unit_id)}`,
          score: 0.8,
          metadata: add.metadata,
        }));
      },
    };
    const provider = new Mem0SemanticMemoryProvider(client);

    await provider.rebuildFromEvents(events);
    await provider.rebuildFromEvents(events);
    const results = await provider.search({
      query: 'context',
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
      limit: 20,
    });
    const unitIds = results.map((result) => result.unit.id);

    expect(unitIds).toEqual([...new Set(unitIds)]);
  });
});
