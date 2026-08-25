import { ConnectorError } from './errors.js';

/**
 * A spawned connector may only reach a loopback HTTP endpoint on this host.
 *
 * The point is not that loopback is inherently trustworthy; it is that a
 * connector holding a credential must not be steerable to an arbitrary origin
 * by whatever populated its environment. Embedded credentials in the URL are
 * refused for the same reason: a secret belongs in a protected file, never in
 * a string that ends up in argv, logs, or an error message.
 */
export function parseLoopbackHttpEndpoint(value: string | undefined, label = 'endpoint'): URL {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConnectorError(`Missing ${label}`, 'ENDPOINT_MISSING');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ConnectorError(`Unparseable ${label}`, 'ENDPOINT_UNSAFE');
  }
  if (endpoint.protocol !== 'http:') {
    throw new ConnectorError(`Unsafe ${label} scheme; expected http:`, 'ENDPOINT_UNSAFE');
  }
  if (!LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new ConnectorError(`Unsafe ${label} host; expected loopback`, 'ENDPOINT_UNSAFE');
  }
  if (endpoint.username || endpoint.password) {
    throw new ConnectorError(`Unsafe ${label}; credentials must not be embedded`, 'ENDPOINT_UNSAFE');
  }
  if (endpoint.search || endpoint.hash) {
    throw new ConnectorError(`Unsafe ${label}; query and fragment are not accepted`, 'ENDPOINT_UNSAFE');
  }
  return endpoint;
}

export function isLoopbackHttpEndpoint(value: string | undefined): boolean {
  try {
    parseLoopbackHttpEndpoint(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Join a request path onto a validated base without letting the path escape it.
 * `..` segments and absolute origins are rejected rather than normalized away.
 */
export function resolveEndpointPath(base: URL, requestPath: string): URL {
  if (!requestPath.startsWith('/')) {
    throw new ConnectorError('Request path must start with "/"', 'ENDPOINT_UNSAFE');
  }
  // A leading "//" is protocol-relative. Against a base whose pathname is "/"
  // it silently retargets the whole request at another origin, so it is refused
  // by shape rather than left to the origin comparison below.
  if (requestPath.startsWith('//')) {
    throw new ConnectorError('Request path must not be protocol-relative', 'ENDPOINT_UNSAFE');
  }
  if (requestPath.includes('..') || requestPath.includes('\\')) {
    throw new ConnectorError('Request path must not contain traversal segments', 'ENDPOINT_UNSAFE');
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  const resolved = new URL(`${basePath}${requestPath}`, base);
  if (resolved.origin !== base.origin) {
    throw new ConnectorError('Request path must not change the endpoint origin', 'ENDPOINT_UNSAFE');
  }
  return resolved;
}

/**
 * Literal loopback addresses only. `localhost` is a name, and a name resolves
 * through `/etc/hosts` and DNS, so accepting it would reintroduce exactly the
 * rebinding case this check exists to close.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
