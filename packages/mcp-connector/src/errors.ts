/**
 * Connector error domain.
 *
 * These codes describe transport and credential-handling outcomes only. A
 * product's own error vocabulary (scopes, run states, tool contracts) stays in
 * the product package: this module must never learn what is behind an endpoint.
 */
export type ConnectorErrorCode =
  | 'ENDPOINT_MISSING'
  | 'ENDPOINT_UNSAFE'
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_UNSAFE'
  | 'CREDENTIAL_TOO_LARGE'
  | 'CREDENTIAL_EMPTY'
  | 'AUDIENCE_MISSING'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'RESPONSE_INVALID'
  | 'TRANSPORT_TIMEOUT'
  | 'TRANSPORT_FAILED';

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly code: ConnectorErrorCode,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }

  toJSON(): { code: ConnectorErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isConnectorError(value: unknown): value is ConnectorError {
  return value instanceof ConnectorError;
}
