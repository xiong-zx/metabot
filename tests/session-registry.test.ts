import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SessionRegistry } from '../src/session/session-registry.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(() => createLogger()) } as any;
}

describe('SessionRegistry', () => {
  let dir: string;
  let previousStoreDir: string | undefined;

  beforeEach(() => {
    previousStoreDir = process.env.SESSION_STORE_DIR;
    dir = mkdtempSync(join(tmpdir(), 'metabot-session-registry-'));
    process.env.SESSION_STORE_DIR = dir;
  });

  afterEach(() => {
    if (previousStoreDir === undefined) {
      delete process.env.SESSION_STORE_DIR;
    } else {
      process.env.SESSION_STORE_DIR = previousStoreDir;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps sessions separate for different bots in the same chat', () => {
    const registry = new SessionRegistry(createLogger());
    try {
      const adminId = registry.createOrUpdate({
        botName: 'admin',
        chatId: 'oc_same_chat',
        claudeSessionId: 'admin-session',
        workingDirectory: '/root',
        prompt: 'admin prompt',
        responseText: 'admin response',
      });
      const memoryId = registry.createOrUpdate({
        botName: 'memory',
        chatId: 'oc_same_chat',
        claudeSessionId: 'memory-session',
        workingDirectory: '/root/metabot',
        prompt: 'memory prompt',
        responseText: 'memory response',
      });

      expect(adminId).not.toBe(memoryId);
      expect(registry.findByChatId('oc_same_chat', 'admin')?.claudeSessionId).toBe('admin-session');
      expect(registry.findByChatId('oc_same_chat', 'memory')?.claudeSessionId).toBe('memory-session');

      registry.createOrUpdate({
        botName: 'admin',
        chatId: 'oc_same_chat',
        claudeSessionId: 'admin-session-2',
        workingDirectory: '/root',
        prompt: 'admin prompt 2',
        responseText: 'admin response 2',
      });

      expect(registry.findByChatId('oc_same_chat', 'admin')?.claudeSessionId).toBe('admin-session-2');
      expect(registry.findByChatId('oc_same_chat', 'memory')?.claudeSessionId).toBe('memory-session');
      expect(registry.getMessages(adminId).map((message) => message.text)).toEqual([
        'admin prompt',
        'admin response',
        'admin prompt 2',
        'admin response 2',
      ]);
      expect(registry.getMessages(memoryId).map((message) => message.text)).toEqual([
        'memory prompt',
        'memory response',
      ]);
    } finally {
      registry.close();
    }
  });

  it('opens a legacy database containing the same chat for different bots', () => {
    const dbPath = join(dir, 'sessions.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
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
    `);
    const insert = legacy.prepare(`
      INSERT INTO sessions
        (id, bot_name, claude_session_id, working_directory, title, platform, chat_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('admin-id', 'admin', 'admin-session', '/root', '', 'feishu', 'oc_shared', 1, 1);
    insert.run('memory-id', 'memory', 'memory-session', '/root', '', 'feishu', 'oc_shared', 2, 2);
    legacy.close();

    const registry = new SessionRegistry(createLogger());
    try {
      expect(registry.findByChatId('oc_shared', 'admin')?.id).toBe('admin-id');
      expect(registry.findByChatId('oc_shared', 'memory')?.id).toBe('memory-id');
    } finally {
      registry.close();
    }

    const migrated = new Database(dbPath, { readonly: true });
    try {
      const indexes = migrated.pragma('index_list(sessions)') as Array<{ name: string; unique: number }>;
      expect(indexes).toContainEqual(expect.objectContaining({ name: 'idx_sessions_bot_chat_unique', unique: 1 }));
      expect(indexes.some((index) => index.name === 'idx_sessions_chat_id_unique')).toBe(false);
    } finally {
      migrated.close();
    }
  });

  it('replaces the legacy chat-only unique index', () => {
    const dbPath = join(dir, 'sessions.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
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
      CREATE UNIQUE INDEX idx_sessions_chat_id_unique ON sessions(chat_id);
      INSERT INTO sessions
        (id, bot_name, working_directory, title, platform, chat_id, created_at, updated_at)
      VALUES ('admin-id', 'admin', '/root', '', 'feishu', 'oc_shared', 1, 1);
    `);
    legacy.close();

    const registry = new SessionRegistry(createLogger());
    try {
      const memoryId = registry.createOrUpdate({
        botName: 'memory',
        chatId: 'oc_shared',
        workingDirectory: '/root',
        prompt: 'memory prompt',
      });
      expect(memoryId).not.toBe('admin-id');
      expect(registry.findByChatId('oc_shared', 'admin')?.id).toBe('admin-id');
      expect(registry.findByChatId('oc_shared', 'memory')?.id).toBe(memoryId);
    } finally {
      registry.close();
    }

    const migrated = new Database(dbPath, { readonly: true });
    try {
      const indexes = migrated.pragma('index_list(sessions)') as Array<{ name: string; unique: number }>;
      expect(indexes).toContainEqual(expect.objectContaining({ name: 'idx_sessions_bot_chat_unique', unique: 1 }));
      expect(indexes.some((index) => index.name === 'idx_sessions_chat_id_unique')).toBe(false);
    } finally {
      migrated.close();
    }
  });
});
