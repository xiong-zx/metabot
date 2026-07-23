import { describe, expect, it } from 'vitest';
import { adaptJsonlRecord, synthesizeResult } from '../src/engines/claude/pty/message-adapter.js';

describe('PTY message model telemetry', () => {
  it('preserves assistant JSONL model even when usage is absent', () => {
    expect(adaptJsonlRecord({
      type: 'assistant',
      sessionId: 'sess-1',
      message: {
        model: 'claude-fable-5',
        content: [{ type: 'text', text: 'done' }],
      },
    })).toMatchObject({
      type: 'assistant',
      session_id: 'sess-1',
      model: 'claude-fable-5',
    });
  });

  it('preserves model fallback fields from system JSONL', () => {
    expect(adaptJsonlRecord({
      type: 'system',
      subtype: 'model_consent_fallback',
      sessionId: 'sess-1',
      originalModel: 'claude-fable-5',
      fallbackModel: 'claude-sonnet-5',
      content: 'Fable 5 requires usage credits',
    })).toMatchObject({
      type: 'system',
      subtype: 'model_consent_fallback',
      originalModel: 'claude-fable-5',
      fallbackModel: 'claude-sonnet-5',
      content: 'Fable 5 requires usage credits',
    });
  });

  it('copies structured model provenance to the synthetic result', () => {
    expect(synthesizeResult({
      sessionId: 'sess-1',
      model: 'claude-sonnet-5',
      modelTelemetry: {
        configuredModel: 'claude-fable-5',
        spawnModel: 'claude-fable-5',
        runtimeModel: 'claude-sonnet-5',
        runtimeModelSource: 'assistant_jsonl',
        fallbackOriginalModel: 'claude-fable-5',
        fallbackModel: 'claude-sonnet-5',
      },
    })).toMatchObject({
      type: 'result',
      modelTelemetry: {
        configuredModel: 'claude-fable-5',
        runtimeModel: 'claude-sonnet-5',
        fallbackModel: 'claude-sonnet-5',
      },
    });
  });

  /**
   * The PTY path has no real `result` record, so the window reported on the
   * card comes entirely from what synthesizeResult puts here. It must be read
   * off the CONFIGURED model — `args.model` is the runtime id, which the API
   * returns without the `[1m]` suffix, and would pin every session to 200K.
   */
  describe('synthetic result context window', () => {
    const usage = { inputTokens: 37_800, outputTokens: 500 };

    it('reports 1M when the configured model opted in via [1m]', () => {
      const msg = synthesizeResult({
        sessionId: 'sess-1',
        model: 'claude-opus-4-8',                    // runtime id: no suffix
        modelTelemetry: {
          configuredModel: 'claude-opus-4-8[1m]',
          spawnModel: 'claude-opus-4-8[1m]',
          runtimeModel: 'claude-opus-4-8',
        },
        usage,
      });
      expect(msg.modelUsage?.['claude-opus-4-8']?.contextWindow).toBe(1_000_000);
    });

    it('reports 1M for natively-1M Fable 5', () => {
      const msg = synthesizeResult({
        sessionId: 'sess-1',
        model: 'claude-fable-5',
        modelTelemetry: { configuredModel: 'claude-fable-5', runtimeModel: 'claude-fable-5' },
        usage,
      });
      expect(msg.modelUsage?.['claude-fable-5']?.contextWindow).toBe(1_000_000);
    });

    it('reports 200K without the opt-in', () => {
      const msg = synthesizeResult({
        sessionId: 'sess-1',
        model: 'claude-opus-4-8',
        modelTelemetry: {
          configuredModel: 'claude-opus-4-8',
          spawnModel: 'claude-opus-4-8',
          runtimeModel: 'claude-opus-4-8',
        },
        usage,
      });
      expect(msg.modelUsage?.['claude-opus-4-8']?.contextWindow).toBe(200_000);
    });

    it('falls back to the runtime model when telemetry carries no configured id', () => {
      const msg = synthesizeResult({
        sessionId: 'sess-1',
        model: 'claude-fable-5',
        usage,
      });
      expect(msg.modelUsage?.['claude-fable-5']?.contextWindow).toBe(1_000_000);
    });
  });
});
