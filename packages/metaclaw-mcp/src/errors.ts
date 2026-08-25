import { ConnectorError } from '@xvirobotics/mcp-connector';

/**
 * MetaClaw MCP error domain.
 *
 * Every failure a caller can see is one of these. The point of a closed domain
 * is that "it did not work" is never the answer: a caller must be able to tell
 * a service that is not running from a credential that was refused, from a
 * release that no longer matches its manifest, from a dependency that has not
 * shipped yet. Those four demand four different human responses.
 */
export type MetaClawErrorCode =
  /** The request never formed a valid call. */
  | 'invalid_request'
  /** The managed profile is missing, unreadable, or fails its pin contract. */
  | 'profile_invalid'
  /** The pinned release no longer matches its manifest. */
  | 'integrity_drift'
  /** A declared upstream dependency has not landed; the tool refuses by design. */
  | 'limitation_gated'
  /** The official service is not reachable. This server never starts it. */
  | 'service_unavailable'
  /** The service refused the bearer. */
  | 'unauthenticated'
  /** The service accepted the bearer and refused the route. */
  | 'forbidden'
  /** The bounded deadline elapsed. Upstream work may still be running. */
  | 'deadline_exceeded'
  /** The service reported a provider-side failure. */
  | 'provider_error'
  /** The service answered, but not in the shape the pinned contract requires. */
  | 'contract_violation'
  /** A requested skill does not exist under the managed skills root. */
  | 'skill_not_found'
  /** A skill exists but fails a containment or integrity check. */
  | 'skill_unsafe'
  /** An unexpected internal fault, reported rather than swallowed. */
  | 'internal';

export interface MetaClawErrorDetail {
  readonly code: MetaClawErrorCode;
  readonly message: string;
  /** Machine-readable specifics; never contains a secret or prompt text. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** True when the caller can retry unchanged and might succeed. */
  readonly retryable: boolean;
}

const RETRYABLE: ReadonlySet<MetaClawErrorCode> = new Set<MetaClawErrorCode>([
  'service_unavailable',
  'deadline_exceeded',
  'provider_error',
]);

export class MetaClawError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    readonly code: MetaClawErrorCode,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'MetaClawError';
    if (details !== undefined) this.details = details;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  toJSON(): MetaClawErrorDetail {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      retryable: this.retryable,
    };
  }
}

/**
 * Translate a connector transport outcome into this domain.
 *
 * The mapping is deliberately narrow. A timeout is not a service outage: the
 * work behind it may still be running and may still cost money, and reporting
 * it as "unavailable" would invite a retry that doubles the spend.
 */
export function fromConnectorError(error: ConnectorError): MetaClawError {
  switch (error.code) {
    case 'TRANSPORT_TIMEOUT':
      return new MetaClawError(error.message, 'deadline_exceeded', {
        upstreamCancellation: 'unsupported',
      });
    case 'ENDPOINT_MISSING':
    case 'ENDPOINT_UNSAFE':
    case 'TRANSPORT_FAILED':
      return new MetaClawError(error.message, 'service_unavailable', { transport: error.code });
    case 'CREDENTIAL_MISSING':
    case 'CREDENTIAL_UNSAFE':
    case 'CREDENTIAL_EMPTY':
    case 'CREDENTIAL_TOO_LARGE':
      return new MetaClawError(error.message, 'profile_invalid', { credential: error.code });
    case 'REQUEST_TOO_LARGE':
      return new MetaClawError(error.message, 'invalid_request', { bound: error.code });
    case 'RESPONSE_TOO_LARGE':
    case 'RESPONSE_INVALID':
      return new MetaClawError(error.message, 'contract_violation', { response: error.code });
    default:
      return new MetaClawError(error.message, 'internal');
  }
}

/** Coerce anything thrown into the closed domain without leaking a stack. */
export function asMetaClawError(error: unknown, redact: (value: unknown) => string): MetaClawError {
  if (error instanceof MetaClawError) return error;
  if (error instanceof ConnectorError) return fromConnectorError(error);
  return new MetaClawError(redact(error), 'internal');
}
