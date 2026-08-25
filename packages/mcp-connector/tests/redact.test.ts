import { describe, expect, it } from 'vitest';

import { createRedactor } from '../src/redact.js';

describe('createRedactor', () => {
  it('removes every occurrence of each registered secret', () => {
    const redact = createRedactor(['super-secret-bearer', 'capability.token.value']);
    expect(redact('sent super-secret-bearer twice: super-secret-bearer')).toBe('sent [redacted] twice: [redacted]');
    expect(redact(new Error('auth failed for capability.token.value'))).toBe('auth failed for [redacted]');
  });

  it('redacts inside serialized objects', () => {
    const redact = createRedactor(['super-secret-bearer']);
    expect(redact({ authorization: 'Bearer super-secret-bearer' })).toBe('{"authorization":"Bearer [redacted]"}');
  });

  it('prefers the longest match so a shorter prefix cannot expose the remainder', () => {
    const redact = createRedactor(['prefix-secret', 'prefix-secret-longer']);
    expect(redact('value prefix-secret-longer end')).toBe('value [redacted] end');
  });

  it('ignores empty, whitespace, and too-short secrets that would over-redact', () => {
    const redact = createRedactor([undefined, '', '   ', 'abc']);
    expect(redact.size).toBe(0);
    expect(redact('abc stays intact')).toBe('abc stays intact');
  });

  it('deduplicates repeated secrets', () => {
    expect(createRedactor(['same-secret-value', 'same-secret-value']).size).toBe(1);
  });

  it('handles non-serializable input without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createRedactor(['some-secret-value'])(cyclic)).not.toThrow();
    expect(createRedactor([])(undefined)).toBe('undefined');
    expect(createRedactor([])(null)).toBe('null');
  });
});
