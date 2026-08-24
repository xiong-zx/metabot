import { describe, expect, it } from 'vitest';

import { ConnectorError } from '../src/errors.js';
import { parseLoopbackHttpEndpoint } from '../src/endpoint.js';
import { createRedactor } from '../src/redact.js';
import { parseJsonResponse, requestBounded } from '../src/transport.js';

const endpoint = parseLoopbackHttpEndpoint('http://127.0.0.1:9310');
const redact = createRedactor(['super-secret-bearer']);
const limits = { deadlineMs: 1_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

describe('requestBounded', () => {
  it('performs one non-streaming exchange and reports elapsed time', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    let clock = 1_000;
    const response = await requestBounded(
      { method: 'POST', path: '/v1/chat/completions', headers: { 'x-turn-type': 'side' }, body: '{"a":1}' },
      {
        ...limits,
        endpoint,
        redact,
        now: () => {
          const value = clock;
          clock += 25;
          return value;
        },
        fetchImpl: async (url, init) => {
          seen = { url: String(url), init: init as RequestInit };
          return jsonResponse('{"ok":true}');
        },
      },
    );

    expect(seen?.url).toBe('http://127.0.0.1:9310/v1/chat/completions');
    expect((seen?.init.headers as Record<string, string>)['x-turn-type']).toBe('side');
    expect(seen?.init.redirect).toBe('error');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(parseJsonResponse<{ ok: boolean }>(response, redact)).toEqual({ ok: true });
    expect(response.elapsedMs).toBe(25);
  });

  it('refuses a request body past the ceiling before contacting the endpoint', async () => {
    let called = false;
    const code = await codeOf(() =>
      requestBounded(
        { method: 'POST', path: '/v1/chat/completions', body: 'x'.repeat(2_048) },
        {
          ...limits,
          endpoint,
          redact,
          fetchImpl: async () => {
            called = true;
            return jsonResponse('{}');
          },
        },
      ),
    );
    expect(code).toBe('REQUEST_TOO_LARGE');
    expect(called).toBe(false);
  });

  it('refuses an oversized declared response length', async () => {
    const code = await codeOf(() =>
      requestBounded(
        { method: 'GET', path: '/health' },
        {
          ...limits,
          endpoint,
          redact,
          fetchImpl: async () => jsonResponse('{}', { headers: { 'content-length': '99999' } }),
        },
      ),
    );
    expect(code).toBe('RESPONSE_TOO_LARGE');
  });

  it('refuses an oversized body even when the declared length lied', async () => {
    const code = await codeOf(() =>
      requestBounded(
        { method: 'GET', path: '/health' },
        {
          ...limits,
          maxResponseBytes: 16,
          endpoint,
          redact,
          fetchImpl: async () => jsonResponse('x'.repeat(512), { headers: { 'content-length': '2' } }),
        },
      ),
    );
    expect(code).toBe('RESPONSE_TOO_LARGE');
  });

  it('reports a deadline overrun as a structured timeout', async () => {
    const code = await codeOf(() =>
      requestBounded(
        { method: 'GET', path: '/health' },
        {
          ...limits,
          deadlineMs: 20,
          endpoint,
          redact,
          fetchImpl: (_url, init) =>
            new Promise((_resolve, reject) => {
              (init as RequestInit).signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        },
      ),
    );
    expect(code).toBe('TRANSPORT_TIMEOUT');
  });

  it('still enforces the deadline when the transport ignores the abort signal', async () => {
    // AbortSignal is a request to stop. A transport that ignores it would
    // otherwise hold the call open forever with nothing left to interrupt it.
    const code = await codeOf(() =>
      requestBounded(
        { method: 'GET', path: '/health' },
        { ...limits, deadlineMs: 20, endpoint, redact, fetchImpl: () => new Promise<Response>(() => undefined) },
      ),
    );
    expect(code).toBe('TRANSPORT_TIMEOUT');
  });

  it('enforces the same deadline while reading the response body', async () => {
    const code = await codeOf(() =>
      requestBounded(
        { method: 'GET', path: '/health' },
        {
          ...limits,
          deadlineMs: 20,
          endpoint,
          redact,
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{'));
                  // Never closes: headers arrived, the body never finishes.
                },
              }),
              { status: 200 },
            ),
        },
      ),
    );
    expect(code).toBe('TRANSPORT_TIMEOUT');
  });

  it('redacts held secrets out of transport failures', async () => {
    try {
      await requestBounded(
        { method: 'GET', path: '/health' },
        {
          ...limits,
          endpoint,
          redact,
          fetchImpl: async () => {
            throw new Error('connect failed while sending super-secret-bearer');
          },
        },
      );
      expect.unreachable('transport failure expected');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe('TRANSPORT_FAILED');
      expect((error as ConnectorError).message).not.toContain('super-secret-bearer');
      expect((error as ConnectorError).message).toContain('[redacted]');
    }
  });

  it('rejects non-positive limits rather than defaulting them', async () => {
    expect(
      await codeOf(() =>
        requestBounded({ method: 'GET', path: '/health' }, { ...limits, deadlineMs: 0, endpoint, redact }),
      ),
    ).toBe('TRANSPORT_FAILED');
  });

  it('reports an unparseable body as a structured contract failure', async () => {
    const response = await requestBounded(
      { method: 'GET', path: '/health' },
      { ...limits, endpoint, redact, fetchImpl: async () => jsonResponse('not json') },
    );
    expect(await codeOf(async () => parseJsonResponse(response, redact))).toBe('RESPONSE_INVALID');
  });
});

describe('response header handling', () => {
  const respondWith = (headers: Record<string, string>) =>
    requestBounded(
      { method: 'GET', path: '/health' },
      {
        ...limits,
        endpoint,
        redact,
        fetchImpl: async () => new Response('{}', { status: 200, headers }),
      },
    );

  it('carries back only allowlisted headers', async () => {
    const response = await respondWith({
      'content-type': 'application/json',
      'set-cookie': 'session=abc',
      'www-authenticate': 'Bearer realm="metaclaw"',
      'x-service-debug': 'internal state',
      server: 'uvicorn',
    });
    expect(Object.keys(response.headers).sort()).toEqual(['content-type']);
  });

  it('honors an explicit allowlist and drops everything outside it', async () => {
    const response = await requestBounded(
      { method: 'GET', path: '/health' },
      {
        ...limits,
        endpoint,
        redact,
        responseHeaderAllowlist: ['retry-after'],
        fetchImpl: async () =>
          new Response('{}', { status: 503, headers: { 'retry-after': '30', 'content-type': 'application/json' } }),
      },
    );
    expect(response.headers).toEqual({ 'retry-after': '30' });
  });

  it('redacts a secret an allowlisted header echoes back', async () => {
    const response = await respondWith({ 'content-type': 'application/json; token=super-secret-bearer' });
    expect(response.headers['content-type']).toBe('application/json; token=[redacted]');
  });
});
