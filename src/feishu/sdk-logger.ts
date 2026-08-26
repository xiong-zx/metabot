import type * as lark from '@larksuiteoapi/node-sdk';

type RestClientOptions = ConstructorParameters<typeof lark.Client>[0];

/**
 * Lark's default REST logger receives raw Axios errors before MetaBot can
 * reduce them to status/code/request-id fields. Keep that internal channel
 * silent; each REST caller owns its structured, credential-safe diagnostics.
 */
export const SILENT_LARK_REST_LOGGER: NonNullable<RestClientOptions['logger']> = Object.freeze({
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
});
