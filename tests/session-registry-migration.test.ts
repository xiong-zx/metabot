import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  mergeSessionDatabases,
  mergeSessionDatabaseInPlace,
  planSessionDatabaseMerge,
  runSessionRegistryMigrationCli,
  snapshotSessionDatabase,
} from '../src/session/session-registry-migration.js';

const SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    bot_name TEXT NOT NULL,
    claude_session_id TEXT,
    working_directory TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE session_links (
    session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, chat_id)
  );
  CREATE TABLE session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    platform TEXT NOT NULL,
    cost_usd REAL,
    duration_ms REAL,
    timestamp INTEGER NOT NULL
  );
`;

function createDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

function insertSession(
  db: Database.Database,
  row: {
    id: string;
    bot: string;
    chat: string;
    created?: number;
    updated?: number;
    title?: string;
    claudeSessionId?: string;
  },
): void {
  db.prepare(
    `
    INSERT INTO sessions
      (id, bot_name, claude_session_id, working_directory, title, platform, chat_id, created_at, updated_at)
    VALUES (?, ?, ?, '/root', ?, 'feishu', ?, ?, ?)
  `,
  ).run(
    row.id,
    row.bot,
    row.claudeSessionId ?? null,
    row.title ?? row.id,
    row.chat,
    row.created ?? 1,
    row.updated ?? 1,
  );
}

function insertMessage(db: Database.Database, sessionId: string, text: string, timestamp: number): void {
  db.prepare(
    `
    INSERT INTO session_messages (session_id, role, text, platform, cost_usd, duration_ms, timestamp)
    VALUES (?, 'user', ?, 'feishu', NULL, NULL, ?)
  `,
  ).run(sessionId, text, timestamp);
}

describe('session registry migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metabot-session-migration-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges by bot and chat while preserving messages and remapping ID collisions', () => {
    const currentPath = join(dir, 'current.db');
    const historyPath = join(dir, 'history.db');
    const outputPath = join(dir, 'merged.db');
    const current = createDatabase(currentPath);
    insertSession(current, {
      id: 'current-admin',
      bot: 'admin',
      chat: 'oc_shared',
      created: 100,
      updated: 200,
      title: 'current title',
      claudeSessionId: 'current-claude',
    });
    insertSession(current, { id: 'collision-id', bot: 'current', chat: 'oc_current' });
    insertMessage(current, 'current-admin', 'same message', 10);
    insertMessage(current, 'collision-id', 'current-only', 11);
    current
      .prepare(
        `
      INSERT INTO session_links (session_id, chat_id, platform, linked_at)
      VALUES ('current-admin', 'oc_linked', 'feishu', 10)
    `,
      )
      .run();
    current.close();

    const history = createDatabase(historyPath);
    insertSession(history, {
      id: 'history-admin',
      bot: 'admin',
      chat: 'oc_shared',
      created: 5,
      updated: 50,
      title: 'historical title',
      claudeSessionId: 'historical-claude',
    });
    insertSession(history, { id: 'memory-id', bot: 'memory', chat: 'oc_shared' });
    insertSession(history, { id: 'collision-id', bot: 'history', chat: 'oc_history' });
    insertMessage(history, 'history-admin', 'same message', 10);
    insertMessage(history, 'history-admin', 'historical-only', 12);
    insertMessage(history, 'memory-id', 'memory-only', 13);
    insertMessage(history, 'collision-id', 'collision-history-only', 14);
    history
      .prepare(
        `
      INSERT INTO session_links (session_id, chat_id, platform, linked_at)
      VALUES ('history-admin', 'oc_linked', 'feishu', 10),
             ('memory-id', 'oc_memory_link', 'feishu', 20)
    `,
      )
      .run();
    history.close();

    const plan = planSessionDatabaseMerge(currentPath, historyPath);
    expect(plan).toMatchObject({
      current: { sessions: 2, messages: 2, links: 1 },
      history: { sessions: 3, messages: 4, links: 2 },
      overlappingBotChats: 1,
      historyOnlyBotChats: 2,
      conflictingSessionIds: 1,
    });

    const report = mergeSessionDatabases({ currentPath, historyPath, outputPath });
    expect(report).toMatchObject({
      output: { sessions: 4, messages: 5, links: 2 },
      mergedSessions: 1,
      insertedSessions: 2,
      remappedSessionIds: 1,
      insertedMessages: 3,
      deduplicatedMessages: 1,
      insertedLinks: 1,
      deduplicatedLinks: 1,
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
    });

    const merged = new Database(outputPath, { readonly: true });
    try {
      const admin = merged
        .prepare(
          `
        SELECT * FROM sessions WHERE bot_name = 'admin' AND chat_id = 'oc_shared'
      `,
        )
        .get() as any;
      expect(admin).toMatchObject({
        id: 'current-admin',
        title: 'current title',
        claude_session_id: 'current-claude',
        created_at: 5,
        updated_at: 200,
      });
      const memory = merged
        .prepare(
          `
        SELECT id FROM sessions WHERE bot_name = 'memory' AND chat_id = 'oc_shared'
      `,
        )
        .get() as { id: string };
      expect(memory.id).toBe('memory-id');
      const remapped = merged
        .prepare(
          `
        SELECT id FROM sessions WHERE bot_name = 'history' AND chat_id = 'oc_history'
      `,
        )
        .get() as { id: string };
      expect(remapped.id).not.toBe('collision-id');
      expect(
        merged
          .prepare(
            `
        SELECT text FROM session_messages WHERE session_id = 'current-admin' ORDER BY timestamp
      `,
          )
          .all(),
      ).toEqual([{ text: 'same message' }, { text: 'historical-only' }]);
      expect(
        merged
          .prepare(
            `
        SELECT text FROM session_messages WHERE session_id = ?
      `,
          )
          .all(remapped.id),
      ).toEqual([{ text: 'collision-history-only' }]);
    } finally {
      merged.close();
    }
  });

  it('defaults to a read-only dry run', async () => {
    const currentPath = join(dir, 'current.db');
    const historyPath = join(dir, 'history.db');
    const outputPath = join(dir, 'must-not-exist.db');
    createDatabase(currentPath).close();
    createDatabase(historyPath).close();

    const result = await runSessionRegistryMigrationCli([
      'merge',
      '--current',
      currentPath,
      '--history',
      historyPath,
      '--output',
      outputPath,
    ]);
    expect(result).toMatchObject({ mode: 'dry-run', command: 'merge' });
    expect(existsSync(outputPath)).toBe(false);
  });

  it('creates a consistent snapshot from a live WAL database', async () => {
    const sourcePath = join(dir, 'live.db');
    const snapshotPath = join(dir, 'snapshot.db');
    const source = createDatabase(sourcePath);
    source.pragma('journal_mode = WAL');
    insertSession(source, { id: 'live-id', bot: 'admin', chat: 'oc_live' });
    insertMessage(source, 'live-id', 'visible through WAL', 1);

    const counts = await snapshotSessionDatabase(sourcePath, snapshotPath);
    expect(counts).toEqual({ sessions: 1, messages: 1, links: 0 });
    const snapshot = new Database(snapshotPath, { readonly: true });
    try {
      expect(snapshot.prepare('SELECT text FROM session_messages').pluck().get()).toBe('visible through WAL');
    } finally {
      snapshot.close();
      source.close();
    }
  });

  it('merges in place transactionally and leaves an exact rollback backup', async () => {
    const currentPath = join(dir, 'live.db');
    const historyPath = join(dir, 'history.db');
    const backupPath = join(dir, 'rollback.db');
    const liveReader = createDatabase(currentPath);
    liveReader.pragma('journal_mode = WAL');
    insertSession(liveReader, { id: 'current-id', bot: 'admin', chat: 'oc_live' });
    insertMessage(liveReader, 'current-id', 'current message', 1);
    const history = createDatabase(historyPath);
    insertSession(history, { id: 'history-id', bot: 'memory', chat: 'oc_live' });
    insertMessage(history, 'history-id', 'history message', 2);
    history.close();

    const report = await mergeSessionDatabaseInPlace({ currentPath, historyPath, backupPath });
    expect(report.output).toEqual({ sessions: 2, messages: 2, links: 0 });
    expect(report.backupPath).toBe(backupPath);
    expect(liveReader.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(2);
    expect(liveReader.prepare('SELECT COUNT(*) FROM session_messages').pluck().get()).toBe(2);

    const rollback = new Database(backupPath, { readonly: true });
    try {
      expect(rollback.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
      expect(rollback.prepare('SELECT text FROM session_messages').pluck().all()).toEqual(['current message']);
    } finally {
      rollback.close();
      liveReader.close();
    }
  });

  it('fails closed on duplicate bot and chat rows', () => {
    const currentPath = join(dir, 'current.db');
    const historyPath = join(dir, 'history.db');
    const outputPath = join(dir, 'merged.db');
    const current = createDatabase(currentPath);
    insertSession(current, { id: 'one', bot: 'admin', chat: 'oc_duplicate' });
    insertSession(current, { id: 'two', bot: 'admin', chat: 'oc_duplicate' });
    current.close();
    createDatabase(historyPath).close();

    expect(() => mergeSessionDatabases({ currentPath, historyPath, outputPath })).toThrow(
      'Duplicate (bot_name, chat_id) rows prevent a safe merge',
    );
    expect(existsSync(outputPath)).toBe(false);
  });
});
