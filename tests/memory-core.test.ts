import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryEventLedger,
  buildContextPack,
  deriveMemoryUnits,
  estimateTokens,
  type AppendMemoryEventInput,
} from '../src/memory-core/index.js';

let dir: string;
let ledger: MemoryEventLedger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-memory-core-'));
  ledger = new MemoryEventLedger(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function event(
  input: Partial<AppendMemoryEventInput> & Pick<AppendMemoryEventInput, 'type' | 'summary'>,
): AppendMemoryEventInput {
  return {
    actor: { kind: 'agent', id: 'agent-reviewer' },
    scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    ...input,
  };
}

describe('MemoryEventLedger', () => {
  it('appends and reads canonical JSONL events', () => {
    const first = ledger.append(event({ type: 'issue', summary: 'Worker dispatch can lose context' }));
    const second = ledger.append(
      event({
        type: 'fix',
        summary: 'Context pack includes source ids before dispatch',
        evidence_event_ids: [first.id],
        outcome: 'worked',
      }),
    );

    expect(fs.existsSync(path.join(dir, '.metabot-memory', 'events.jsonl'))).toBe(true);
    expect(ledger.readAll().map((item) => item.id)).toEqual([first.id, second.id]);
    expect(ledger.findById(first.id)?.summary).toBe('Worker dispatch can lose context');
  });

  it('rejects invalid events before writing them', () => {
    expect(() =>
      ledger.append(
        event({
          type: 'finding',
          summary: 'confidence out of range',
          confidence: 1.2,
        }),
      ),
    ).toThrow(/confidence/);

    expect(ledger.readAll()).toEqual([]);
  });
});

describe('deriveMemoryUnits', () => {
  it('derives deterministic semantic units from coding and research events', () => {
    const failed = ledger.append(
      event({
        type: 'attempt',
        summary: 'Trying to inject full chat history caused token blowups',
        outcome: 'failed',
      }),
    );
    const decision = ledger.append(
      event({
        type: 'decision',
        summary: 'Use append-only events as canonical memory',
        evidence_event_ids: [failed.id],
      }),
    );
    ledger.append(event({ type: 'finding', summary: 'Negative results should be first-class memory' }));
    ledger.append(event({ type: 'open_question', summary: 'When should MetaMemory edits become active memory?' }));

    const units = deriveMemoryUnits(ledger.readAll());

    expect(units.map((unit) => unit.kind)).toEqual(['negative_result', 'decision', 'fact', 'open_question']);
    expect(units.find((unit) => unit.source_event_ids.includes(decision.id))?.evidence_event_ids).toEqual([failed.id]);
  });

  it('marks superseded units and excludes redacted events', () => {
    const oldEvent = ledger.append(event({ type: 'decision', summary: 'Use SQLite as canonical memory' }));
    const replacement = ledger.append(
      event({
        type: 'memory_superseded',
        summary: 'Use append-only event log as canonical memory',
        supersedes: oldEvent.id,
        status: 'approved',
      }),
    );
    ledger.append(event({ type: 'note', summary: 'Sensitive implementation detail', status: 'redacted' }));

    const units = deriveMemoryUnits(ledger.readAll());

    expect(units.find((unit) => unit.source_event_ids.includes(oldEvent.id))?.state).toBe('superseded');
    expect(units.find((unit) => unit.source_event_ids.includes(oldEvent.id))?.superseded_by).toBe(replacement.id);
    expect(units.some((unit) => unit.summary === 'Sensitive implementation detail')).toBe(false);
  });

  it('does not let ordinary events with supersedes retire memory', () => {
    const oldEvent = ledger.append(event({ type: 'decision', summary: 'Only controlled tombstones retire memory' }));
    const pivot = ledger.append(
      event({
        type: 'pivot',
        summary: 'Pivot away from old strategy without retiring memory',
        supersedes: oldEvent.id,
      }),
    );

    const units = deriveMemoryUnits(ledger.readAll());

    expect(units.find((unit) => unit.source_event_ids.includes(oldEvent.id))?.state).toBe('active');
    expect(units.find((unit) => unit.source_event_ids.includes(pivot.id))?.state).toBe('active');
  });

  it('does not let candidate replacements supersede active memory', () => {
    const oldEvent = ledger.append(
      event({ type: 'decision', summary: 'Keep active policy until replacement is approved' }),
    );
    const candidate = ledger.append(
      event({
        type: 'decision',
        summary: 'Candidate policy that still needs review',
        supersedes: oldEvent.id,
        status: 'candidate',
      }),
    );

    const units = deriveMemoryUnits(ledger.readAll());

    expect(units.find((unit) => unit.source_event_ids.includes(oldEvent.id))?.state).toBe('active');
    expect(units.find((unit) => unit.source_event_ids.includes(candidate.id))?.state).toBe('candidate');
  });
});

describe('buildContextPack', () => {
  it('builds a traceable context pack and filters unsafe memory', () => {
    const negative = ledger.append(
      event({
        type: 'negative_result',
        summary: 'Embedding-only retrieval missed project-local constraints',
        confidence: 0.9,
      }),
    );
    const decision = ledger.append(
      event({
        type: 'decision',
        summary: 'Hydrate semantic results from canonical events before injection',
        confidence: 0.8,
      }),
    );
    const rejected = ledger.append(event({ type: 'finding', summary: 'Rejected claim', status: 'rejected' }));
    const old = ledger.append(event({ type: 'decision', summary: 'Old memory policy' }));
    ledger.append(
      event({
        type: 'memory_superseded',
        summary: 'New memory policy',
        supersedes: old.id,
        status: 'approved',
      }),
    );
    const privateEvent = ledger.append(
      event({
        type: 'note',
        summary: 'Private agent note must not leak',
        scope: { project_id: 'proj-alpha', visibility: 'private', agent_id: 'agent-private' },
      }),
    );

    const pack = buildContextPack({
      purpose: 'planning',
      query: 'memory retrieval constraints',
      tokenBudget: 800,
      events: ledger.readAll(),
      memoryUnits: deriveMemoryUnits(ledger.readAll(), { includeRejected: true }),
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
    });

    expect(pack.markdown).toContain('Known Failed Attempts / Negative Results');
    expect(pack.included_event_ids).toContain(negative.id);
    expect(pack.included_event_ids).toContain(decision.id);
    expect(pack.markdown).toContain(negative.id);
    expect(pack.source_index.some((source) => source.id === `mem_unit_${decision.id}`)).toBe(true);
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${rejected.id}`, reason: 'rejected_memory' });
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${old.id}`, reason: 'superseded_memory' });
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${privateEvent.id}`, reason: 'private_scope_mismatch' });
  });

  it('keeps private memory inside matching owner and project scope', () => {
    const privateEvent = ledger.append(
      event({
        type: 'note',
        summary: 'Private project-local reviewer note',
        scope: { project_id: 'proj-alpha', visibility: 'private', agent_id: 'agent-private' },
      }),
    );

    const pack = buildContextPack({
      purpose: 'review',
      query: 'reviewer note',
      tokenBudget: 400,
      events: ledger.readAll(),
      scopeFilter: { project_id: 'proj-beta', agent_id: 'agent-private' },
    });

    expect(pack.included_event_ids).not.toContain(privateEvent.id);
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${privateEvent.id}`, reason: 'project_scope_mismatch' });
  });

  it('keeps private memory inside matching run and domain scope', () => {
    const privateEvent = ledger.append(
      event({
        type: 'note',
        summary: 'Private run-local reviewer note',
        scope: {
          project_id: 'proj-alpha',
          run_id: 'run-alpha',
          domain: 'metabot',
          visibility: 'private',
          agent_id: 'agent-private',
        },
      }),
    );

    const pack = buildContextPack({
      purpose: 'review',
      query: 'reviewer note',
      tokenBudget: 400,
      events: ledger.readAll(),
      scopeFilter: { project_id: 'proj-alpha', run_id: 'run-beta', domain: 'biology', agent_id: 'agent-private' },
    });

    expect(pack.included_event_ids).not.toContain(privateEvent.id);
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${privateEvent.id}`, reason: 'run_scope_mismatch' });
  });

  it('filters private memory with explicit domain mismatch', () => {
    const privateEvent = ledger.append(
      event({
        type: 'note',
        summary: 'Private domain-local reviewer note',
        scope: {
          project_id: 'proj-alpha',
          run_id: 'run-alpha',
          domain: 'metabot',
          visibility: 'private',
          agent_id: 'agent-private',
        },
      }),
    );

    const pack = buildContextPack({
      purpose: 'review',
      query: 'reviewer note',
      tokenBudget: 400,
      events: ledger.readAll(),
      scopeFilter: { project_id: 'proj-alpha', run_id: 'run-alpha', domain: 'biology', agent_id: 'agent-private' },
    });

    expect(pack.included_event_ids).not.toContain(privateEvent.id);
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${privateEvent.id}`, reason: 'domain_scope_mismatch' });
  });

  it('revalidates caller-provided memory units against canonical events', () => {
    const rejected = ledger.append(event({ type: 'finding', summary: 'Rejected semantic claim', status: 'rejected' }));
    const staleExternalUnit = {
      ...deriveMemoryUnits(ledger.readAll(), { includeRejected: true })[0],
      id: 'external_mem0_unit',
      state: 'active' as const,
    };

    const pack = buildContextPack({
      purpose: 'planning',
      query: 'semantic claim',
      tokenBudget: 400,
      events: ledger.readAll(),
      memoryUnits: [staleExternalUnit],
      scopeFilter: { project_id: 'proj-alpha' },
    });

    expect(pack.included_event_ids).not.toContain(rejected.id);
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${rejected.id}`, reason: 'rejected_memory' });
  });

  it('does not allow external semantic units to override canonical text', () => {
    const canonical = ledger.append(event({ type: 'decision', summary: 'Canonical memory text' }));
    const externalUnit = {
      ...deriveMemoryUnits(ledger.readAll())[0],
      kind: 'negative_result' as const,
      summary: 'Injected external memory text',
      text: 'Injected external memory text',
      confidence: 1,
    };

    const pack = buildContextPack({
      purpose: 'planning',
      query: 'memory text',
      tokenBudget: 400,
      events: ledger.readAll(),
      memoryUnits: [externalUnit],
      scopeFilter: { project_id: 'proj-alpha' },
    });

    expect(pack.included_event_ids).toContain(canonical.id);
    expect(pack.markdown).toContain('Active Decisions');
    expect(pack.markdown).not.toContain('Known Failed Attempts / Negative Results');
    expect(pack.markdown).toContain('Canonical memory text');
    expect(pack.markdown).not.toContain('Injected external memory text');
  });

  it('respects token budgets', () => {
    const first = ledger.append(event({ type: 'decision', summary: 'A concise memory that should fit' }));
    const second = ledger.append(
      event({
        type: 'finding',
        summary: `A very long finding that should be excluded by a tiny token budget ${'x'.repeat(500)}`,
      }),
    );

    const pack = buildContextPack({
      purpose: 'coding',
      query: 'concise memory',
      tokenBudget: 120,
      events: ledger.readAll(),
      scopeFilter: { project_id: 'proj-alpha' },
    });

    expect(pack.included_event_ids).toContain(first.id);
    expect(pack.included_event_ids).not.toContain(second.id);
    expect(pack.excluded_ids).toContainEqual({ id: `mem_unit_${second.id}`, reason: 'token_budget_exceeded' });
    expect(estimateTokens(pack.markdown)).toBeLessThanOrEqual(pack.token_budget);
  });
});
