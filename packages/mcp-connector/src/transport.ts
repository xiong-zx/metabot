import { ConnectorError } from './errors.js';
import { resolveEndpointPath } from './endpoint.js';
import type { Redactor } from './redact.js';

export interface BoundedRequest {
  method: 'GET' | 'POST';
  /** Path relative to the validated endpoint; may not escape its origin. */
  path: string;
  headers?: Readonly<Record<string, string>>;
  /** Already-serialized body. The connector does not know the product schema. */
  body?: string;
}

export interface BoundedResponse {
  status: number;
  /** Allowlisted response headers only; see `DEFAULT_RESPONSE_HEADER_ALLOWLIST`. */
  headers: Readonly<Record<string, string>>;
  text: string;
  /** Wall-clock milliseconds spent on the request, for provenance. */
  elapsedMs: number;
}

export interface BoundedTransportLimits {
  /** Whole-request deadline. There is no streaming and no partial delivery. */
  deadlineMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

export interface BoundedTransportOptions extends BoundedTransportLimits {
  endpoint: URL;
  redact: Redactor;
  /**
   * Response headers this connector is willing to carry back. Everything else
   * is dropped before the caller sees it.
   */
  responseHeaderAllowlist?: readonly string[];
  /** Injected for tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Headers a caller has a reason to read, and nothing else.
 *
 * The response comes from a process this connector does not own, and every
 * header it sets would otherwise flow into a status payload, an error message,
 * or a log. `set-cookie`, `authorization`, `www-authenticate`, and a service's
 * own bespoke debug headers are all things a caller should never receive
 * through here, and enumerating what to drop is the version of this that goes
 * stale the first time upstream adds a header nobody knew about.
 */
export const DEFAULT_RESPONSE_HEADER_ALLOWLIST: readonly string[] = Object.freeze([
  'content-type',
  'content-length',
  'retry-after',
]);

/**
 * A single bounded, non-streaming request/response exchange.
 *
 * Non-streaming is a deliberate contract, not a simplification: a connector
 * that streams cannot state when a call ended, and a caller that disconnects
 * mid-stream cannot be told whether the work behind it stopped. Every call here
 * either completes inside the deadline or fails with a structured timeout.
 */
export async function requestBounded(
  request: BoundedRequest,
  options: BoundedTransportOptions,
): Promise<BoundedResponse> {
  const now = options.now ?? (() => Date.now());
  assertPositiveInteger(options.deadlineMs, 'deadlineMs');
  assertPositiveInteger(options.maxRequestBytes, 'maxRequestBytes');
  assertPositiveInteger(options.maxResponseBytes, 'maxResponseBytes');

  const url = resolveEndpointPath(options.endpoint, request.path);
  const body = request.body;
  if (body !== undefined) {
    const size = Buffer.byteLength(body, 'utf8');
    if (size > options.maxRequestBytes) {
      throw new ConnectorError(
        `Request body of ${size} bytes exceeds the ${options.maxRequestBytes} byte bound`,
        'REQUEST_TOO_LARGE',
      );
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const deadline = new Deadline(options.deadlineMs, controller);
  const startedAt = now();
  try {
    let response: Response;
    try {
      // Raced rather than merely signalled. `AbortSignal` is a request to stop,
      // and a transport that ignores it would otherwise hold this call open
      // past its stated deadline with nothing left to interrupt it.
      response = await deadline.race(
        fetchImpl(url, {
          method: request.method,
          headers: { ...(request.headers ?? {}) },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: 'error',
        }),
      );
    } catch (cause) {
      if (cause instanceof ConnectorError) throw cause;
      if (controller.signal.aborted) throw deadline.error();
      throw new ConnectorError(`Transport failure: ${options.redact(cause)}`, 'TRANSPORT_FAILED');
    }

    const text = await deadline.race(readBounded(response, options.maxResponseBytes, options.redact));
    return {
      status: response.status,
      headers: collectHeaders(response, options.responseHeaderAllowlist ?? DEFAULT_RESPONSE_HEADER_ALLOWLIST, options.redact),
      text,
      elapsedMs: Math.max(0, now() - startedAt),
    };
  } finally {
    deadline.dispose();
  }
}

/** One deadline covering the whole exchange, request and body read alike. */
class Deadline {
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly expiry: Promise<never>;

  constructor(
    private readonly deadlineMs: number,
    controller: AbortController,
  ) {
    let reject!: (reason: unknown) => void;
    this.expiry = new Promise<never>((_resolve, rejectFn) => {
      reject = rejectFn;
    });
    // Nothing else observes this promise once the race is settled; marking it
    // handled keeps a late expiry from surfacing as an unhandled rejection.
    this.expiry.catch(() => undefined);
    this.timer = setTimeout(() => {
      controller.abort();
      reject(this.error());
    }, deadlineMs);
  }

  race<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.expiry]);
  }

  error(): ConnectorError {
    return new ConnectorError(`Request exceeded the ${this.deadlineMs}ms deadline`, 'TRANSPORT_TIMEOUT');
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

async function readBounded(response: Response, maxBytes: number, redact: Redactor): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new ConnectorError(
        `Response of ${length} bytes exceeds the ${maxBytes} byte bound`,
        'RESPONSE_TOO_LARGE',
      );
    }
  }
  // Content-Length is advisory, so the body is also counted as it arrives.
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ConnectorError(`Response exceeds the ${maxBytes} byte bound`, 'RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof ConnectorError) throw cause;
    throw new ConnectorError(`Unable to read response: ${redact(cause)}`, 'TRANSPORT_FAILED');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export function parseJsonResponse<T = unknown>(response: BoundedResponse, redact: Redactor): T {
  try {
    return JSON.parse(response.text) as T;
  } catch (cause) {
    throw new ConnectorError(`Response is not valid JSON: ${redact(cause)}`, 'RESPONSE_INVALID');
  }
}

function collectHeaders(
  response: Response,
  allowlist: readonly string[],
  redact: Redactor,
): Record<string, string> {
  const permitted = new Set(allowlist.map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    // Redacted as well as allowlisted: an allowlisted header can still echo a
    // credential the caller sent, and a header is exactly the kind of value
    // that gets logged without being read.
    if (permitted.has(name)) headers[name] = redact(value);
  });
  return headers;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConnectorError(`${name} must be a positive integer`, 'TRANSPORT_FAILED');
  }
}
