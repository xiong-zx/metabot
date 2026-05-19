import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from '../src/memory/memory-store.js';
import { loadT5tFolderIds } from '../src/t5t/folder-ids.js';
import { T5tStore } from '../src/t5t/t5t-store.js';
import type { Credential } from '../src/auth/credentials.js';

let dir: string;
let db: Database.Database;
let memory: MemoryStore;
let store: T5tStore;

function mkCred(botName: string, role: Credential['role'] = 'member'): Credential {
  return {
    id: `cred-${botName}`,
    tokenHash: '',
    botName,
    ownerName: botName,
    role,
    writableNamespaces: [],
    readableNamespaces: [],
    publishSkill: false,
    createdAt: 0,
    revokedAt: null,
    lastUsedAt: null,
    notes: '',
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 't5t-store-test-'));
  db = new Database(path.join(dir, 'central.db'));
  db.pragma('journal_mode = WAL');
  const logger = pino({ level: 'silent' });
  memory = new MemoryStore(db, logger);
  const folderIds = loadT5tFolderIds({}, memory, logger);
  store = new T5tStore(memory, folderIds, logger);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('T5tStore — folder auto-create', () => {
  it('creates all 7 t5t folders under /t5t/ when env is empty', () => {
    expect(memory.findFolderByPath('/t5t/projects')).not.toBeNull();
    expect(memory.findFolderByPath('/t5t/entries')).not.toBeNull();
    expect(memory.findFolderByPath('/t5t/feedback')).not.toBeNull();
    expect(memory.findFolderByPath('/t5t/goals')).not.toBeNull();
    expect(memory.findFolderByPath('/t5t/evaluators')).not.toBeNull();
    expect(memory.findFolderByPath('/t5t/bottlenecks')).not.toBeNull();
    expect(memory.findFolderByPath('/t5t/wip')).not.toBeNull();
  });

  it('honours T5T_FOLDER_* env vars when they point to existing folder ids', () => {
    const logger = pino({ level: 'silent' });
    const customDb = new Database(path.join(dir, 'custom.db'));
    customDb.pragma('journal_mode = WAL');
    const mem2 = new MemoryStore(customDb, logger);
    const explicit = mem2.ensureFolderPath('/custom/projects');
    const ids = loadT5tFolderIds(
      { T5T_FOLDER_PROJECTS: explicit.id } as NodeJS.ProcessEnv,
      mem2,
      logger,
    );
    expect(ids.projects).toBe(explicit.id);
    customDb.close();
  });
});

describe('T5tStore — append + latest-wins', () => {
  it('appendProject + getProject returns the latest doc per slug', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'motion', name: 'Motion v1', leaderEmail: 'ameng@xvi' }, cred);
    const v1 = store.getProject('motion');
    expect(v1?.name).toBe('Motion v1');
    expect(v1?.leaderEmail).toBe('ameng@xvi');
    store.appendProject({
      slug: 'motion', name: 'Motion v2', leaderEmail: 'ameng@xvi',
      status: 'green',
    }, cred);
    const v2 = store.getProject('motion');
    expect(v2?.name).toBe('Motion v2');
    expect(v2?.status).toBe('green');
  });

  it('appendGoal stamps replaces=prev.goalId and getLatestGoal returns newest', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'core' }, cred);
    const g1 = store.appendGoal({ project: 'core', text: 'ship v1' }, cred);
    expect(g1.goalId).toBe('core-goal-1');
    expect(g1.replaces).toBeNull();
    const g2 = store.appendGoal({ project: 'core', text: 'ship v2' }, cred);
    expect(g2.goalId).toBe('core-goal-2');
    expect(g2.replaces).toBe('core-goal-1');
    expect(store.getLatestGoal('core')?.text).toBe('ship v2');
  });

  it('appendEvaluator increments seq per (project, evaluatorId); listEvaluators returns latest per id', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'p' }, cred);
    const e1 = store.appendEvaluator({
      project: 'p', evaluatorId: 'latency-ok', description: 'p95<1s',
    }, cred);
    expect(e1.seq).toBe(1);
    const e2 = store.appendEvaluator({
      project: 'p', evaluatorId: 'latency-ok', description: 'p95<800ms', met: true,
    }, cred);
    expect(e2.seq).toBe(2);
    expect(e2.met).toBe(true);
    const list = store.listEvaluators('p');
    expect(list.length).toBe(1);
    expect(list[0].seq).toBe(2);
    expect(list[0].description).toBe('p95<800ms');
  });

  it('appendEvaluator preserves description when empty (toggle-only path)', () => {
    const cred = mkCred('ameng');
    store.appendEvaluator({
      project: 'p', evaluatorId: 'e1', description: 'first',
    }, cred);
    const toggled = store.appendEvaluator({
      project: 'p', evaluatorId: 'e1', description: '', met: true,
    }, cred);
    expect(toggled.description).toBe('first');
    expect(toggled.met).toBe(true);
  });

  it('appendEvaluator rejects empty description on first version', () => {
    const cred = mkCred('ameng');
    expect(() => store.appendEvaluator({
      project: 'p', evaluatorId: 'e-new', description: '   ',
    }, cred)).toThrow(/description_required_for_new_evaluator/);
  });

  it('getLatestBottleneck returns null when latest is cleared', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'p' }, cred);
    store.appendBottleneck({ project: 'p', text: 'flaky tests' }, cred);
    expect(store.getLatestBottleneck('p')?.text).toBe('flaky tests');
    store.appendBottleneck({ project: 'p', clear: true }, cred);
    expect(store.getLatestBottleneck('p')).toBeNull();
  });

  it('appendEntry generates monotonic per-(date, author) seqs and orders by createdAt desc', async () => {
    const cred = mkCred('motion');
    store.appendProject({ slug: 'fleet' }, cred);
    const a = store.appendEntry({
      project: 'fleet', date: '2026-05-18', items: ['fix a'],
    }, cred);
    await new Promise((r) => setTimeout(r, 5));
    const b = store.appendEntry({
      project: 'fleet', date: '2026-05-18', items: ['fix b'],
    }, cred);
    expect(a.entryId).toBe('2026-05-18-motion-001');
    expect(b.entryId).toBe('2026-05-18-motion-002');
    const recent = store.listEntriesByProject('fleet');
    expect(recent.map((e) => e.entryId)).toEqual([b.entryId, a.entryId]);
  });

  it('appendFeedback creates sequenced feedback per onEntry', () => {
    const cred = mkCred('ameng');
    const f1 = store.appendFeedback({ onEntry: 'entry-1', comment: 'nice' }, cred);
    const f2 = store.appendFeedback({ onEntry: 'entry-1', comment: 'also nice' }, cred);
    expect(f1.feedbackId).toBe('entry-1-fb-001');
    expect(f2.feedbackId).toBe('entry-1-fb-002');
    const list = store.listFeedbackForEntry('entry-1');
    expect(list.length).toBe(2);
    expect(list[0].comment).toBe('nice');
  });
});

describe('T5tStore — WIP board derivation', () => {
  it('computeWipBoard groups latest WIP per (project, evaluator) and orders by status', () => {
    const cred = mkCred('motion');
    store.appendProject({ slug: 'fleet' }, cred);
    store.appendEvaluator({ project: 'fleet', evaluatorId: 'a', description: 'desc' }, cred);
    store.appendEvaluator({ project: 'fleet', evaluatorId: 'b', description: 'desc' }, cred);
    const w1 = store.appendWipItem({
      project: 'fleet', evaluatorId: 'a', description: 'task1',
    }, cred);
    store.appendWipItem({
      project: 'fleet', evaluatorId: 'a', description: 'task2',
    }, cred);
    // Transition w1 to doing
    store.appendWipItem({
      project: 'fleet', evaluatorId: 'a', description: 'task1',
      status: 'doing', wipId: w1.wipId,
    }, cred);
    store.appendWipItem({
      project: 'fleet', evaluatorId: 'b', description: 'task3', status: 'done',
    }, cred);

    const board = store.computeWipBoard('fleet');
    expect(board.length).toBe(2);
    const colA = board.find((c) => c.evaluator.evaluatorId === 'a')!;
    const colB = board.find((c) => c.evaluator.evaluatorId === 'b')!;
    expect(colA.items.length).toBe(2);
    expect(colA.items[0].status).toBe('doing'); // doing-first ordering
    expect(colA.items[1].status).toBe('queued');
    expect(colB.items.length).toBe(1);
    expect(colB.items[0].status).toBe('done');
  });

  it('appendWipItem with unknown wipId returns 404 wip_not_found', () => {
    const cred = mkCred('motion');
    expect(() => store.appendWipItem({
      project: 'p', evaluatorId: 'e', description: 'x', wipId: 'p-wip-999',
    }, cred)).toThrow(/wip_not_found/);
  });
});

describe('T5tStore — anomalies', () => {
  it('flags no_owner when leaderEmail is null', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'orphan' }, cred);
    // Goal added inside grace window so no_goal does not also fire.
    store.appendGoal({ project: 'orphan', text: 'set' }, cred);
    const anomalies = store.computeAnomalies();
    const reasons = anomalies.filter((a) => a.project === 'orphan').map((a) => a.reason);
    expect(reasons).toContain('no_owner');
  });

  it('flags kill_red when status=red', () => {
    const cred = mkCred('ameng');
    store.appendProject({
      slug: 'dead', leaderEmail: 'x@x', status: 'red', killCriteria: 'no traction',
    }, cred);
    store.appendGoal({ project: 'dead', text: 'set' }, cred);
    const anomalies = store.computeAnomalies();
    const reasons = anomalies.filter((a) => a.project === 'dead').map((a) => a.reason);
    expect(reasons).toContain('kill_red');
  });

  it('flags stale when last push older than 7 days', () => {
    const cred = mkCred('motion');
    store.appendProject({ slug: 'old', leaderEmail: 'x@x' }, cred);
    store.appendGoal({ project: 'old', text: 'set' }, cred);
    store.appendEntry({
      project: 'old', date: '2026-05-01', items: ['fix'],
    }, cred);
    // 2026-05-18 - 2026-05-01 ≈ 17 days, but createdAt is real now() — we
    // simulate "now" 30d in the future to ensure the comparison crosses 7d.
    const now = new Date(Date.now() + 30 * 86_400_000);
    const anomalies = store.computeAnomalies(now);
    const stale = anomalies.find((a) => a.project === 'old' && a.reason === 'stale');
    expect(stale).toBeDefined();
    expect(stale?.detail).toMatch(/last push \d+ days ago/);
  });

  it('flags stale (never pushed) when project has no entries', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'fresh', leaderEmail: 'x@x' }, cred);
    store.appendGoal({ project: 'fresh', text: 'set' }, cred);
    const anomalies = store.computeAnomalies();
    const stale = anomalies.find((a) => a.project === 'fresh' && a.reason === 'stale');
    expect(stale?.detail).toBe('never pushed');
  });

  it('flags no_goal after 24h grace expires', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'goalless', leaderEmail: 'x@x' }, cred);
    // 25h later → grace expired → no_goal fires.
    const now = new Date(Date.now() + 25 * 3600 * 1000);
    const anomalies = store.computeAnomalies(now);
    const noGoal = anomalies.find((a) => a.project === 'goalless' && a.reason === 'no_goal');
    expect(noGoal).toBeDefined();
  });

  it('does NOT flag no_goal within the 24h grace window', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'baby', leaderEmail: 'x@x' }, cred);
    const anomalies = store.computeAnomalies();
    const noGoal = anomalies.find((a) => a.project === 'baby' && a.reason === 'no_goal');
    expect(noGoal).toBeUndefined();
  });

  it('flags stale_bottleneck when WIP in-flight > 3d and no active bottleneck', () => {
    const cred = mkCred('motion');
    store.appendProject({ slug: 'stuck', leaderEmail: 'x@x' }, cred);
    store.appendGoal({ project: 'stuck', text: 'set' }, cred);
    store.appendEvaluator({
      project: 'stuck', evaluatorId: 'e1', description: 'desc',
    }, cred);
    store.appendWipItem({
      project: 'stuck', evaluatorId: 'e1', description: 'task', status: 'doing',
    }, cred);
    // Skip ahead 5 days
    const now = new Date(Date.now() + 5 * 86_400_000);
    const anomalies = store.computeAnomalies(now);
    const sb = anomalies.find((a) => a.project === 'stuck' && a.reason === 'stale_bottleneck');
    expect(sb).toBeDefined();
    expect(sb?.detail).toMatch(/WIP in flight but no current bottleneck for \d+d/);
  });

  it('does NOT flag stale_bottleneck once a bottleneck is recorded', () => {
    const cred = mkCred('motion');
    store.appendProject({ slug: 'unblocked', leaderEmail: 'x@x' }, cred);
    store.appendGoal({ project: 'unblocked', text: 'set' }, cred);
    store.appendEvaluator({
      project: 'unblocked', evaluatorId: 'e1', description: 'desc',
    }, cred);
    store.appendWipItem({
      project: 'unblocked', evaluatorId: 'e1', description: 'task', status: 'doing',
    }, cred);
    store.appendBottleneck({
      project: 'unblocked', text: 'waiting on review',
    }, cred);
    const now = new Date(Date.now() + 5 * 86_400_000);
    const anomalies = store.computeAnomalies(now);
    const sb = anomalies.find(
      (a) => a.project === 'unblocked' && a.reason === 'stale_bottleneck',
    );
    expect(sb).toBeUndefined();
  });
});

describe('T5tStore — append-only invariant', () => {
  it('exposes no update/delete/replace methods', () => {
    const surface = Object.getOwnPropertyNames(T5tStore.prototype);
    const forbidden = surface.filter((n) =>
      /^update/.test(n) || /^delete/.test(n) || /^replace/.test(n) || /^remove/.test(n),
    );
    expect(forbidden).toEqual([]);
  });

  it('listProjects after 3 project appends still returns 1 slug (latest-wins)', () => {
    const cred = mkCred('ameng');
    store.appendProject({ slug: 'one', name: 'v1' }, cred);
    store.appendProject({ slug: 'one', name: 'v2' }, cred);
    store.appendProject({ slug: 'one', name: 'v3' }, cred);
    const projects = store.listProjects();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('v3');
  });

  it('recentEntries respects limit and orders newest-first', async () => {
    const cred = mkCred('motion');
    store.appendProject({ slug: 'p' }, cred);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const e = store.appendEntry({
        project: 'p', date: '2026-05-18', items: [`item ${i}`],
      }, cred);
      ids.push(e.entryId);
      await new Promise((r) => setTimeout(r, 3));
    }
    const recent = store.recentEntries(2);
    expect(recent.length).toBe(2);
    expect(recent.map((e) => e.entryId)).toEqual([ids[2], ids[1]]);
  });
});
