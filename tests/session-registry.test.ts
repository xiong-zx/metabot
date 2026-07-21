import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      expect(registry.listSessions('admin')).toHaveLength(1);
      expect(registry.listSessions('memory')).toHaveLength(1);
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

      const adminMessages = registry.getMessages(adminId).map((m) => m.text);
      const memoryMessages = registry.getMessages(memoryId).map((m) => m.text);
      expect(adminMessages).toEqual(['admin prompt', 'admin response', 'admin prompt 2', 'admin response 2']);
      expect(memoryMessages).toEqual(['memory prompt', 'memory response']);
    } finally {
      registry.close();
    }
  });

  it('clears only the selected bot resume pointer while retaining history', () => {
    const registry = new SessionRegistry(createLogger());
    try {
      const adminId = registry.createOrUpdate({
        botName: 'admin',
        chatId: 'oc_same_chat',
        claudeSessionId: 'admin-unsafe',
        workingDirectory: '/root',
        prompt: 'admin prompt',
        responseText: 'timeout',
      });
      registry.createOrUpdate({
        botName: 'memory',
        chatId: 'oc_same_chat',
        claudeSessionId: 'memory-safe',
        workingDirectory: '/root/metabot',
        prompt: 'memory prompt',
        responseText: 'memory response',
      });

      expect(registry.clearClaudeSessionId('oc_same_chat', 'admin')).toBe(true);
      expect(registry.findByChatId('oc_same_chat', 'admin')?.claudeSessionId).toBeUndefined();
      expect(registry.findByChatId('oc_same_chat', 'memory')?.claudeSessionId).toBe('memory-safe');
      expect(registry.getMessages(adminId).map((message) => message.text)).toEqual([
        'admin prompt',
        'timeout',
      ]);
    } finally {
      registry.close();
    }
  });
});
