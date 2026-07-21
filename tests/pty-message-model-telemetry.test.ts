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
});
