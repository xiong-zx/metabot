import { describe, expect, it } from 'vitest';

import { ConnectorError } from '../src/errors.js';
import { isLoopbackHttpEndpoint, parseLoopbackHttpEndpoint, resolveEndpointPath } from '../src/endpoint.js';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

describe('parseLoopbackHttpEndpoint', () => {
  it('accepts literal loopback HTTP origins', () => {
    expect(parseLoopbackHttpEndpoint('http://127.0.0.1:9310').hostname).toBe('127.0.0.1');
    expect(parseLoopbackHttpEndpoint('http://[::1]:9310/base').hostname).toBe('[::1]');
  });

  it('refuses a missing endpoint', () => {
    expect(codeOf(() => parseLoopbackHttpEndpoint(undefined))).toBe('ENDPOINT_MISSING');
    expect(codeOf(() => parseLoopbackHttpEndpoint('   '))).toBe('ENDPOINT_MISSING');
  });

  it('refuses "localhost" because a name resolves through hosts and DNS', () => {
    expect(codeOf(() => parseLoopbackHttpEndpoint('http://localhost:9310'))).toBe('ENDPOINT_UNSAFE');
  });

  it('refuses non-loopback hosts and non-http schemes', () => {
    expect(codeOf(() => parseLoopbackHttpEndpoint('http://10.0.0.5:9310'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => parseLoopbackHttpEndpoint('https://127.0.0.1:9310'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => parseLoopbackHttpEndpoint('file:///etc/passwd'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => parseLoopbackHttpEndpoint('not a url'))).toBe('ENDPOINT_UNSAFE');
  });

  it('refuses embedded credentials, query, and fragment', () => {
    expect(codeOf(() => parseLoopbackHttpEndpoint('http://user:secret@127.0.0.1:9310'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => parseLoopbackHttpEndpoint('http://127.0.0.1:9310/?token=abc'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => parseLoopbackHttpEndpoint('http://127.0.0.1:9310/#frag'))).toBe('ENDPOINT_UNSAFE');
  });

  it('exposes a non-throwing predicate', () => {
    expect(isLoopbackHttpEndpoint('http://127.0.0.1:9310')).toBe(true);
    expect(isLoopbackHttpEndpoint('http://example.com')).toBe(false);
  });
});

describe('resolveEndpointPath', () => {
  const base = parseLoopbackHttpEndpoint('http://127.0.0.1:9310/api');

  it('joins a rooted path onto the base', () => {
    expect(resolveEndpointPath(base, '/v1/chat/completions').toString())
      .toBe('http://127.0.0.1:9310/api/v1/chat/completions');
  });

  it('refuses traversal, backslashes, and unrooted paths', () => {
    expect(codeOf(() => resolveEndpointPath(base, 'v1/models'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => resolveEndpointPath(base, '/../../admin'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => resolveEndpointPath(base, '/v1\\admin'))).toBe('ENDPOINT_UNSAFE');
  });

  it('refuses a protocol-relative path that would change the origin', () => {
    // Against a base whose pathname is "/", "//host" silently retargets the
    // request; against "/api" it does not. Both must be refused identically.
    const rootBase = parseLoopbackHttpEndpoint('http://127.0.0.1:9310');
    expect(new URL('//evil.example.com/v1', rootBase).origin).toBe('http://evil.example.com');
    expect(codeOf(() => resolveEndpointPath(rootBase, '//evil.example.com/v1'))).toBe('ENDPOINT_UNSAFE');
    expect(codeOf(() => resolveEndpointPath(base, '//evil.example.com/v1'))).toBe('ENDPOINT_UNSAFE');
  });
});
