import {
  ConnectorError,
  parseJsonResponse,
  requestBounded,
  type BoundedResponse,
  type Redactor,
} from '@xvirobotics/mcp-connector';

import { asMetaClawError, MetaClawError } from './errors.js';
import type { EndpointIdentityPin } from './profile.js';

/**
 * The official MetaClaw HTTP surface this server is allowed to use.
 *
 * Two routes, both bounded, both read-or-infer. There is deliberately no
 * lifecycle, config, auth, memory, training, or record route on this interface:
 * an operation that cannot be named here cannot be called at all, which is a
 * stronger guarantee than a policy check inside a wider client.
 */
export interface MetaClawServiceClient {
  probeHealth(request: ProbeRequest): Promise<ServiceProbe>;
  createCompletion(request: CompletionRequest): Promise<CompletionResponse>;
}

export interface ProbeRequest {
  readonly deadlineMs: number;
  /**
   * Whether the service bearer may be presented on this probe. False while the
   * gate covering it is open; see `SERVICE_BEARER_SURFACE`.
   */
  readonly withBearer: boolean;
  readonly identity: EndpointIdentityPin;
}

export type EndpointIdentityState = 'matched' | 'mismatch' | 'absent' | 'unverified';

export interface EndpointIdentity {
  readonly state: EndpointIdentityState;
  /** The field this build was told to read, or null when nothing is pinned. */
  readonly pinnedField: string | null;
  readonly reason: string;
  /**
   * The value observed in the named field, present only on a mismatch from an
   * authenticated probe. Bounded and redacted; never presented as identity.
   */
  readonly observed?: string;
}

export interface ServiceProbe {
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  readonly elapsedMs: number | null;
  readonly bearerPresented: boolean;
  /**
   * What the pinned identity check concluded. There is deliberately no
   * free-form echo of the probe body: an unpinned response from a local port is
   * whatever the process behind it chose to send, and reporting that as release
   * identity would let anything that binds the port declare what it is.
   */
  readonly identity: EndpointIdentity;
  readonly error: ReturnType<MetaClawError['toJSON']> | null;
}

/** A pinned value is compared whole; a longer observed value is truncated. */
const MAX_OBSERVED_IDENTITY_LENGTH = 120;

export interface CompletionRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly deadlineMs: number;
}

export interface CompletionResponse {
  readonly httpStatus: number;
  readonly elapsedMs: number;
  readonly json: Readonly<Record<string, unknown>>;
}

export interface HttpServiceClientOptions {
  readonly endpoint: URL;
  /** Read from a 0600 file; never placed in argv, env, logs, or status. */
  readonly bearer: string;
  readonly redact: Redactor;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export const HEALTH_PATH = '/health';
export const COMPLETION_PATH = '/v1/chat/completions';
const COMPLETION_HEADER_ALLOWLIST = new Set(['content-type', 'x-session-id', 'x-turn-type']);
const COMPLETION_BODY_ALLOWLIST = new Set(['model', 'messages', 'stream', 'max_tokens', 'temperature']);

export function createHttpServiceClient(options: HttpServiceClientOptions): MetaClawServiceClient {
  const transport = {
    endpoint: options.endpoint,
    redact: options.redact,
    maxRequestBytes: options.maxRequestBytes,
    maxResponseBytes: options.maxResponseBytes,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
  };

  return {
    async probeHealth(request: ProbeRequest): Promise<ServiceProbe> {
      try {
        const response = await requestBounded(
          {
            method: 'GET',
            path: HEALTH_PATH,
            // The bearer is attached only when it is allowed to be. An
            // unauthenticated probe still answers the question a health check
            // exists to answer, and a credential sent to a port whose occupant
            // is unverified does not come back.
            headers: request.withBearer ? authHeaders(options.bearer) : { accept: 'application/json' },
          },
          { ...transport, deadlineMs: request.deadlineMs },
        );
        assertAuthorized(response);
        return {
          reachable: response.status >= 200 && response.status < 300,
          httpStatus: response.status,
          elapsedMs: response.elapsedMs,
          bearerPresented: request.withBearer,
          identity: checkIdentity(response, request, options.redact),
          error: null,
        };
      } catch (error) {
        const failure = asMetaClawError(error, options.redact);
        return {
          reachable: false,
          httpStatus: null,
          elapsedMs: null,
          bearerPresented: request.withBearer,
          identity: {
            state: 'unverified',
            pinnedField: request.identity.source === 'health_body' ? request.identity.field : null,
            reason: 'The service did not answer, so nothing about its identity was observed.',
          },
          error: failure.toJSON(),
        };
      }
    },

    async createCompletion(request: CompletionRequest): Promise<CompletionResponse> {
      assertAllowlistedCompletion(request);
      let response: BoundedResponse;
      try {
        response = await requestBounded(
          {
            method: 'POST',
            path: COMPLETION_PATH,
            headers: { ...request.headers, ...authHeaders(options.bearer) },
            body: JSON.stringify(request.body),
          },
          { ...transport, deadlineMs: request.deadlineMs },
        );
      } catch (error) {
        if (error instanceof ConnectorError) throw asMetaClawError(error, options.redact);
        throw asMetaClawError(error, options.redact);
      }
      assertAuthorized(response);
      if (response.status >= 500) {
        throw new MetaClawError('MetaClaw service reported an upstream failure', 'provider_error', {
          httpStatus: response.status,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new MetaClawError('MetaClaw service refused the request', 'contract_violation', {
          httpStatus: response.status,
        });
      }
      let parsed: unknown;
      try {
        parsed = parseJsonResponse<unknown>(response, options.redact);
      } catch (error) {
        throw asMetaClawError(error, options.redact);
      }
      if (!isPlainObject(parsed)) {
        throw new MetaClawError('MetaClaw completion response was not a JSON object', 'contract_violation');
      }
      return { httpStatus: response.status, elapsedMs: response.elapsedMs, json: parsed };
    },
  };
}

function assertAllowlistedCompletion(request: CompletionRequest): void {
  const headerNames = Object.keys(request.headers).map((name) => name.toLowerCase());
  const unexpectedHeaders = headerNames.filter((name) => !COMPLETION_HEADER_ALLOWLIST.has(name));
  const bodyNames = Object.keys(request.body);
  const unexpectedBody = bodyNames.filter((name) => !COMPLETION_BODY_ALLOWLIST.has(name));
  if (unexpectedHeaders.length > 0 || unexpectedBody.length > 0) {
    throw new MetaClawError('Completion request contained a field outside the outbound allowlist', 'invalid_request', {
      unexpectedHeaders: unexpectedHeaders.sort(),
      unexpectedBody: unexpectedBody.sort(),
    });
  }
  if (
    request.headers['content-type'] !== 'application/json'
    || request.headers['x-turn-type'] !== 'side'
    || !/^metaclaw-side-[0-9a-f-]{36}$/.test(request.headers['x-session-id'] ?? '')
    || request.body.stream !== false
    || typeof request.body.model !== 'string'
    || !Array.isArray(request.body.messages)
    || !Number.isSafeInteger(request.body.max_tokens)
  ) {
    throw new MetaClawError('Completion request did not match the pinned outbound contract', 'invalid_request');
  }
}

/**
 * Compare one named field against one expected value, and nothing else.
 *
 * A mismatch is reported as a mismatch rather than raised, because "something
 * else is on that port" is exactly the answer an operator ran health to get.
 * The observed value comes back only from an authenticated probe: echoing a
 * string chosen by an unauthenticated stranger is how a probe result becomes an
 * injection vector into whatever renders it.
 */
function checkIdentity(
  response: BoundedResponse,
  request: ProbeRequest,
  redact: Redactor,
): EndpointIdentity {
  if (request.identity.source === 'unpinned') {
    return {
      state: 'unverified',
      pinnedField: null,
      reason: request.identity.reason,
    };
  }
  const { field, expect } = request.identity;
  let parsed: unknown;
  try {
    parsed = parseJsonResponse<unknown>(response, redact);
  } catch {
    return { state: 'absent', pinnedField: field, reason: 'The probe response was not JSON.' };
  }
  if (!isPlainObject(parsed) || !Object.prototype.hasOwnProperty.call(parsed, field)) {
    return { state: 'absent', pinnedField: field, reason: `The probe response carried no ${field}.` };
  }
  const value = parsed[field];
  if (typeof value !== 'string') {
    return { state: 'absent', pinnedField: field, reason: `The probe response ${field} was not a string.` };
  }
  if (value === expect) {
    return { state: 'matched', pinnedField: field, reason: `The probe reported the pinned ${field}.` };
  }
  return {
    state: 'mismatch',
    pinnedField: field,
    reason: `The probe reported a ${field} other than the pinned one.`,
    ...(request.withBearer
      ? { observed: redact(value).slice(0, MAX_OBSERVED_IDENTITY_LENGTH) }
      : {}),
  };
}

function authHeaders(bearer: string): Record<string, string> {
  return { authorization: `Bearer ${bearer}`, accept: 'application/json' };
}

function assertAuthorized(response: BoundedResponse): void {
  if (response.status === 401) {
    throw new MetaClawError('MetaClaw service refused the configured bearer', 'unauthenticated', {
      httpStatus: 401,
    });
  }
  if (response.status === 403) {
    throw new MetaClawError('MetaClaw service refused this route for the configured bearer', 'forbidden', {
      httpStatus: 403,
    });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
