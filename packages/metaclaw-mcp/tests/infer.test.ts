import { afterEach, describe, expect, it } from 'vitest';

import { MetaClawError } from '../src/errors.js';
import {
  assertReturnedModelProvider,
  buildProvenance,
  extractCompletionText,
  prepareInference,
  SESSION_HEADER,
  STRIPPED_CONTROL_KEYS,
  TURN_TYPE_HEADER,
} from '../src/infer.js';
import { loadMetaClawProfile, type MetaClawProfile } from '../src/profile.js';
import { cleanupFixtures, createFixture } from './helpers.js';

afterEach(cleanupFixtures);

function profile(): MetaClawProfile {
  return loadMetaClawProfile(createFixture().profilePath);
}

function failureOf(run: () => unknown): { code: string; field: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof MetaClawError) return { code: error.code, field: error.details?.field };
    return { code: `unexpected:${String(error)}`, field: undefined };
  }
  return { code: 'no-error', field: undefined };
}

const messages = [{ role: 'user' as const, content: 'hello' }];

describe('inference request construction', () => {
  it('pins the model and forces a non-streaming body', () => {
    const prepared = prepareInference(profile(), { messages });
    expect(prepared.body.model).toBe('fixture-pinned-model');
    expect(prepared.body.stream).toBe(false);
    expect(prepared.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(prepared.body.max_tokens).toBe(1_024);
  });

  it('injects a fresh per-turn session id and a side turn type', () => {
    const pinned = profile();
    const first = prepareInference(pinned, { messages });
    const second = prepareInference(pinned, { messages });

    expect(first.headers[TURN_TYPE_HEADER]).toBe('side');
    expect(first.headers[SESSION_HEADER]).toMatch(/^metaclaw-side-[0-9a-f-]{36}$/);
    expect(second.headers[SESSION_HEADER]).not.toBe(first.headers[SESSION_HEADER]);
  });

  it('removes every caller-supplied control and reports which ones', () => {
    const controls = Object.fromEntries(STRIPPED_CONTROL_KEYS.map((key) => [key, 'caller-chosen']));
    const prepared = prepareInference(profile(), { messages, controls });

    expect(prepared.strippedControls).toEqual([...STRIPPED_CONTROL_KEYS].sort());

    // `model` and `stream` do appear in the outbound body, but with this
    // server's values, never the caller's. Every other control is gone.
    expect(prepared.body.model).toBe('fixture-pinned-model');
    expect(prepared.body.stream).toBe(false);
    expect(Object.keys(prepared.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);

    const serialized = JSON.stringify(prepared.body);
    for (const key of STRIPPED_CONTROL_KEYS) {
      if (key === 'model' || key === 'stream') continue;
      expect(serialized, key).not.toContain(`"${key}"`);
    }
    expect(serialized).not.toContain('caller-chosen');
  });

  it('reports no stripped controls when the caller sent none and every unknown control when present', () => {
    expect(prepareInference(profile(), { messages }).strippedControls).toEqual([]);
    expect(prepareInference(profile(), { messages, controls: { unrelated: 1 } }).strippedControls).toEqual(['unrelated']);
  });

  it('lets a caller shorten the deadline but never extend it', () => {
    expect(prepareInference(profile(), { messages, deadlineMs: 1_000 }).deadlineMs).toBe(1_000);
    expect(prepareInference(profile(), { messages, deadlineMs: 999_999 }).deadlineMs).toBe(30_000);
    expect(prepareInference(profile(), { messages }).deadlineMs).toBe(30_000);
    expect(failureOf(() => prepareInference(profile(), { messages, deadlineMs: 0 }))).toEqual({
      code: 'invalid_request',
      field: 'deadlineMs',
    });
  });

  it('bounds message count, prompt bytes, and requested output tokens', () => {
    const pinned = profile();
    expect(failureOf(() => prepareInference(pinned, { messages: [] }))).toEqual({
      code: 'invalid_request',
      field: 'messages',
    });
    expect(
      failureOf(() =>
        prepareInference(pinned, {
          messages: Array.from({ length: 21 }, () => ({ role: 'user' as const, content: 'x' })),
        }),
      ),
    ).toEqual({ code: 'invalid_request', field: 'messages' });
    expect(
      failureOf(() => prepareInference(pinned, { messages: [{ role: 'user', content: 'x'.repeat(70_000) }] })),
    ).toEqual({ code: 'invalid_request', field: 'messages' });
    expect(failureOf(() => prepareInference(pinned, { messages, maxOutputTokens: 2_000 }))).toEqual({
      code: 'invalid_request',
      field: 'maxOutputTokens',
    });
  });

  it('counts prompt bytes in UTF-8, not characters', () => {
    expect(prepareInference(profile(), { messages: [{ role: 'user', content: '汉字' }] }).promptBytes).toBe(6);
  });
});

describe('inference provenance', () => {
  it('carries identity and bounds, never prompt or response text', () => {
    const pinned = profile();
    const prepared = prepareInference(pinned, { messages: [{ role: 'user', content: 'secret prompt text' }] });
    const provenance = buildProvenance({
      profile: pinned,
      prepared,
      releaseId: '0.4.1+mcpsec.1-fixture',
      official: false,
      elapsedMs: 42,
    });

    expect(provenance).toMatchObject({
      model: 'fixture-pinned-model',
      provider: 'fixture-provider',
      turnType: 'side',
      official: false,
      elapsedMs: 42,
      streaming: 'unsupported',
      upstreamCancellation: 'unsupported',
      promptBytes: 18,
    });
    expect(JSON.stringify(provenance)).not.toContain('secret prompt text');
  });
});

describe('completion extraction', () => {
  it('returns the assistant text', () => {
    expect(extractCompletionText({ choices: [{ message: { role: 'assistant', content: 'answer' } }] })).toBe('answer');
  });

  it('reports a contract violation rather than guessing at an unexpected shape', () => {
    for (const json of [
      {},
      { choices: [] },
      { choices: 'nope' },
      { choices: [{}] },
      { choices: [{ message: null }] },
      { choices: [{ message: { content: 42 } }] },
    ]) {
      expect(failureOf(() => extractCompletionText(json as Record<string, unknown>)).code).toBe('contract_violation');
    }
  });
});

describe('returned dispatch identity', () => {
  it('requires both the exact pinned model and provider', () => {
    const pinned = profile();
    expect(() => assertReturnedModelProvider({
      model: 'fixture-pinned-model', provider: 'fixture-provider',
    }, pinned)).not.toThrow();
    for (const response of [
      { model: 'other', provider: 'fixture-provider' },
      { model: 'fixture-pinned-model', provider: 'other' },
      { model: 'fixture-pinned-model' },
      { provider: 'fixture-provider' },
    ]) {
      expect(failureOf(() => assertReturnedModelProvider(response, pinned)).code).toBe('contract_violation');
    }
  });
});
