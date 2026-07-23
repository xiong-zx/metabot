import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_200K,
  has1MContext,
  resolveContextWindow,
  stripModelSuffix,
} from '../src/utils/model-id.js';

/**
 * The `[1m]` suffix is local to Claude Code — the API never echoes it back.
 * Every consumer that compares a configured model id against a runtime one, or
 * derives a context window from an id, depends on the helpers here. Getting
 * this wrong is what produced the "ctx: 37.8k/200k" and the spurious
 * "opus-4-8[1m] → opus-4-8" fallback arrow on the Feishu card.
 */
describe('model id helpers', () => {
  describe('stripModelSuffix', () => {
    it('drops a trailing bracket suffix', () => {
      expect(stripModelSuffix('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    });

    it('leaves unsuffixed ids untouched', () => {
      expect(stripModelSuffix('claude-opus-4-8')).toBe('claude-opus-4-8');
      expect(stripModelSuffix('claude-fable-5')).toBe('claude-fable-5');
    });

    it('makes a configured/runtime pair compare equal for the same model', () => {
      expect(stripModelSuffix('claude-opus-4-8[1m]')).toBe(stripModelSuffix('claude-opus-4-8'));
    });

    it('keeps genuinely different models distinct', () => {
      expect(stripModelSuffix('claude-fable-5')).not.toBe(stripModelSuffix('claude-sonnet-5'));
    });
  });

  describe('has1MContext', () => {
    it('detects the explicit opt-in suffix', () => {
      expect(has1MContext('claude-opus-4-8[1m]')).toBe(true);
      expect(has1MContext('claude-sonnet-4-6[1m]')).toBe(true);
    });

    it('treats Fable 5 as natively 1M', () => {
      expect(has1MContext('claude-fable-5')).toBe(true);
      expect(has1MContext('claude-fable-5[1m]')).toBe(true);
    });

    it('is false without the suffix on opt-in models', () => {
      expect(has1MContext('claude-opus-4-8')).toBe(false);
      expect(has1MContext('claude-sonnet-5')).toBe(false);
    });

    it('is false for an unknown model', () => {
      expect(has1MContext(undefined)).toBe(false);
    });
  });

  describe('resolveContextWindow', () => {
    it('reports 1M for models that requested it', () => {
      expect(resolveContextWindow('claude-opus-4-8[1m]')).toBe(CONTEXT_WINDOW_1M);
      expect(resolveContextWindow('claude-fable-5')).toBe(CONTEXT_WINDOW_1M);
    });

    it('reports 200K otherwise', () => {
      expect(resolveContextWindow('claude-opus-4-8')).toBe(CONTEXT_WINDOW_200K);
      expect(resolveContextWindow(undefined)).toBe(CONTEXT_WINDOW_200K);
    });
  });
});
