import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BotRegistry } from '../src/api/bot-registry.js';
import {
  MemoryIndexAutomation,
  P5_QUALITY_CONTRACT,
  buildStatusPatchPrompt,
  coalesceAdjacentDocumentEvents,
  evaluateP5QualityContract,
  isSemanticStatusCandidate,
  parseMemoryIndexAutomationMode,
  parseStatusPatchProposal,
  planStatusAutoApply,
  selectCandidateProjectRows,
  shouldInitializeMemoryIndexAutomation,
} from '../src/memory/index-automation.js';
import {
  type DocumentChangeEvent,
  type FullDocument,
  MemoryClient,
  MemoryClientRequestError,
} from '../src/memory/memory-client.js';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger()),
  } as any;
}

function event(overrides: Partial<DocumentChangeEvent> = {}): DocumentChangeEvent {
  return {
    id: 1,
    event_uuid: 'event-1',
    ts: '2026-07-28T00:00:00.000Z',
    op: 'update',
    cascade_of: null,
    doc_id: 'doc-1',
    actor: 'memory',
    origin: 'api',
    old_path: '/cargo1/todo/memory-todos',
    new_path: '/cargo1/todo/memory-todos',
    old_title: 'Memory ToDos',
    new_title: 'Memory ToDos',
    old_tags: ['memory'],
    new_tags: ['memory'],
    old_shared: true,
    new_shared: true,
    old_version: 3,
    new_version: 4,
    old_content_hash: 'old-hash',
    new_content_hash: 'new-hash',
    content_changed: true,
    changed_fields: ['content'],
    old_excerpt: 'old bounded excerpt',
    new_excerpt: 'new bounded excerpt',
    old_routing: {
      index_role: null,
      project_key: null,
      index_keywords: [],
      index_summary: null,
    },
    new_routing: {
      index_role: null,
      project_key: null,
      index_keywords: [],
      index_summary: null,
    },
    ...overrides,
  };
}

function statusDocument(content: string, overrides: Partial<FullDocument> = {}): FullDocument {
  return {
    id: 'status-doc',
    title: 'Project Progress Status',
    folder_id: 'status',
    path: '/cargo1/status/project-progress-status',
    content,
    tags: [],
    created_by: 'memory',
    created_at: '2026-07-28T00:00:00.000Z',
    updated_at: '2026-07-28T00:00:00.000Z',
    version: 7,
    index_role: null,
    project_key: null,
    index_keywords: [],
    index_summary: null,
    ...overrides,
  };
}

function statusMarkdown(rows: string[]): string {
  return [
    '# Status',
    '',
    '## Current Projects',
    '',
    '| Project | Status | Priority | Current State | Next Action | Compact Docs | Detail Docs |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

describe('MemoryIndexAutomation', () => {
  it('parses explicit modes and requires both full auto-apply gates', () => {
    expect(parseMemoryIndexAutomationMode(undefined)).toBe('off');
    expect(parseMemoryIndexAutomationMode('DRY-RUN')).toBe('dry-run');
    expect(shouldInitializeMemoryIndexAutomation('events')).toBe(false);
    expect(shouldInitializeMemoryIndexAutomation('full')).toBe(true);
    expect(() => parseMemoryIndexAutomationMode('automatic')).toThrow('Invalid METABOT_MEMORY_INDEX_AUTOMATION');
    expect(() => new MemoryIndexAutomation({ mode: 'full' }, {} as MemoryClient, {} as BotRegistry, logger())).toThrow(
      'METABOT_MEMORY_INDEX_QUALITY_APPROVED=true',
    );
    expect(() => new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true },
      {} as MemoryClient,
      {} as BotRegistry,
      logger(),
    )).toThrow(
      'METABOT_MEMORY_INDEX_AUTO_APPLY_ENABLED=true',
    );
    expect(() => new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true, autoApplyEnabled: true },
      {} as MemoryClient,
      {} as BotRegistry,
      logger(),
    )).not.toThrow();
  });

  it('maps only metabot-core 404 responses to a missing document', async () => {
    const server = createServer((request, response) => {
      if (request.url?.includes('missing')) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"not_found"}');
        return;
      }
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"unavailable"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('test server did not expose a TCP address');
    }
    const client = new MemoryClient(logger(), `http://127.0.0.1:${address.port}`, 'test-token');

    try {
      await expect(client.getDocument('/missing')).resolves.toBeNull();
      await expect(client.getDocument('/failure')).rejects.toMatchObject({
        name: 'MemoryClientRequestError',
        statusCode: 503,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('initializes a new full consumer at the event head without replaying history', async () => {
    const advanceDocumentChangeConsumer = vi.fn(async () => ({
      consumer: 'memory-status-full',
      last_event_id: 42,
      updated_at: '2026-07-28T00:00:00.000Z',
      initialized: true,
      latest_event_id: 42,
    }));
    const listDocumentChangeEvents = vi.fn();
    const get = vi.fn();
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'memory-status-full',
        last_event_id: 0,
        updated_at: '',
        initialized: false,
        latest_event_id: 42,
      })),
      advanceDocumentChangeConsumer,
      listDocumentChangeEvents,
      previewRoutingIndex: vi.fn(async () => ({ changed: false })),
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true, autoApplyEnabled: true, reconcileMs: 1 },
      memoryClient,
      { get } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('bootstrap');

    expect(advanceDocumentChangeConsumer).toHaveBeenCalledWith('memory-status-full', 42);
    expect(listDocumentChangeEvents).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    service.destroy();
  });

  it('coalesces adjacent same-document and folder-cascade events', () => {
    const groups = coalesceAdjacentDocumentEvents([
      event({ id: 3, doc_id: 'a' }),
      event({ id: 1, doc_id: 'a' }),
      event({ id: 2, doc_id: 'b' }),
    ]);
    expect(groups.map((group) => group.map((item) => item.id))).toEqual([[1], [2], [3]]);
    expect(
      coalesceAdjacentDocumentEvents([
        event({ id: 1, doc_id: 'a', cascade_of: 'folder-op' }),
        event({ id: 2, doc_id: 'b', cascade_of: 'folder-op' }),
      ]).map((group) => group.map((item) => item.id)),
    ).toEqual([[1, 2]]);
  });

  it('fails closed without a model call when a coalesced group exceeds the prompt limit', async () => {
    const events = Array.from({ length: 13 }, (_, index) => event({ id: index + 1 }));
    const recordDocumentChangeProcessing = vi.fn(async () => ({
      consumer: 'test-consumer',
      last_event_id: 13,
      updated_at: '',
    }));
    const get = vi.fn();
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'test-consumer',
        last_event_id: 0,
        updated_at: '',
      })),
      listDocumentChangeEvents: vi.fn(async () => ({ events, next_after: 13 })),
      recordDocumentChangeProcessing,
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'dry-run', consumer: 'test-consumer', reconcileMs: 1 },
      memoryClient,
      { get } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('oversized-group');

    expect(get).not.toHaveBeenCalled();
    expect(recordDocumentChangeProcessing).toHaveBeenCalledWith(expect.objectContaining({
      status: 'proposed',
      event_ids: events.map((item) => item.id),
      proposal: expect.objectContaining({
        reason: 'event_group_exceeds_prompt_limit',
        event_count: 13,
        prompt_event_limit: 12,
      }),
    }));
    service.destroy();
  });

  it('filters automation targets and indexer-origin writes deterministically', () => {
    expect(isSemanticStatusCandidate([event()], '/cargo1')).toBe(true);
    expect(
      isSemanticStatusCandidate(
        [
          event({
            old_path: '/cargo1/status/project-progress-status',
            new_path: '/cargo1/status/project-progress-status',
          }),
        ],
        '/cargo1',
      ),
    ).toBe(false);
    expect(isSemanticStatusCandidate([event({ origin: 'indexer' })], '/cargo1')).toBe(false);
    expect(
      isSemanticStatusCandidate(
        [
          event({
            content_changed: false,
            changed_fields: ['updated_at'],
          }),
        ],
        '/cargo1',
      ),
    ).toBe(false);
  });

  it('selects bounded candidate rows and validates strict one-row proposals', () => {
    const markdown = [
      '# Status',
      '',
      '## Current Projects',
      '',
      '| Project | Status | Next action |',
      '| --- | --- | --- |',
      '| Memory | active | inspect |',
      '| Dashboard | waiting | design |',
      '| Personal | active | migrate |',
      '| Rules | blocked | approve |',
    ].join('\n');
    const candidateRows = selectCandidateProjectRows(markdown, [event()], 3);
    expect(candidateRows).toHaveLength(3);
    expect(candidateRows[0]).toContain('| Memory |');

    const prompt = buildStatusPatchPrompt([event()], 9, candidateRows);
    expect(prompt).toContain('bounded proposal');
    expect(prompt).toContain('old bounded excerpt');
    expect(prompt).not.toContain('| Rules | blocked | approve |');

    const response = JSON.stringify({
      decision: 'propose',
      project: 'Memory',
      replacement_row: '| Memory | active | run dry-run |',
      rationale: 'The next action changed.',
      source_event_ids: [1],
      expected_version: 9,
    });
    expect(parseStatusPatchProposal(response, [event()], 9, candidateRows)).toMatchObject({
      decision: 'propose',
      project: 'Memory',
      expected_version: 9,
    });
    expect(() => parseStatusPatchProposal(response.replace('[1]', '[2]'), [event()], 9, candidateRows)).toThrow(
      'source_event_ids',
    );
    expect(() =>
      parseStatusPatchProposal(
        response.replace('| Memory | active | run dry-run |', '| Memory | active |'),
        [event()],
        9,
        candidateRows,
      ),
    ).toThrow('column count');
  });

  it('plans only evidence-bound changes to the three allowed status columns', () => {
    const original = '| Memory | active | 1 | P4 is complete | implement P5 | `/todo` | `/dev` |';
    const document = statusDocument(statusMarkdown([original]));
    const sourceEvent = event({
      new_excerpt: 'MEM-001 is in_progress; P5 tests passed. Next: merge MEM-001.',
    });
    const proposal = {
      decision: 'propose' as const,
      project: 'Memory',
      replacement_row: '| Memory | in_progress | 1 | P5 tests passed | merge MEM-001 | `/todo` | `/dev` |',
      rationale: 'P5 passed.',
      source_event_ids: [sourceEvent.id],
      expected_version: document.version,
    };

    const plan = planStatusAutoApply(document, proposal, [sourceEvent]);

    expect(plan).toMatchObject({
      outcome: 'apply',
      reason: 'single_row_evidence_bound_change',
      previous_row: original,
      changed_columns: ['Status', 'Current State', 'Next Action'],
    });
    expect(plan.content).toContain(proposal.replacement_row);
    expect(plan.content).not.toContain(original);
  });

  it('downgrades structural, ambiguous, and unsupported proposals to review', () => {
    const original = '| Memory | active | 1 | P4 is complete | implement P5 | `/todo` | `/dev` |';
    const sourceEvent = event({ new_excerpt: 'P5 tests are running.' });
    const base = {
      decision: 'propose' as const,
      project: 'Memory',
      rationale: 'Update status.',
      source_event_ids: [sourceEvent.id],
      expected_version: 7,
    };
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([original])),
      { ...base, replacement_row: '| Memory | active | 0 | P4 is complete | implement P5 | `/todo` | `/dev` |' },
      [sourceEvent],
    )).toMatchObject({ outcome: 'review', reason: 'non_status_column_changed' });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([original])),
      { ...base, replacement_row: '| Memory | deployed | 1 | production rollout complete | done | `/todo` | `/dev` |' },
      [event({ new_path: '/cargo1/deployed/memory', new_excerpt: 'P5 tests are running.' })],
    )).toMatchObject({
      outcome: 'review',
      reason: 'unsupported_status_facts',
      unsupported_tokens: expect.arrayContaining(['deployed', 'production']),
    });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([original, original])),
      { ...base, replacement_row: '| Memory | active | 1 | P5 tests | implement P5 | `/todo` | `/dev` |' },
      [sourceEvent],
    )).toMatchObject({ outcome: 'review', reason: 'project_row_not_unique' });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([
        '| Memory | active | 1 | P5 is not deployed | implement P5 | `/todo` | `/dev` |',
      ])),
      { ...base, replacement_row: '| Memory | active | 1 | P5 is deployed | implement P5 | `/todo` | `/dev` |' },
      [event({ new_excerpt: 'P5 deployment status changed.' })],
    )).toMatchObject({ outcome: 'review', reason: 'negation_removed' });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([
        '| Memory | active | 1 | P5 blocked | implement P5 | `/todo` | `/dev` |',
      ])),
      { ...base, replacement_row: '| Memory | active | 1 | P5 | implement P5 | `/todo` | `/dev` |' },
      [event({ new_excerpt: 'P5 changed.' })],
    )).toMatchObject({ outcome: 'review', reason: 'unsupported_fact_removal' });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([
        '| Memory | active | 1 | deploy before review | implement P5 | `/todo` | `/dev` |',
      ])),
      { ...base, replacement_row: '| Memory | active | 1 | review before deploy | implement P5 | `/todo` | `/dev` |' },
      [event({ new_excerpt: 'Routine P5 note.' })],
    )).toMatchObject({ outcome: 'review', reason: 'relational_rewrite_not_in_evidence' });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([
        '| Alpha | active | 1 | tests pending | review | `/alpha` | `/dev/alpha` |',
        '| Beta | active | 1 | tests pending | review | `/beta` | `/dev/beta` |',
      ])),
      {
        ...base,
        project: 'Beta',
        replacement_row: '| Beta | active | 1 | tests passed | review | `/beta` | `/dev/beta` |',
      },
      [event({
        old_path: '/cargo1/todo/alpha',
        new_path: '/cargo1/todo/alpha',
        old_title: 'Alpha',
        new_title: 'Alpha',
        old_tags: ['alpha'],
        new_tags: ['alpha'],
        new_excerpt: 'Alpha tests passed.',
      })],
    )).toMatchObject({ outcome: 'review', reason: 'project_not_bound_to_source_events' });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([
        '| Memory | active | 1 | next review | implement P5 | `/todo` | `/dev` |',
      ])),
      { ...base, replacement_row: '| Memory | active | 1 | current review | implement P5 | `/todo` | `/dev` |' },
      [event({ new_excerpt: 'Memory review note.' })],
    )).toMatchObject({
      outcome: 'review',
      reason: 'unsupported_status_facts',
      unsupported_tokens: ['current'],
    });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([
        '| Memory | active | 1 | P5 pending | implement P5 | `/todo` | `/dev` |',
      ])),
      { ...base, replacement_row: '| Memory | active | 1 | P5 deployed | implement P5 | `/todo` | `/dev` |' },
      [event({ new_excerpt: 'Memory P5 is not deployed.' })],
    )).toMatchObject({
      outcome: 'review',
      reason: 'unsupported_status_facts',
      unsupported_tokens: ['deployed'],
    });
    expect(planStatusAutoApply(
      statusDocument(statusMarkdown([
        '| Memory | active | 1 | P5 pending | implement P5 | `/todo` | `/dev` |',
      ])),
      { ...base, replacement_row: '| Memory | active | 1 | P5 deployed | implement P5 | `/todo` | `/dev` |' },
      [event({ new_excerpt: 'Memory P5 is not deployed. Memory P5 deployed.' })],
    )).toMatchObject({ outcome: 'review', reason: 'unsupported_status_facts' });
  });

  it('evaluates the quantitative P5 quality contract fail closed', () => {
    const original = '| Memory | active | 1 | P4 complete | implement P5 | `/todo` | `/dev` |';
    const document = statusDocument(statusMarkdown([original]));
    const classify = (
      expected: 'apply' | 'review' | 'skip',
      replacementRow: string | null,
      sourceEvent: DocumentChangeEvent,
      decision: 'skip' | 'propose' = 'propose',
    ) => ({
      expected,
      actual: planStatusAutoApply(document, {
        decision,
        project: decision === 'skip' ? null : 'Memory',
        replacement_row: replacementRow,
        rationale: 'Labeled quality case.',
        source_event_ids: [sourceEvent.id],
        expected_version: document.version,
      }, [sourceEvent]).outcome,
    });
    const passing = [
      ...Array.from({ length: 10 }, (_, index) => classify(
        'apply',
        `| Memory | active | 1 | P5 case ${index} passed | merge case ${index} | \`/todo\` | \`/dev\` |`,
        event({ id: index + 1, new_excerpt: `P5 case ${index} passed; merge case ${index}.` }),
      )),
      ...Array.from({ length: 5 }, (_, index) => classify(
        'review',
        `| Memory | active | 0 | P4 complete | implement P5 | \`/todo\` | \`/dev\` |`,
        event({ id: index + 11, new_excerpt: 'Priority is unchanged.' }),
      )),
      ...Array.from({ length: 5 }, (_, index) => classify(
        'review',
        '| Memory | deployed | 1 | production complete | done | `/todo` | `/dev` |',
        event({ id: index + 16, new_excerpt: 'P5 tests are running.' }),
      )),
      ...Array.from({ length: 10 }, (_, index) => classify(
        'skip',
        null,
        event({ id: index + 21, new_excerpt: 'No project status change.' }),
        'skip',
      )),
    ];
    expect(P5_QUALITY_CONTRACT).toMatchObject({
      minimum_labeled_samples: 30,
      minimum_auto_apply_precision: 1,
      maximum_critical_errors: 0,
    });
    expect(evaluateP5QualityContract(passing)).toMatchObject({
      passed: true,
      sample_count: 30,
      material_sample_count: 20,
      auto_apply_sample_count: 10,
      decision_accuracy: 1,
      auto_apply_precision: 1,
      failures: [],
    });
    expect(evaluateP5QualityContract([
      ...passing.slice(0, 29),
      { expected: 'review', actual: 'apply', critical_error: true },
    ])).toMatchObject({
      passed: false,
      auto_apply_precision: 10 / 11,
      critical_errors: 1,
      failures: expect.arrayContaining([
        'auto_apply_precision_below_threshold',
        'critical_errors_present',
      ]),
    });
  });

  it('applies one verified status row in full mode and records an audit trail', async () => {
    const sourceEvent = event({
      new_excerpt: 'MEM-001 is in_progress; P5 tests passed. Next: merge MEM-001.',
    });
    const original = '| Memory | active | 1 | P4 is complete | implement P5 | `/todo` | `/dev` |';
    const replacement = '| Memory | in_progress | 1 | P5 tests passed | merge MEM-001 | `/todo` | `/dev` |';
    const document = statusDocument(statusMarkdown([original]));
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: JSON.stringify({
        decision: 'propose',
        project: 'Memory',
        replacement_row: replacement,
        rationale: 'P5 passed.',
        source_event_ids: [sourceEvent.id],
        expected_version: document.version,
      }),
      durationMs: 12,
    }));
    const recordDocumentChangeProcessing = vi.fn(async () => ({
      consumer: 'memory-status-full',
      last_event_id: sourceEvent.id,
      updated_at: '2026-07-28T00:00:01.000Z',
    }));
    const updateDocument = vi.fn(async (_id: string, patch: { content?: string }) => ({
      ...document,
      content: patch.content || '',
      version: document.version + 1,
    }));
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'memory-status-full',
        last_event_id: 0,
        updated_at: '',
        initialized: true,
        latest_event_id: sourceEvent.id,
      })),
      listDocumentChangeEvents: vi.fn(async () => ({ events: [sourceEvent], next_after: sourceEvent.id })),
      getDocument: vi.fn(async () => document),
      updateDocument,
      recordDocumentChangeProcessing,
      listDocumentChangeProcessing: vi.fn(async () => []),
      previewRoutingIndex: vi.fn(async () => ({ changed: false })),
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true, autoApplyEnabled: true, reconcileMs: 1 },
      memoryClient,
      { get: vi.fn(() => ({ bridge: { executeApiTask } })) } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('p5-test');

    expect(updateDocument).toHaveBeenCalledWith('status-doc', {
      content: expect.stringContaining(replacement),
      expected_version: 7,
      change_origin: 'reconciler',
    });
    expect(recordDocumentChangeProcessing).toHaveBeenCalledWith(expect.objectContaining({
      consumer: 'memory-status-full',
      status: 'applied',
      review_outcome: 'accepted',
      proposal: expect.objectContaining({
        automation_outcome: 'applied',
        automation_reason: 'single_row_evidence_bound_change',
        applied_version: 8,
        content_before_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        content_after_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source_events: [expect.objectContaining({
          id: sourceEvent.id,
          new_excerpt: expect.stringContaining('P5 tests passed'),
        })],
      }),
    }));
    service.destroy();
  });

  it('retries a deterministic CAS conflict without advancing the full consumer', async () => {
    const sourceEvent = event({ new_excerpt: 'P5 tests passed. Next: merge MEM-001.' });
    const original = '| Memory | active | 1 | P4 complete | implement P5 | `/todo` | `/dev` |';
    const replacement = '| Memory | active | 1 | P5 tests passed | merge MEM-001 | `/todo` | `/dev` |';
    const document = statusDocument(statusMarkdown([original]));
    const recordDocumentChangeProcessing = vi.fn(async () => ({
      consumer: 'memory-status-full',
      last_event_id: 0,
      updated_at: '',
    }));
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'memory-status-full',
        last_event_id: 0,
        updated_at: '',
        initialized: true,
        latest_event_id: sourceEvent.id,
      })),
      listDocumentChangeEvents: vi.fn(async () => ({ events: [sourceEvent], next_after: sourceEvent.id })),
      getDocument: vi.fn(async () => document),
      updateDocument: vi.fn(async () => {
        throw new MemoryClientRequestError('metabot-core 409: version_conflict', 409);
      }),
      recordDocumentChangeProcessing,
      listDocumentChangeProcessing: vi.fn(async () => []),
      previewRoutingIndex: vi.fn(async () => ({ changed: false })),
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true, autoApplyEnabled: true, reconcileMs: 1 },
      memoryClient,
      {
        get: vi.fn(() => ({
          bridge: {
            executeApiTask: vi.fn(async () => ({
              success: true,
              responseText: JSON.stringify({
                decision: 'propose',
                project: 'Memory',
                replacement_row: replacement,
                rationale: 'P5 passed.',
                source_event_ids: [sourceEvent.id],
                expected_version: document.version,
              }),
              durationMs: 1,
            })),
          },
        })),
      } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('cas-conflict');

    expect(recordDocumentChangeProcessing).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      advance_cursor: false,
      error: expect.stringContaining('version_conflict'),
      increment_attempts: true,
    }));
    service.destroy();
  });

  it('preserves a pending audit without consuming retry budget on a transient status-write failure', async () => {
    const sourceEvent = event({ new_excerpt: 'P5 tests passed. Next: merge MEM-001.' });
    const original = '| Memory | active | 1 | P4 complete | implement P5 | `/todo` | `/dev` |';
    const replacement = '| Memory | active | 1 | P5 tests passed | merge MEM-001 | `/todo` | `/dev` |';
    const document = statusDocument(statusMarkdown([original]));
    const recordDocumentChangeProcessing = vi.fn(async () => ({
      consumer: 'memory-status-full',
      last_event_id: 0,
      updated_at: '',
    }));
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'memory-status-full',
        last_event_id: 0,
        updated_at: '',
        initialized: true,
        latest_event_id: sourceEvent.id,
      })),
      listDocumentChangeEvents: vi.fn(async () => ({ events: [sourceEvent], next_after: sourceEvent.id })),
      getDocument: vi.fn(async () => document),
      updateDocument: vi.fn(async () => {
        throw new MemoryClientRequestError('metabot-core 503: unavailable', 503);
      }),
      recordDocumentChangeProcessing,
      listDocumentChangeProcessing: vi.fn(async () => []),
      previewRoutingIndex: vi.fn(async () => ({ changed: false })),
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true, autoApplyEnabled: true, reconcileMs: 1 },
      memoryClient,
      {
        get: vi.fn(() => ({
          bridge: {
            executeApiTask: vi.fn(async () => ({
              success: true,
              responseText: JSON.stringify({
                decision: 'propose',
                project: 'Memory',
                replacement_row: replacement,
                rationale: 'P5 passed.',
                source_event_ids: [sourceEvent.id],
                expected_version: document.version,
              }),
              durationMs: 1,
            })),
          },
        })),
      } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('transient-write');

    expect(recordDocumentChangeProcessing).toHaveBeenCalledTimes(1);
    expect(recordDocumentChangeProcessing).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      advance_cursor: false,
      increment_attempts: false,
    }));
    service.destroy();
  });

  it('recovers a completed status write from its durable pending audit', async () => {
    const sourceEvent = event({ new_excerpt: 'P5 tests passed.' });
    const replacement = '| Memory | active | 1 | P5 tests passed | merge | `/todo` | `/dev` |';
    const content = statusMarkdown([replacement]);
    const current = statusDocument(content, { version: 8 });
    const pendingAudit = {
      automation_outcome: 'apply_pending',
      source_event_ids: [sourceEvent.id],
      status_document_id: current.id,
      expected_version: 7,
      content_after_sha256: createHash('sha256').update(content).digest('hex'),
    };
    const recordDocumentChangeProcessing = vi.fn(async () => ({
      consumer: 'memory-status-full',
      last_event_id: sourceEvent.id,
      updated_at: '',
    }));
    const executeApiTask = vi.fn();
    const updateDocument = vi.fn();
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'memory-status-full',
        last_event_id: 0,
        updated_at: '',
        initialized: true,
        latest_event_id: sourceEvent.id,
      })),
      listDocumentChangeEvents: vi.fn(async () => ({ events: [sourceEvent], next_after: sourceEvent.id })),
      listDocumentChangeProcessing: vi.fn(async () => [{
        consumer: 'memory-status-full',
        event_id: sourceEvent.id,
        status: 'pending',
        attempts: 1,
        proposal_ref: 'memory-status-full:1',
        proposal_json: pendingAudit,
        tokens_in: 1,
        tokens_out: 1,
        latency_ms: 1,
        review_outcome: null,
        error: null,
        updated_at: '',
      }]),
      getDocument: vi.fn(async () => current),
      updateDocument,
      recordDocumentChangeProcessing,
      previewRoutingIndex: vi.fn(async () => ({ changed: false })),
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true, autoApplyEnabled: true, reconcileMs: 1 },
      memoryClient,
      { get: vi.fn(() => ({ bridge: { executeApiTask } })) } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('recover');

    expect(executeApiTask).not.toHaveBeenCalled();
    expect(updateDocument).not.toHaveBeenCalled();
    expect(recordDocumentChangeProcessing).toHaveBeenCalledWith(expect.objectContaining({
      status: 'applied',
      increment_attempts: false,
      proposal: expect.objectContaining({
        automation_outcome: 'applied_recovered',
        applied_version: 8,
      }),
    }));
    service.destroy();
  });

  it('downgrades an ambiguous pending-write recovery to manual review', async () => {
    const sourceEvent = event({ new_excerpt: 'P5 tests passed.' });
    const before = statusMarkdown([
      '| Memory | active | 1 | P4 complete | implement P5 | `/todo` | `/dev` |',
    ]);
    const after = statusMarkdown([
      '| Memory | active | 1 | P5 tests passed | merge | `/todo` | `/dev` |',
    ]);
    const humanEdited = statusDocument(`${after}\n\nHuman follow-up`, { version: 9 });
    const pendingAudit = {
      automation_outcome: 'apply_pending',
      source_event_ids: [sourceEvent.id],
      status_document_id: humanEdited.id,
      expected_version: 7,
      content_before_sha256: createHash('sha256').update(before).digest('hex'),
      content_after_sha256: createHash('sha256').update(after).digest('hex'),
    };
    const recordDocumentChangeProcessing = vi.fn(async () => ({
      consumer: 'memory-status-full',
      last_event_id: sourceEvent.id,
      updated_at: '',
    }));
    const executeApiTask = vi.fn();
    const updateDocument = vi.fn();
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'memory-status-full',
        last_event_id: 0,
        updated_at: '',
        initialized: true,
        latest_event_id: sourceEvent.id,
      })),
      listDocumentChangeEvents: vi.fn(async () => ({ events: [sourceEvent], next_after: sourceEvent.id })),
      listDocumentChangeProcessing: vi.fn(async () => [{
        consumer: 'memory-status-full',
        event_id: sourceEvent.id,
        status: 'pending',
        attempts: 0,
        proposal_ref: 'memory-status-full:1',
        proposal_json: pendingAudit,
        tokens_in: 1,
        tokens_out: 1,
        latency_ms: 1,
        review_outcome: null,
        error: null,
        updated_at: '',
      }]),
      getDocument: vi.fn(async () => humanEdited),
      updateDocument,
      recordDocumentChangeProcessing,
      previewRoutingIndex: vi.fn(async () => ({ changed: false })),
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'full', qualityApproved: true, autoApplyEnabled: true, reconcileMs: 1 },
      memoryClient,
      { get: vi.fn(() => ({ bridge: { executeApiTask } })) } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('ambiguous-recovery');

    expect(executeApiTask).not.toHaveBeenCalled();
    expect(updateDocument).not.toHaveBeenCalled();
    expect(recordDocumentChangeProcessing).toHaveBeenCalledWith(expect.objectContaining({
      status: 'proposed',
      increment_attempts: false,
      proposal: expect.objectContaining({
        automation_outcome: 'recovery_requires_review',
        automation_reason: 'pending_write_state_is_ambiguous',
        recovery_observed_version: 9,
      }),
    }));
    service.destroy();
  });

  it('records a bounded proposal without writing the status document', async () => {
    const sourceEvent = event();
    const statusRow = '| Memory | active | inspect |';
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: JSON.stringify({
        decision: 'propose',
        project: 'Memory',
        replacement_row: '| Memory | active | run dry-run |',
        rationale: 'The next action changed.',
        source_event_ids: [sourceEvent.id],
        expected_version: 7,
      }),
      durationMs: 12,
    }));
    const recordDocumentChangeProcessing = vi.fn(async () => ({
      consumer: 'test-consumer',
      last_event_id: sourceEvent.id,
      updated_at: '2026-07-28T00:00:01.000Z',
    }));
    const updateDocument = vi.fn();
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: { dead_references: 0 } })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'test-consumer',
        last_event_id: 0,
        updated_at: '',
      })),
      listDocumentChangeEvents: vi.fn(async () => ({
        events: [sourceEvent],
        next_after: sourceEvent.id,
      })),
      getDocument: vi.fn(async () => ({
        id: 'status-doc',
        title: 'Project Progress Status',
        folder_id: 'status',
        path: '/cargo1/status/project-progress-status',
        content: [
          '# Status',
          '',
          '## Current Projects',
          '',
          '| Project | Status | Next action |',
          '| --- | --- | --- |',
          statusRow,
        ].join('\n'),
        tags: [],
        created_by: 'memory',
        created_at: '2026-07-28T00:00:00.000Z',
        updated_at: '2026-07-28T00:00:00.000Z',
        version: 7,
        index_role: null,
        project_key: null,
        index_keywords: [],
        index_summary: null,
      })),
      recordDocumentChangeProcessing,
      listDocumentChangeProcessing: vi.fn(async () => []),
      updateDocument,
    } as unknown as MemoryClient;
    const registry = {
      get: vi.fn(() => ({ bridge: { executeApiTask } })),
    } as unknown as BotRegistry;
    const service = new MemoryIndexAutomation(
      {
        mode: 'dry-run',
        consumer: 'test-consumer',
        reconcileMs: 1,
      },
      memoryClient,
      registry,
      logger(),
    );

    await service.checkNow('test');

    expect(executeApiTask).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: [],
        maxTurns: 1,
        sendCards: false,
      }),
    );
    expect(recordDocumentChangeProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'proposed',
        event_ids: [sourceEvent.id],
        through_event_id: sourceEvent.id,
        proposal: expect.objectContaining({
          replacement_row: '| Memory | active | run dry-run |',
          expected_version: 7,
        }),
      }),
    );
    expect(updateDocument).not.toHaveBeenCalled();
    service.destroy();
  });

  it('checkpoints an exhausted scoped feed without invoking a bot', async () => {
    const advanceDocumentChangeConsumer = vi.fn(async () => ({
      consumer: 'test-consumer',
      last_event_id: 8,
      updated_at: '2026-07-28T00:00:00.000Z',
    }));
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'test-consumer',
        last_event_id: 3,
        updated_at: '',
      })),
      listDocumentChangeEvents: vi.fn(async () => ({
        events: [],
        next_after: 8,
      })),
      advanceDocumentChangeConsumer,
    } as unknown as MemoryClient;
    const get = vi.fn();
    const service = new MemoryIndexAutomation(
      { mode: 'dry-run', consumer: 'test-consumer', reconcileMs: 1 },
      memoryClient,
      { get } as unknown as BotRegistry,
      logger(),
    );

    await service.checkNow('test');

    expect(advanceDocumentChangeConsumer).toHaveBeenCalledWith('test-consumer', 8);
    expect(get).not.toHaveBeenCalled();
    service.destroy();
  });

  it('pauses without consuming retry budget when metabot-core is unavailable', async () => {
    const sourceEvent = event();
    const recordDocumentChangeProcessing = vi.fn();
    const listDocumentChangeProcessing = vi.fn();
    const warn = vi.fn();
    const memoryClient = {
      reconcileIndexes: vi.fn(async () => ({ summary: {} })),
      getDocumentChangeConsumerState: vi.fn(async () => ({
        consumer: 'test-consumer',
        last_event_id: 0,
        updated_at: '',
      })),
      listDocumentChangeEvents: vi.fn(async () => ({
        events: [sourceEvent],
        next_after: sourceEvent.id,
      })),
      getDocument: vi.fn(async () => {
        throw new MemoryClientRequestError('metabot-core 503: unavailable', 503);
      }),
      recordDocumentChangeProcessing,
      listDocumentChangeProcessing,
    } as unknown as MemoryClient;
    const service = new MemoryIndexAutomation(
      { mode: 'dry-run', consumer: 'test-consumer', reconcileMs: 1 },
      memoryClient,
      {
        get: vi.fn(() => ({ bridge: { executeApiTask: vi.fn() } })),
      } as unknown as BotRegistry,
      {
        ...logger(),
        warn,
      },
    );

    await service.checkNow('test');

    expect(recordDocumentChangeProcessing).not.toHaveBeenCalled();
    expect(listDocumentChangeProcessing).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        eventIds: [sourceEvent.id],
      }),
      'Memory status proposal paused after metabot-core request failure',
    );
    service.destroy();
  });
});
