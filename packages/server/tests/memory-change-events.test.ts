import { afterEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/auth/credentials.js';
import * as memoryRoutes from '../src/memory/memory-routes.js';
import { reconcileMemoryIndexes } from '../src/memory/index-reconciliation.js';
import { makeKit, type TestKit } from './helpers.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function issue(name: string, role: 'admin' | 'member' = 'admin'): Credential {
  const { credential } = kit!.credentials.issue({
    botName: name,
    ownerName: name,
    role,
  });
  return kit!.credentials.findById(credential.id)!;
}

describe('MetaMemory document change outbox', () => {
  it('emits versioned create/update/delete events and rejects stale CAS writes', () => {
    kit = makeKit('memory-change-crud');
    const admin = issue('admin');
    const created = kit.memory.createDocument(
      {
        title: 'Memory task',
        path: '/cargo1/todo/memory-task',
        content: 'old content',
        tags: ['memory'],
        shared: true,
      },
      admin,
    );

    expect(created.version).toBe(1);
    const createEvent = kit.memory.listDocumentChangeEvents()[0];
    expect(createEvent).toMatchObject({
      op: 'create',
      doc_id: created.id,
      old_version: null,
      new_version: 1,
      content_changed: true,
      old_excerpt: null,
      new_excerpt: 'old content',
      new_routing: {
        index_role: null,
        project_key: null,
        index_keywords: [],
        index_summary: null,
      },
    });

    const updated = kit.memory.updateDocument(
      created.id,
      {
        content: 'new content',
        expected_version: 1,
      },
      admin,
    )!;
    expect(updated.version).toBe(2);
    expect(kit.memory.listDocumentChangeEvents()[1]).toMatchObject({
      op: 'update',
      old_version: 1,
      new_version: 2,
      old_excerpt: 'old content',
      new_excerpt: 'new content',
      changed_fields: ['content'],
    });

    expect(() =>
      kit!.memory.updateDocument(
        created.id,
        {
          content: 'stale overwrite',
          expected_version: 1,
        },
        admin,
      ),
    ).toThrow('version_conflict');
    expect(
      memoryRoutes.updateDocument(
        kit.memory,
        created.id,
        { content: 'stale route overwrite', expected_version: 1 },
        admin,
      ),
    ).toEqual({
      status: 409,
      body: {
        error: 'version_conflict',
        expected_version: 1,
        actual_version: 2,
      },
    });
    expect(kit.memory.getDocument(created.id, admin)).toMatchObject({
      content: 'new content',
      version: 2,
    });
    expect(kit.memory.getDocumentChangeStats().total).toBe(2);

    expect(kit.memory.deleteDocument(created.id, admin)).toBe(true);
    expect(kit.memory.listDocumentChangeEvents()[2]).toMatchObject({
      op: 'delete',
      old_version: 2,
      new_version: null,
      old_excerpt: 'new content',
      new_excerpt: null,
    });
  });

  it('allows only admins to tag automation writes with a trusted origin', () => {
    kit = makeKit('memory-change-trusted-origin');
    const admin = issue('admin');
    const member = issue('member', 'member');
    const created = kit.memory.createDocument(
      {
        title: 'Project Status',
        path: '/cargo1/status/project-status',
        content: 'before',
        shared: true,
      },
      admin,
    );

    expect(memoryRoutes.updateDocument(
      kit.memory,
      created.id,
      { content: 'spoofed', change_origin: 'reconciler' },
      member,
    )).toEqual({ status: 403, body: { error: 'admin_required' } });
    expect(memoryRoutes.updateDocument(
      kit.memory,
      created.id,
      { content: 'after', expected_version: 1, change_origin: 'reconciler' },
      admin,
    )).toMatchObject({ status: 200, body: { content: 'after', version: 2 } });
    expect(kit.memory.listDocumentChangeEvents().at(-1)).toMatchObject({
      origin: 'reconciler',
      old_version: 1,
      new_version: 2,
    });
  });

  it('emits one move/delete event per document for folder operations', () => {
    kit = makeKit('memory-change-folders');
    const admin = issue('admin');
    const first = kit.memory.createDocument(
      {
        title: 'First',
        path: '/cargo1/source/first',
        content: 'one',
      },
      admin,
    );
    const second = kit.memory.createDocument(
      {
        title: 'Second',
        path: '/cargo1/source/nested/second',
        content: 'two',
      },
      admin,
    );
    const beforeMove = kit.memory.getDocumentChangeStats().latest_event_id;

    kit.memory.updateFolder('/cargo1/source', { path: '/cargo1/moved' }, admin);
    const moveEvents = kit.memory.listDocumentChangeEvents({ after: beforeMove });
    expect(moveEvents).toHaveLength(2);
    expect(moveEvents.every((event) => event.op === 'move')).toBe(true);
    expect(new Set(moveEvents.map((event) => event.cascade_of)).size).toBe(1);
    expect(moveEvents.map((event) => event.doc_id).sort()).toEqual([first.id, second.id].sort());
    expect(moveEvents.map((event) => event.new_version)).toEqual([2, 2]);
    expect(moveEvents.every((event) => event.content_changed === false)).toBe(true);

    const beforeDelete = kit.memory.getDocumentChangeStats().latest_event_id;
    kit.memory.deleteFolder('/cargo1/moved', admin);
    const deleteEvents = kit.memory.listDocumentChangeEvents({ after: beforeDelete });
    expect(deleteEvents).toHaveLength(2);
    expect(deleteEvents.every((event) => event.op === 'delete')).toBe(true);
    expect(new Set(deleteEvents.map((event) => event.cascade_of)).size).toBe(1);
    expect(kit.memory.getDocument(first.id, admin)).toBeNull();
    expect(kit.memory.getDocument(second.id, admin)).toBeNull();
  });

  it('keeps SQL wildcard characters isolated during folder move and delete cascades', () => {
    kit = makeKit('memory-change-folder-wildcards');
    const admin = issue('admin');
    const cases = [
      { source: '/cargo1/a_b', sibling: '/cargo1/axb', moved: '/cargo1/moved-underscore' },
      { source: '/cargo1/c%d', sibling: '/cargo1/cXYZd', moved: '/cargo1/moved-percent' },
    ];

    for (const [index, paths] of cases.entries()) {
      const movedDoc = kit.memory.createDocument(
        {
          title: `Moved ${index}`,
          path: `${paths.source}/move-me`,
          content: 'move me',
        },
        admin,
      );
      const siblingDoc = kit.memory.createDocument(
        {
          title: `Sibling ${index}`,
          path: `${paths.sibling}/keep-me`,
          content: 'keep me',
        },
        admin,
      );
      const beforeMove = kit.memory.getDocumentChangeStats().latest_event_id;

      kit.memory.updateFolder(paths.source, { path: paths.moved }, admin);

      expect(kit.memory.getDocument(movedDoc.id, admin)).toMatchObject({
        path: `${paths.moved}/move-me`,
        version: 2,
      });
      expect(kit.memory.getDocument(siblingDoc.id, admin)).toMatchObject({
        path: `${paths.sibling}/keep-me`,
        version: 1,
      });
      expect(
        kit.memory.listDocumentChangeEvents({ after: beforeMove }).map((event) => event.doc_id),
      ).toEqual([movedDoc.id]);

      const beforeDelete = kit.memory.getDocumentChangeStats().latest_event_id;
      kit.memory.deleteFolder(paths.moved, admin);

      expect(kit.memory.getDocument(movedDoc.id, admin)).toBeNull();
      expect(kit.memory.getDocument(siblingDoc.id, admin)).toMatchObject({
        path: `${paths.sibling}/keep-me`,
        version: 1,
      });
      expect(
        kit.memory.listDocumentChangeEvents({ after: beforeDelete }).map((event) => event.doc_id),
      ).toEqual([movedDoc.id]);
    }
  });

  it('keeps document and folder prefix queries segment-bound and wildcard-safe', () => {
    kit = makeKit('memory-prefix-boundaries');
    const admin = issue('admin');
    for (const path of [
      '/cargo1/todo/inside',
      '/cargo10/todo/outside',
      '/cargo_1/todo/wildcard-inside',
      '/cargox1/todo/wildcard-outside',
    ]) {
      kit.memory.createDocument({ title: path.split('/').at(-1)!, path, content: path }, admin);
    }

    expect(kit.memory.listDocuments({ prefix: '/cargo1' }, admin).map((doc) => doc.path)).toEqual([
      '/cargo1/todo/inside',
    ]);
    expect(kit.memory.listFolders('/cargo1', admin).map((folder) => folder.path)).toEqual([
      '/cargo1',
      '/cargo1/todo',
    ]);
    expect(kit.memory.listDocuments({ prefix: '/cargo_1' }, admin).map((doc) => doc.path)).toEqual([
      '/cargo_1/todo/wildcard-inside',
    ]);
  });

  it('rolls back a document update when the outbox insert fails', () => {
    kit = makeKit('memory-change-atomicity');
    const admin = issue('admin');
    const created = kit.memory.createDocument(
      {
        title: 'Atomic',
        path: '/cargo1/todo/atomic',
        content: 'before',
      },
      admin,
    );
    kit.db.exec(`
      CREATE TRIGGER reject_change_event
      BEFORE INSERT ON document_change_events
      BEGIN
        SELECT RAISE(ABORT, 'event rejected');
      END;
    `);

    expect(() =>
      kit!.memory.updateDocument(
        created.id,
        {
          content: 'after',
          expected_version: 1,
        },
        admin,
      ),
    ).toThrow('event rejected');
    expect(kit.memory.getDocument(created.id, admin)).toMatchObject({
      content: 'before',
      version: 1,
    });
    expect(kit.memory.getDocumentChangeStats().total).toBe(1);
  });

  it('bounds watched excerpts, omits unwatched excerpts, and hides internal namespaces', () => {
    kit = makeKit('memory-change-security');
    const admin = issue('admin');
    const member = issue('member', 'member');
    const large = kit.memory.createDocument(
      {
        title: 'Large watched',
        path: '/cargo1/todo/large',
        content: '界'.repeat(3_000),
      },
      admin,
    );
    kit.memory.createDocument(
      {
        title: 'Outside',
        path: '/shared/outside',
        content: 'do not excerpt',
        shared: true,
      },
      admin,
    );
    const hidden = kit.memory.createDocument(
      {
        title: 'Hidden',
        path: '/t5t/hidden',
        content: 'hidden content',
      },
      admin,
    );
    kit.memory.updateDocument(hidden.id, { content: 'hidden update' }, admin);
    kit.memory.updateDocument(
      large.id,
      {
        content: `${'界'.repeat(3_000)}changed-tail`,
      },
      admin,
    );

    const events = kit.memory.listDocumentChangeEvents();
    expect(Buffer.byteLength(events[0].new_excerpt || '', 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(events[1].new_excerpt).toBeNull();
    expect(events.at(-1)?.new_excerpt).toContain('changed-tail');
    expect(events.at(-1)?.new_excerpt).toContain('[excerpt offset=');
    expect(events.some((event) => event.new_path === '/t5t/hidden')).toBe(false);
    expect(
      kit.db.prepare('SELECT DISTINCT origin FROM document_change_events WHERE doc_id = ?').all(hidden.id),
    ).toEqual([{ origin: 't5t' }]);

    expect(memoryRoutes.listDocumentEvents(kit.memory, new URLSearchParams(), member)).toEqual({
      status: 403,
      body: { error: 'admin_required' },
    });
  });

  it('advances the feed cursor past filtered events', () => {
    kit = makeKit('memory-change-filtered-cursor');
    const admin = issue('admin');
    kit.memory.createDocument(
      {
        title: 'Hidden first',
        path: '/t5t/hidden-first',
        content: 'hidden',
      },
      admin,
    );
    const visible = kit.memory.createDocument(
      {
        title: 'Visible second',
        path: '/cargo1/todo/visible-second',
        content: 'visible',
      },
      admin,
    );

    const page = kit.memory.listDocumentChangeEventPage({ after: 0, limit: 1 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0].doc_id).toBe(visible.id);
    expect(page.next_after).toBe(page.events[0].id);

    kit.memory.createDocument(
      {
        title: 'Hidden tail',
        path: '/t5t/hidden-tail',
        content: 'hidden',
      },
      admin,
    );
    const checkpoint = kit.memory.listDocumentChangeEventPage({
      after: page.next_after,
      limit: 10,
      prefix: '/cargo1',
    });
    expect(checkpoint.events).toEqual([]);
    expect(checkpoint.next_after).toBeGreaterThan(page.next_after);
    const state = kit.memory.advanceDocumentChangeConsumer('cargo1-consumer', checkpoint.next_after);
    expect(state.last_event_id).toBe(checkpoint.next_after);
    expect(kit.memory.getDocumentChangeStats().consumer_lag).toEqual([
      expect.objectContaining({ consumer: 'cargo1-consumer', lag: 0 }),
    ]);
  });

  it('persists idempotent consumer progress and proposal telemetry', () => {
    kit = makeKit('memory-change-consumer');
    const admin = issue('admin');
    kit.memory.createDocument(
      {
        title: 'Tracked',
        path: '/cargo1/todo/tracked',
        content: 'tracked',
      },
      admin,
    );
    const event = kit.memory.listDocumentChangeEvents()[0];
    expect(kit.memory.getDocumentChangeConsumerState('memory-status-dry-run')).toMatchObject({
      initialized: false,
      last_event_id: 0,
      latest_event_id: event.id,
    });

    const state = kit.memory.recordDocumentChangeProcessing({
      consumer: 'memory-status-dry-run',
      event_ids: [event.id],
      through_event_id: event.id,
      status: 'proposed',
      proposal_ref: 'proposal-1',
      proposal: { decision: 'propose' },
      tokens_in: 120,
      tokens_out: 30,
      latency_ms: 45,
      review_outcome: 'pending',
    });
    expect(state.last_event_id).toBe(event.id);
    expect(state.initialized).toBe(true);
    expect(kit.memory.listDocumentChangeProcessing('memory-status-dry-run')).toEqual([
      expect.objectContaining({
        event_id: event.id,
        status: 'proposed',
        attempts: 1,
        proposal_ref: 'proposal-1',
        proposal_json: { decision: 'propose' },
        tokens_in: 120,
        tokens_out: 30,
        latency_ms: 45,
        review_outcome: 'pending',
      }),
    ]);

    kit.memory.recordDocumentChangeProcessing({
      consumer: 'memory-status-dry-run',
      event_ids: [event.id],
      through_event_id: event.id,
      status: 'proposed',
      proposal_ref: 'proposal-1',
    });
    expect(kit.memory.listDocumentChangeProcessing('memory-status-dry-run')[0].attempts).toBe(2);
    kit.memory.recordDocumentChangeProcessing({
      consumer: 'memory-status-dry-run',
      event_ids: [event.id],
      through_event_id: event.id,
      status: 'applied',
      increment_attempts: false,
    });
    expect(kit.memory.listDocumentChangeProcessing('memory-status-dry-run')[0]).toMatchObject({
      status: 'applied',
      attempts: 2,
    });
    expect(kit.memory.setDocumentChangeReviewOutcome('memory-status-dry-run', [event.id], 'corrected')).toBe(1);
    expect(kit.memory.listDocumentChangeProcessing('memory-status-dry-run')[0].review_outcome).toBe('corrected');

    for (let retry = 0; retry < 2; retry += 1) {
      kit.memory.recordDocumentChangeProcessing({
        consumer: 'memory-status-full',
        event_ids: [event.id],
        through_event_id: event.id,
        status: 'pending',
        advance_cursor: false,
        increment_attempts: false,
      });
    }
    expect(kit.memory.listDocumentChangeProcessing('memory-status-full')[0].attempts).toBe(0);
    kit.memory.recordDocumentChangeProcessing({
      consumer: 'memory-status-full',
      event_ids: [event.id],
      through_event_id: event.id,
      status: 'failed',
      advance_cursor: false,
      increment_attempts: true,
    });
    expect(kit.memory.listDocumentChangeProcessing('memory-status-full')[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
  });

  it('rejects processing cursors beyond the feed head', () => {
    kit = makeKit('memory-change-processing-cursor');
    const admin = issue('admin');
    kit.memory.createDocument(
      {
        title: 'Tracked',
        path: '/cargo1/todo/tracked',
        content: 'tracked',
      },
      admin,
    );
    const event = kit.memory.listDocumentChangeEvents()[0];

    expect(() =>
      kit!.memory.recordDocumentChangeProcessing({
        consumer: 'memory-status-dry-run',
        event_ids: [event.id],
        through_event_id: event.id + 1,
        status: 'skipped',
      }),
    ).toThrow('through_event_id_beyond_feed');
    expect(kit.memory.getDocumentChangeConsumerState('memory-status-dry-run').last_event_id).toBe(0);
    expect(kit.memory.listDocumentChangeProcessing('memory-status-dry-run')).toEqual([]);
  });

  it('refuses to prune the outbox before a consumer checkpoint exists', () => {
    kit = makeKit('memory-change-prune-guard');
    const admin = issue('admin');
    kit.memory.createDocument(
      {
        title: 'Tracked',
        path: '/cargo1/todo/tracked',
        content: 'tracked',
      },
      admin,
    );
    const event = kit.memory.listDocumentChangeEvents()[0];

    expect(() => kit!.memory.pruneDocumentChangeEvents(event.id + 1)).toThrow('consumer_state_required');
    expect(kit.memory.getDocumentChangeStats().total).toBe(1);

    kit.memory.advanceDocumentChangeConsumer('memory-status-dry-run', event.id);
    kit.memory.recordDocumentChangeProcessing({
      consumer: 'memory-status-dry-run',
      event_ids: [event.id],
      through_event_id: event.id,
      status: 'applied',
      proposal: { previous_row: '| Memory | before |' },
    });
    expect(kit.memory.pruneDocumentChangeEvents(event.id + 1)).toBe(1);
    expect(kit.memory.getDocumentChangeStats().total).toBe(0);
    expect(kit.memory.listDocumentChangeProcessing('memory-status-dry-run')).toEqual([
      expect.objectContaining({
        event_id: event.id,
        status: 'applied',
        proposal_json: { previous_row: '| Memory | before |' },
      }),
    ]);
  });

  it('reconciles dead references, missing routes, duplicate projects, and migration lag', () => {
    kit = makeKit('memory-index-reconciliation');
    const admin = issue('admin');
    const member = issue('member', 'member');
    expect(() => reconcileMemoryIndexes(kit!.memory, member)).toThrow('admin_required');
    const known = kit.memory.createDocument(
      {
        title: 'Known',
        path: '/cargo1/research/known',
        content: 'known',
      },
      admin,
    );
    const unindexed = kit.memory.createDocument(
      {
        title: 'Unindexed',
        path: '/cargo1/research/unindexed',
        content: 'unindexed',
      },
      admin,
    );
    kit.memory.createDocument(
      {
        title: 'MetaMemory Index',
        path: '/cargo1/index/metamemory-index',
        content: [
          '# Index',
          '',
          'Read `/cargo1/research/known` and `/cargo1/missing`.',
          '',
          '| Role | Project | Document | Version | Keywords | Summary |',
          '| --- | --- | --- | ---: | --- | --- |',
          '| reference | memory | Known (`/cargo1/research/known`) | 1 | known | Known doc. |',
        ].join('\n'),
      },
      admin,
    );
    kit.memory.createDocument(
      {
        title: 'Project Progress Status',
        path: '/cargo1/status/project-progress-status',
        content: [
          '# Status',
          '',
          '## Current Projects',
          '',
          '| Project | Status |',
          '| --- | --- |',
          '| Memory | active |',
          '| Memory | active |',
        ].join('\n'),
      },
      admin,
    );
    kit.db.prepare('UPDATE documents SET version = 0 WHERE id = ?').run(known.id);

    const report = reconcileMemoryIndexes(kit.memory, admin);
    expect(report.dead_references).toEqual([
      {
        source_path: '/cargo1/index/metamemory-index',
        target_path: '/cargo1/missing',
      },
    ]);
    expect(report.unindexed_documents).toEqual(expect.arrayContaining([expect.objectContaining({ id: unindexed.id })]));
    expect(report.duplicate_project_rows).toEqual([{ project: 'Memory', count: 2 }]);
    expect(report.stale_source_versions).toEqual([
      {
        path: '/cargo1/research/known',
        indexed_version: 1,
        actual_version: 0,
      },
    ]);
    expect(report.zero_version_documents).toEqual([{ id: known.id, path: '/cargo1/research/known' }]);
  });

  it('previews and rebuilds a deterministic routing index behind an explicit gate', () => {
    kit = makeKit('memory-routing-index');
    const admin = issue('admin');
    kit.memory.createDocument(
      {
        title: 'MetaMemory Index',
        path: '/cargo1/index/metamemory-index',
        content: '# Hand-maintained index\n',
      },
      admin,
    );
    kit.memory.createDocument(
      {
        title: 'Project Status',
        path: '/cargo1/status/project-progress-status',
        content: '# Status\n',
        index_role: 'status',
        project_key: 'memory',
        index_keywords: ['progress', 'current'],
        index_summary: 'Current project state.',
      },
      admin,
    );
    kit.memory.createDocument(
      {
        title: 'Memory ToDos',
        path: '/cargo1/todo/memory-todos',
        content: '# ToDos\n',
        index_role: 'todo',
        project_key: 'memory',
        index_keywords: ['todo'],
        index_summary: 'Canonical memory work items.',
      },
      admin,
    );

    const preview = memoryRoutes.previewMemoryRoutingIndex(kit.memory, new URLSearchParams(), admin);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      source_document_count: 2,
      changed: true,
      rebuild_enabled: false,
    });
    expect((preview.body as { content: string }).content).toContain(
      '| status | memory | Project Status (`/cargo1/status/project-progress-status`) |',
    );

    const target = kit.memory.getDocument('/cargo1/index/metamemory-index', admin)!;
    expect(memoryRoutes.rebuildMemoryRoutingIndex(kit.memory, { expected_version: target.version }, admin)).toEqual({
      status: 409,
      body: { error: 'routing_index_rebuild_disabled' },
    });

    const prior = process.env.METABOT_MEMORY_ROUTING_REBUILD_ENABLED;
    process.env.METABOT_MEMORY_ROUTING_REBUILD_ENABLED = 'true';
    try {
      const rebuilt = memoryRoutes.rebuildMemoryRoutingIndex(kit.memory, { expected_version: target.version }, admin);
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toMatchObject({
        changed: true,
        snapshot_id: expect.any(Number),
        document: { version: target.version + 1 },
      });
      expect(kit.memory.listRoutingIndexSnapshots(target.id)).toEqual([
        expect.objectContaining({
          source_version: target.version,
          content: '# Hand-maintained index\n',
        }),
      ]);
      const latestEvent = kit.memory.listDocumentChangeEvents().at(-1);
      expect(latestEvent).toMatchObject({
        doc_id: target.id,
        origin: 'indexer',
        content_changed: true,
      });

      const current = kit.memory.getDocument(target.id, admin)!;
      const noChange = memoryRoutes.rebuildMemoryRoutingIndex(kit.memory, { expected_version: current.version }, admin);
      expect(noChange.body).toMatchObject({
        changed: false,
        snapshot_id: null,
      });
      expect(kit.memory.listRoutingIndexSnapshots(target.id)).toHaveLength(1);
      expect(
        memoryRoutes.rebuildMemoryRoutingIndex(kit.memory, { expected_version: target.version }, admin),
      ).toMatchObject({
        status: 409,
        body: { error: 'version_conflict' },
      });
    } finally {
      if (prior === undefined) delete process.env.METABOT_MEMORY_ROUTING_REBUILD_ENABLED;
      else process.env.METABOT_MEMORY_ROUTING_REBUILD_ENABLED = prior;
    }
  });
});
