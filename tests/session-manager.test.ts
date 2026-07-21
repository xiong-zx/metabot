import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../src/engines/claude/session-manager.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'metabot-session-test-'));
    process.env.SESSION_STORE_DIR = storeDir;
  });

  afterEach(() => {
    if (manager) manager.destroy();
    delete process.env.SESSION_STORE_DIR;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it('creates a new session with default working directory', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const session = manager.getSession('chat1');
    expect(session.workingDirectory).toBe('/tmp/test-dir');
    expect(session.sessionId).toBeUndefined();
  });

  it('returns the same session for the same chatId', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat1');
    expect(s1).toBe(s2);
  });

  it('returns different sessions for different chatIds', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat2');
    expect(s1).not.toBe(s2);
  });

  it('sets session ID', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBe('sess-abc');
    expect(session.sessionIdEngine).toBe('codex');
  });

  it('resets session (clears sessionId)', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    manager.resetSession('chat1');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBeUndefined();
    expect(session.sessionIdEngine).toBeUndefined();
  });

  it('invalidates only the unsafe engine session pointer', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'invalidate-test');
    manager.setSessionId('chat1', 'sess-unsafe', 'claude');
    manager.setSessionModel('chat1', 'claude-fable-5', 'claude');
    manager.setGoal('chat1', 'finish the repair');
    manager.addUsage('chat1', 123, 0.25, 456);

    manager.invalidateSessionId('chat1', 'turn_start_timeout');

    const session = manager.getSession('chat1');
    expect(session.sessionId).toBeUndefined();
    expect(session.sessionIdEngine).toBeUndefined();
    expect(session.model).toBe('claude-fable-5');
    expect(session.activeGoal).toBe('finish the repair');
    expect(session.cumulativeTokens).toBe(123);
    expect(session.cumulativeCostUsd).toBe(0.25);
    expect(session.cumulativeDurationMs).toBe(456);
  });

  it('tracks model engine and clears it with the model override', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.setSessionModel('chat1', 'gpt-5.5-codex', 'codex');

    let session = manager.getSession('chat1');
    expect(session.model).toBe('gpt-5.5-codex');
    expect(session.modelEngine).toBe('codex');

    manager.setSessionModel('chat1', undefined);
    session = manager.getSession('chat1');
    expect(session.model).toBeUndefined();
    expect(session.modelEngine).toBeUndefined();
  });

  it('persists session and model engine metadata', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'persist-test');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    manager.setSessionModel('chat1', 'gpt-5.5-codex', 'codex');
    manager.destroy();

    manager = new SessionManager('/tmp/test-dir', createLogger(), 'persist-test');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBe('sess-abc');
    expect(session.sessionIdEngine).toBe('codex');
    expect(session.model).toBe('gpt-5.5-codex');
    expect(session.modelEngine).toBe('codex');
  });

  it('persists Codex reasoning effort metadata', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'effort-test');
    manager.setReasoningEffort('chat1', 'high');
    manager.destroy();

    manager = new SessionManager('/tmp/test-dir', createLogger(), 'effort-test');
    const session = manager.getSession('chat1');
    expect(session.reasoningEffort).toBe('high');

    manager.setReasoningEffort('chat1', undefined);
    expect(manager.getSession('chat1').reasoningEffort).toBeUndefined();
  });

  it('repairs persisted sessions whose working directory no longer exists', () => {
    const defaultDir = mkdtempSync(join(tmpdir(), 'metabot-session-default-'));
    const storePath = join(storeDir, 'sessions-repair-test.json');
    writeFileSync(storePath, JSON.stringify({
      chat1: {
        sessionId: 'stale-session',
        sessionIdEngine: 'codex',
        workingDirectory: join(storeDir, 'missing-workdir'),
        lastUsed: Date.now(),
      },
    }));

    manager = new SessionManager(defaultDir, createLogger(), 'repair-test');
    const session = manager.getSession('chat1');

    expect(session.workingDirectory).toBe(defaultDir);
    expect(session.sessionId).toBeUndefined();
    expect(session.sessionIdEngine).toBeUndefined();

    rmSync(defaultDir, { recursive: true, force: true });
  });
});
