#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

interface SessionRow {
  id: string;
  bot_name: string;
  claude_session_id: string | null;
  working_directory: string;
  title: string;
  platform: string;
  chat_id: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  session_id: string;
  role: string;
  text: string;
  platform: string;
  cost_usd: number | null;
  duration_ms: number | null;
  timestamp: number;
}

interface LinkRow {
  session_id: string;
  chat_id: string;
  platform: string;
  linked_at: number;
}

interface DatabaseCounts {
  sessions: number;
  messages: number;
  links: number;
}

export interface SessionDatabaseMergePlan {
  current: DatabaseCounts;
  history: DatabaseCounts;
  overlappingBotChats: number;
  historyOnlyBotChats: number;
  conflictingSessionIds: number;
  duplicateBotChats: {
    current: string[];
    history: string[];
  };
}

export interface SessionDatabaseMergeReport extends SessionDatabaseMergePlan {
  output: DatabaseCounts;
  mergedSessions: number;
  insertedSessions: number;
  remappedSessionIds: number;
  insertedMessages: number;
  deduplicatedMessages: number;
  insertedLinks: number;
  deduplicatedLinks: number;
  integrityCheck: string;
  foreignKeyViolations: number;
}

export interface InPlaceSessionDatabaseMergeReport extends SessionDatabaseMergeReport {
  backupPath: string;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
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
  CREATE INDEX IF NOT EXISTS idx_sessions_bot_name ON sessions(bot_name);
  CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id);
  DROP INDEX IF EXISTS idx_sessions_chat_id_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_bot_chat_unique ON sessions(bot_name, chat_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

  CREATE TABLE IF NOT EXISTS session_links (
    session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, chat_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_session_links_chat_id ON session_links(chat_id);

  CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    platform TEXT NOT NULL,
    cost_usd REAL,
    duration_ms REAL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
`;

function sessionKey(row: Pick<SessionRow, 'bot_name' | 'chat_id'>): string {
  return JSON.stringify([row.bot_name, row.chat_id]);
}

function messageKey(row: MessageRow): string {
  return JSON.stringify([
    row.session_id,
    row.role,
    row.text,
    row.platform,
    row.cost_usd,
    row.duration_ms,
    row.timestamp,
  ]);
}

function linkKey(row: LinkRow): string {
  return JSON.stringify([row.session_id, row.chat_id]);
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function readCounts(db: Database.Database): DatabaseCounts {
  const count = (table: string): number => {
    if (!tableExists(db, table)) return 0;
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  };
  return {
    sessions: count('sessions'),
    messages: count('session_messages'),
    links: count('session_links'),
  };
}

function readSessions(db: Database.Database): SessionRow[] {
  if (!tableExists(db, 'sessions')) return [];
  return db.prepare('SELECT * FROM sessions ORDER BY created_at, id').all() as SessionRow[];
}

function readMessages(db: Database.Database): MessageRow[] {
  if (!tableExists(db, 'session_messages')) return [];
  return db
    .prepare(
      `
    SELECT session_id, role, text, platform, cost_usd, duration_ms, timestamp
    FROM session_messages
    ORDER BY id
  `,
    )
    .all() as MessageRow[];
}

function readLinks(db: Database.Database): LinkRow[] {
  if (!tableExists(db, 'session_links')) return [];
  return db
    .prepare('SELECT session_id, chat_id, platform, linked_at FROM session_links ORDER BY rowid')
    .all() as LinkRow[];
}

function duplicateSessionKeys(rows: SessionRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(sessionKey(row), (counts.get(sessionKey(row)) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
}

function assertInputPath(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label} database does not exist: ${resolved}`);
  return resolved;
}

function readOnlyDatabase(filePath: string): Database.Database {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}

function buildPlan(currentDb: Database.Database, historyDb: Database.Database): SessionDatabaseMergePlan {
  const currentSessions = readSessions(currentDb);
  const historySessions = readSessions(historyDb);
  const currentByKey = new Map(currentSessions.map((row) => [sessionKey(row), row]));
  const currentById = new Map(currentSessions.map((row) => [row.id, row]));
  let overlappingBotChats = 0;
  let historyOnlyBotChats = 0;
  let conflictingSessionIds = 0;
  for (const row of historySessions) {
    if (currentByKey.has(sessionKey(row))) overlappingBotChats += 1;
    else historyOnlyBotChats += 1;
    const byId = currentById.get(row.id);
    if (byId && sessionKey(byId) !== sessionKey(row)) conflictingSessionIds += 1;
  }
  return {
    current: readCounts(currentDb),
    history: readCounts(historyDb),
    overlappingBotChats,
    historyOnlyBotChats,
    conflictingSessionIds,
    duplicateBotChats: {
      current: duplicateSessionKeys(currentSessions),
      history: duplicateSessionKeys(historySessions),
    },
  };
}

export function planSessionDatabaseMerge(currentPath: string, historyPath: string): SessionDatabaseMergePlan {
  const current = readOnlyDatabase(assertInputPath(currentPath, 'Current'));
  const history = readOnlyDatabase(assertInputPath(historyPath, 'History'));
  try {
    return buildPlan(current, history);
  } finally {
    current.close();
    history.close();
  }
}

function nonEmpty(preferred: string | null, fallback: string | null): string | null {
  return preferred?.length ? preferred : fallback;
}

function mergeSessionMetadata(current: SessionRow, history: SessionRow): SessionRow {
  const recent = history.updated_at > current.updated_at ? history : current;
  const older = recent === history ? current : history;
  return {
    ...recent,
    id: current.id,
    bot_name: current.bot_name,
    chat_id: current.chat_id,
    claude_session_id: nonEmpty(recent.claude_session_id, older.claude_session_id),
    working_directory: nonEmpty(recent.working_directory, older.working_directory) ?? '',
    title: nonEmpty(recent.title, older.title) ?? '',
    platform: nonEmpty(recent.platform, older.platform) ?? '',
    created_at: Math.min(current.created_at, history.created_at),
    updated_at: Math.max(current.updated_at, history.updated_at),
  };
}

function uniqueSessionId(existing: Set<string>): string {
  let id = crypto.randomUUID();
  while (existing.has(id)) id = crypto.randomUUID();
  return id;
}

export function mergeSessionDatabases(options: {
  currentPath: string;
  historyPath: string;
  outputPath: string;
}): SessionDatabaseMergeReport {
  const currentPath = assertInputPath(options.currentPath, 'Current');
  const historyPath = assertInputPath(options.historyPath, 'History');
  const outputPath = path.resolve(options.outputPath);
  if (new Set([currentPath, historyPath, outputPath]).size !== 3) {
    throw new Error('Current, history, and output database paths must be different');
  }
  if (fs.existsSync(outputPath) || fs.existsSync(`${outputPath}-wal`) || fs.existsSync(`${outputPath}-shm`)) {
    throw new Error(`Output database already exists: ${outputPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const current = readOnlyDatabase(currentPath);
  const history = readOnlyDatabase(historyPath);
  const plan = buildPlan(current, history);
  if (plan.duplicateBotChats.current.length || plan.duplicateBotChats.history.length) {
    current.close();
    history.close();
    throw new Error(
      `Duplicate (bot_name, chat_id) rows prevent a safe merge: ${JSON.stringify(plan.duplicateBotChats)}`,
    );
  }

  fs.copyFileSync(currentPath, outputPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(outputPath, 0o600);
  const output = new Database(outputPath, { fileMustExist: true });
  let completed = false;
  try {
    output.pragma('journal_mode = DELETE');
    output.pragma('foreign_keys = ON');
    const result = output.transaction(() => {
      output.exec(SCHEMA_SQL);
      const outputSessions = readSessions(output);
      const byKey = new Map(outputSessions.map((row) => [sessionKey(row), row]));
      const usedIds = new Set(outputSessions.map((row) => row.id));
      const historyIdMap = new Map<string, string>();
      let mergedSessions = 0;
      let insertedSessions = 0;
      let remappedSessionIds = 0;

      const updateSession = output.prepare(`
        UPDATE sessions SET
          claude_session_id = ?, working_directory = ?, title = ?, platform = ?,
          created_at = ?, updated_at = ?
        WHERE id = ?
      `);
      const insertSession = output.prepare(`
        INSERT INTO sessions
          (id, bot_name, claude_session_id, working_directory, title, platform, chat_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const historySession of readSessions(history)) {
        const existing = byKey.get(sessionKey(historySession));
        if (existing) {
          const merged = mergeSessionMetadata(existing, historySession);
          updateSession.run(
            merged.claude_session_id,
            merged.working_directory,
            merged.title,
            merged.platform,
            merged.created_at,
            merged.updated_at,
            merged.id,
          );
          byKey.set(sessionKey(merged), merged);
          historyIdMap.set(historySession.id, merged.id);
          mergedSessions += 1;
          continue;
        }

        let id = historySession.id;
        if (usedIds.has(id)) {
          id = uniqueSessionId(usedIds);
          remappedSessionIds += 1;
        }
        const inserted = { ...historySession, id };
        insertSession.run(
          inserted.id,
          inserted.bot_name,
          inserted.claude_session_id,
          inserted.working_directory,
          inserted.title,
          inserted.platform,
          inserted.chat_id,
          inserted.created_at,
          inserted.updated_at,
        );
        usedIds.add(id);
        byKey.set(sessionKey(inserted), inserted);
        historyIdMap.set(historySession.id, id);
        insertedSessions += 1;
      }

      const messageKeys = new Set(readMessages(output).map(messageKey));
      const insertMessage = output.prepare(`
        INSERT INTO session_messages
          (session_id, role, text, platform, cost_usd, duration_ms, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let insertedMessages = 0;
      let deduplicatedMessages = 0;
      for (const historyMessage of readMessages(history)) {
        const sessionId = historyIdMap.get(historyMessage.session_id);
        if (!sessionId) throw new Error(`History message refers to an unknown session: ${historyMessage.session_id}`);
        const mapped = { ...historyMessage, session_id: sessionId };
        const key = messageKey(mapped);
        if (messageKeys.has(key)) {
          deduplicatedMessages += 1;
          continue;
        }
        insertMessage.run(
          mapped.session_id,
          mapped.role,
          mapped.text,
          mapped.platform,
          mapped.cost_usd,
          mapped.duration_ms,
          mapped.timestamp,
        );
        messageKeys.add(key);
        insertedMessages += 1;
      }

      const linkKeys = new Set(readLinks(output).map(linkKey));
      const insertLink = output.prepare(`
        INSERT INTO session_links (session_id, chat_id, platform, linked_at)
        VALUES (?, ?, ?, ?)
      `);
      let insertedLinks = 0;
      let deduplicatedLinks = 0;
      for (const historyLink of readLinks(history)) {
        const sessionId = historyIdMap.get(historyLink.session_id);
        if (!sessionId) throw new Error(`History link refers to an unknown session: ${historyLink.session_id}`);
        const mapped = { ...historyLink, session_id: sessionId };
        const key = linkKey(mapped);
        if (linkKeys.has(key)) {
          deduplicatedLinks += 1;
          continue;
        }
        insertLink.run(mapped.session_id, mapped.chat_id, mapped.platform, mapped.linked_at);
        linkKeys.add(key);
        insertedLinks += 1;
      }

      return {
        mergedSessions,
        insertedSessions,
        remappedSessionIds,
        insertedMessages,
        deduplicatedMessages,
        insertedLinks,
        deduplicatedLinks,
      };
    })();

    const integrityRows = output.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const integrityCheck = integrityRows.map((row) => row.integrity_check).join('; ');
    const foreignKeyViolations = (output.pragma('foreign_key_check') as unknown[]).length;
    const indexRows = output.pragma('index_list(sessions)') as Array<{ name: string; unique: number }>;
    if (integrityCheck !== 'ok') throw new Error(`Output integrity check failed: ${integrityCheck}`);
    if (foreignKeyViolations) throw new Error(`Output has ${foreignKeyViolations} foreign-key violations`);
    if (!indexRows.some((row) => row.name === 'idx_sessions_bot_chat_unique' && row.unique === 1)) {
      throw new Error('Output is missing the unique (bot_name, chat_id) index');
    }
    if (indexRows.some((row) => row.name === 'idx_sessions_chat_id_unique')) {
      throw new Error('Output still has the legacy chat_id-only unique index');
    }

    const report = {
      ...plan,
      ...result,
      output: readCounts(output),
      integrityCheck,
      foreignKeyViolations,
    };
    completed = true;
    return report;
  } finally {
    if (output.open) output.close();
    if (current.open) current.close();
    if (history.open) history.close();
    if (!completed) {
      fs.rmSync(outputPath, { force: true });
      fs.rmSync(`${outputPath}-wal`, { force: true });
      fs.rmSync(`${outputPath}-shm`, { force: true });
    }
  }
}

export async function snapshotSessionDatabase(sourcePath: string, outputPath: string): Promise<DatabaseCounts> {
  const source = assertInputPath(sourcePath, 'Source');
  const output = path.resolve(outputPath);
  if (source === output) throw new Error('Source and output database paths must be different');
  if (fs.existsSync(output) || fs.existsSync(`${output}-wal`) || fs.existsSync(`${output}-shm`)) {
    throw new Error(`Output database already exists: ${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const db = readOnlyDatabase(source);
  try {
    await db.backup(output);
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  } finally {
    db.close();
  }
  fs.chmodSync(output, 0o600);
  const snapshot = readOnlyDatabase(output);
  try {
    const integrity = snapshot.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`Snapshot integrity check failed: ${JSON.stringify(integrity)}`);
    }
    return readCounts(snapshot);
  } finally {
    snapshot.close();
  }
}

/**
 * Merge history into a live registry without replacing its database file.
 *
 * BEGIN IMMEDIATE serializes Bridge writes while a second read connection
 * creates the exact rollback backup. The already-validated merged database is
 * then copied into the live tables in the same transaction, so readers see
 * either the old registry or the complete merged registry.
 */
export async function mergeSessionDatabaseInPlace(options: {
  currentPath: string;
  historyPath: string;
  backupPath: string;
}): Promise<InPlaceSessionDatabaseMergeReport> {
  const currentPath = assertInputPath(options.currentPath, 'Current');
  const historyPath = assertInputPath(options.historyPath, 'History');
  const backupPath = path.resolve(options.backupPath);
  if (new Set([currentPath, historyPath, backupPath]).size !== 3) {
    throw new Error('Current, history, and backup database paths must be different');
  }
  if (fs.existsSync(backupPath) || fs.existsSync(`${backupPath}-wal`) || fs.existsSync(`${backupPath}-shm`)) {
    throw new Error(`Backup database already exists: ${backupPath}`);
  }
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const stagingPath = `${backupPath}.merged-${process.pid}-${crypto.randomUUID()}`;

  const live = new Database(currentPath, { fileMustExist: true });
  const backupSource = readOnlyDatabase(currentPath);
  let attached = false;
  try {
    live.pragma('busy_timeout = 10000');
    live.pragma('foreign_keys = ON');
    live.exec('BEGIN IMMEDIATE');
    try {
      await backupSource.backup(backupPath);
      if (!fs.existsSync(backupPath)) throw new Error('SQLite did not create the rollback backup');
      fs.chmodSync(backupPath, 0o600);

      const report = mergeSessionDatabases({ currentPath: backupPath, historyPath, outputPath: stagingPath });
      live.exec(SCHEMA_SQL);
      live.prepare('ATTACH DATABASE ? AS session_migration').run(stagingPath);
      attached = true;
      live.exec(`
        DELETE FROM session_messages;
        DELETE FROM session_links;
        DELETE FROM sessions;

        INSERT INTO sessions
          (id, bot_name, claude_session_id, working_directory, title, platform, chat_id, created_at, updated_at)
        SELECT id, bot_name, claude_session_id, working_directory, title, platform, chat_id, created_at, updated_at
        FROM session_migration.sessions;

        INSERT INTO session_links (session_id, chat_id, platform, linked_at)
        SELECT session_id, chat_id, platform, linked_at FROM session_migration.session_links;

        INSERT INTO session_messages (id, session_id, role, text, platform, cost_usd, duration_ms, timestamp)
        SELECT id, session_id, role, text, platform, cost_usd, duration_ms, timestamp
        FROM session_migration.session_messages;

        DELETE FROM sqlite_sequence WHERE name = 'session_messages';
        INSERT INTO sqlite_sequence (name, seq)
        SELECT 'session_messages', COALESCE(MAX(id), 0) FROM session_messages;
      `);

      const liveCounts = readCounts(live);
      if (JSON.stringify(liveCounts) !== JSON.stringify(report.output)) {
        throw new Error(
          `Live count verification failed: ${JSON.stringify({ expected: report.output, actual: liveCounts })}`,
        );
      }
      const integrity = live.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`Live integrity check failed: ${JSON.stringify(integrity)}`);
      }
      const foreignKeyViolations = (live.pragma('foreign_key_check') as unknown[]).length;
      if (foreignKeyViolations) throw new Error(`Live database has ${foreignKeyViolations} foreign-key violations`);
      live.exec('COMMIT');
      return { ...report, backupPath };
    } catch (error) {
      if (live.inTransaction) live.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (attached) {
      try {
        live.exec('DETACH DATABASE session_migration');
      } catch {
        // Closing the connection detaches it after either COMMIT or ROLLBACK.
      }
    }
    if (backupSource.open) backupSource.close();
    if (live.open) live.close();
    fs.rmSync(stagingPath, { force: true });
    fs.rmSync(`${stagingPath}-wal`, { force: true });
    fs.rmSync(`${stagingPath}-shm`, { force: true });
  }
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) flags.set(name, 'true');
    else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { positionals, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export async function runSessionRegistryMigrationCli(argv = process.argv.slice(2)): Promise<unknown> {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0] ?? 'merge';
  const apply = flags.get('apply') === 'true';
  if (command === 'snapshot') {
    const sourcePath = required(flags, 'source');
    const outputPath = required(flags, 'output');
    if (!apply)
      return { mode: 'dry-run', command, sourcePath: path.resolve(sourcePath), outputPath: path.resolve(outputPath) };
    return { mode: 'apply', command, output: await snapshotSessionDatabase(sourcePath, outputPath) };
  }
  if (command !== 'merge') throw new Error('Usage: session-registry-migration [merge|snapshot] [options]');
  const currentPath = required(flags, 'current');
  const historyPath = required(flags, 'history');
  const plan = planSessionDatabaseMerge(currentPath, historyPath);
  if (!apply) return { mode: 'dry-run', command, plan };
  if (flags.get('in-place') === 'true') {
    if (flags.has('output')) throw new Error('--output cannot be combined with --in-place');
    return {
      mode: 'apply',
      command,
      report: await mergeSessionDatabaseInPlace({
        currentPath,
        historyPath,
        backupPath: required(flags, 'backup'),
      }),
    };
  }
  const outputPath = required(flags, 'output');
  return {
    mode: 'apply',
    command,
    report: mergeSessionDatabases({ currentPath, historyPath, outputPath }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runSessionRegistryMigrationCli()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`session-registry-migration: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
