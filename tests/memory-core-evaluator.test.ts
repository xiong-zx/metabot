import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryEventLedger,
  buildContextPack,
  deriveMemoryUnits,
  evaluateMemoryCore,
  type ContextPack,
} from '../src/memory-core/index.js';

let dir: string;
let ledger: MemoryEventLedger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-memory-evaluator-'));
  ledger = new MemoryEventLedger(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('evaluateMemoryCore', () => {
  it('passes a compact context pack with evidence-backed claims and recalled negative results', () => {
    const workerCompleted = ledger.append({
      type: 'worker_completed',
      summary: 'Worker completed with validated artifact',
      actor: { kind: 'worker', id: 'worker-alpha' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
    });
    const negative = ledger.append({
      type: 'negative_result',
      summary: 'Full history injection exceeded token budget',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      evidence_event_ids: [workerCompleted.id],
    });
    ledger.append({
      type: 'finding',
      summary: 'Context pack kept useful memory under budget',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      evidence_event_ids: [workerCompleted.id],
    });
    const pack = buildContextPack({
      purpose: 'research',
      query: 'token budget',
      tokenBudget: 600,
      events: ledger.readAll(),
      scopeFilter: { project_id: 'proj-alpha', domain: 'metabot' },
    });

    const report = evaluateMemoryCore({
      events: ledger.readAll(),
      contextPacks: [pack],
      rawHistoryTokenEstimate: 5000,
      expectedNegativeResultEventIds: [negative.id],
    });

    expect(report.passed).toBe(true);
    expect(report.metrics.token_reduction_ratio).toBeGreaterThan(0);
    expect(report.metrics.unsafe_injection_count).toBe(0);
    expect(report.metrics.evidence_coverage_ratio).toBe(1);
    expect(report.metrics.negative_result_recall_ratio).toBe(1);
    expect(report.markdown).toContain('Memory Core Evaluation');
  });

  it('flags unsafe injected rejected, superseded, candidate, and private memory', () => {
    const rejected = ledger.append({
      type: 'finding',
      summary: 'Rejected claim',
      status: 'rejected',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
    });
    const oldDecision = ledger.append({
      type: 'decision',
      summary: 'Old decision',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
    });
    ledger.append({
      type: 'memory_superseded',
      summary: 'New decision supersedes old decision',
      supersedes: oldDecision.id,
      status: 'approved',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
      evidence_event_ids: [oldDecision.id],
    });
    const candidate = ledger.append({
      type: 'note',
      summary: 'Candidate note',
      status: 'candidate',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
    });
    const privateEvent = ledger.append({
      type: 'note',
      summary: 'Private note',
      actor: { kind: 'agent', id: 'agent-private' },
      scope: { project_id: 'proj-alpha', agent_id: 'agent-private', visibility: 'private' },
    });
    const unsafePack: ContextPack = {
      id: 'ctx_unsafe',
      purpose: 'planning',
      query: 'unsafe',
      token_budget: 1000,
      scope_filter: { project_id: 'proj-alpha', agent_id: 'agent-other' },
      included_event_ids: [rejected.id, oldDecision.id, candidate.id, privateEvent.id],
      included_memory_unit_ids: [],
      excluded_ids: [],
      markdown: 'unsafe',
      source_index: [],
      created_at: '2026-07-06T00:00:00.000Z',
    };

    const report = evaluateMemoryCore({
      events: ledger.readAll(),
      contextPacks: [unsafePack],
      thresholds: { minEvidenceCoverage: 0 },
    });

    expect(report.passed).toBe(false);
    expect(report.metrics.unsafe_injection_count).toBe(4);
    expect(report.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Context pack included rejected memory',
        'Context pack included superseded memory',
        'Context pack included candidate memory',
        'Context pack included private memory outside owner scope',
      ]),
    );
  });

  it('reports missing and orphan evidence separately', () => {
    ledger.append({
      type: 'finding',
      summary: 'Claim without evidence',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
    });
    ledger.append({
      type: 'negative_result',
      summary: 'Claim with orphan evidence',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
      evidence_event_ids: ['missing-event'],
    });

    const report = evaluateMemoryCore({
      events: ledger.readAll(),
      contextPacks: [],
      thresholds: { minEvidenceCoverage: 0.5 },
    });

    expect(report.passed).toBe(false);
    expect(report.metrics.claims_checked).toBe(2);
    expect(report.metrics.claims_with_evidence).toBe(0);
    expect(report.metrics.orphan_evidence_event_ids).toEqual(['missing-event']);
    expect(report.issues.some((issue) => issue.code === 'claim_without_evidence')).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'orphan_evidence_event')).toBe(true);
  });

  it('flags unsafe memory-unit-only context injection', () => {
    const candidate = ledger.append({
      type: 'note',
      summary: 'Candidate unit only',
      status: 'candidate',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
    });
    const privateEvent = ledger.append({
      type: 'note',
      summary: 'Private unit only',
      actor: { kind: 'agent', id: 'agent-private' },
      scope: { project_id: 'proj-alpha', agent_id: 'agent-private', visibility: 'private' },
    });
    const units = deriveMemoryUnits(ledger.readAll(), { includeRejected: true });
    const candidateUnit = units.find((unit) => unit.source_event_ids.includes(candidate.id));
    const privateUnit = units.find((unit) => unit.source_event_ids.includes(privateEvent.id));
    const unsafePack: ContextPack = {
      id: 'ctx_unit_unsafe',
      purpose: 'planning',
      query: 'unsafe units',
      token_budget: 1000,
      scope_filter: { project_id: 'proj-alpha', agent_id: 'agent-other' },
      included_event_ids: [],
      included_memory_unit_ids: [candidateUnit?.id ?? '', privateUnit?.id ?? ''],
      excluded_ids: [],
      markdown: 'unsafe',
      source_index: [],
      created_at: '2026-07-06T00:00:00.000Z',
    };

    const report = evaluateMemoryCore({
      events: ledger.readAll(),
      contextPacks: [unsafePack],
      thresholds: { minEvidenceCoverage: 0 },
    });

    expect(report.passed).toBe(false);
    expect(report.metrics.unsafe_injection_count).toBe(2);
    expect(report.issues.map((issue) => issue.memory_unit_id)).toEqual(
      expect.arrayContaining([candidateUnit?.id, privateUnit?.id]),
    );
  });

  it('counts negative-result recall through included memory unit ids', () => {
    const workerCompleted = ledger.append({
      type: 'worker_completed',
      summary: 'Worker completed with evidence',
      actor: { kind: 'worker', id: 'worker-alpha' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
    });
    const negative = ledger.append({
      type: 'negative_result',
      summary: 'Unit-only negative result',
      actor: { kind: 'agent', id: 'agent-memory' },
      scope: { project_id: 'proj-alpha', visibility: 'project' },
      evidence_event_ids: [workerCompleted.id],
    });
    const unit = deriveMemoryUnits(ledger.readAll()).find((candidate) =>
      candidate.source_event_ids.includes(negative.id),
    );
    const pack: ContextPack = {
      id: 'ctx_unit_recall',
      purpose: 'research',
      query: 'negative result',
      token_budget: 1000,
      scope_filter: { project_id: 'proj-alpha' },
      included_event_ids: [],
      included_memory_unit_ids: [unit?.id ?? ''],
      excluded_ids: [],
      markdown: 'unit-only recall',
      source_index: [],
      created_at: '2026-07-06T00:00:00.000Z',
    };

    const report = evaluateMemoryCore({
      events: ledger.readAll(),
      contextPacks: [pack],
      expectedNegativeResultEventIds: [negative.id],
    });

    expect(report.metrics.negative_result_recall_ratio).toBe(1);
    expect(report.issues.some((issue) => issue.code === 'negative_result_not_recalled')).toBe(false);
  });
});
