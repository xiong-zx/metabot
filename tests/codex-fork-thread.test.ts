import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodexRolloutFile, forkCodexThread, readCodexLastTokenUsage } from '../src/engines/codex/executor.js';

const THREAD_ID = '019ebab2-b996-7a33-b6ae-7e1ad9476f14';

function makeFakeCodexHome(): { home: string; rolloutPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'metabot-codex-home-'));
  const dayDir = join(home, 'sessions', '2026', '06', '12');
  mkdirSync(dayDir, { recursive: true });
  const rolloutPath = join(dayDir, `rollout-2026-06-12T15-18-55-${THREAD_ID}.jsonl`);
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID, cwd: '/tmp' } }),
    JSON.stringify({ type: 'response_item', payload: { text: 'PINEAPPLE' } }),
  ].join('\n') + '\n');
  return { home, rolloutPath };
}

describe('Codex rollout thread helpers', () => {
  it('finds the rollout file by thread id under sessions/YYYY/MM/DD', () => {
    const { home, rolloutPath } = makeFakeCodexHome();
    try {
      expect(findCodexRolloutFile(THREAD_ID, home)).toBe(rolloutPath);
      expect(findCodexRolloutFile('00000000-dead-beef-0000-000000000000', home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('forks by copying the rollout under a fresh UUID with ids rewritten', () => {
    const { home, rolloutPath } = makeFakeCodexHome();
    try {
      const fork = forkCodexThread(THREAD_ID, home);
      expect(fork).toBeDefined();
      const { forkId, forkPath } = fork!;
      expect(forkId).not.toBe(THREAD_ID);
      expect(forkPath).toContain(forkId);
      expect(existsSync(forkPath)).toBe(true);

      const forked = readFileSync(forkPath, 'utf-8');
      expect(forked).not.toContain(THREAD_ID);
      expect(forked).toContain(forkId);
      expect(forked).toContain('PINEAPPLE');

      const original = readFileSync(rolloutPath, 'utf-8');
      expect(original).toContain(THREAD_ID);
      expect(original).not.toContain(forkId);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns undefined when the thread has no rollout', () => {
    const { home } = makeFakeCodexHome();
    try {
      expect(forkCodexThread('11111111-2222-3333-4444-555555555555', home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('readCodexLastTokenUsage', () => {
  it('returns the latest token_count last_token_usage instead of cumulative totals', () => {
    const { home, rolloutPath } = makeFakeCodexHome();
    try {
      appendFileSync(rolloutPath, [
        JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 25813, cached_input_tokens: 23424, output_tokens: 101 },
          last_token_usage: { input_tokens: 25813, cached_input_tokens: 23424, output_tokens: 101 },
          model_context_window: 950000,
        } } }),
        JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 84328, cached_input_tokens: 76416, output_tokens: 380 },
          last_token_usage: { input_tokens: 30443, cached_input_tokens: 27520, output_tokens: 23 },
          model_context_window: 950000,
        } } }),
      ].join('\n') + '\n');

      expect(readCodexLastTokenUsage(THREAD_ID, home)).toEqual({
        inputTokens: 30443,
        cachedInputTokens: 27520,
        outputTokens: 23,
        contextWindow: 950000,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns undefined when the rollout has no token_count events', () => {
    const { home } = makeFakeCodexHome();
    try {
      expect(readCodexLastTokenUsage(THREAD_ID, home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
