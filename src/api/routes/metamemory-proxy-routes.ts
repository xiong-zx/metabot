import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';
import { resolveMetabotCoreConnection } from '../../memory/core-connection.js';
import { proxyFetch } from '../../utils/http.js';

const PROXY_TIMEOUT_MS = 5_000;

function resolveCoreMemoryPath(parsed: URL): string | undefined {
  const pathname = parsed.pathname;
  if (pathname === '/memory/api/folders') return '/api/memory/folders/tree';
  if (pathname.startsWith('/memory/api/folders/')) {
    return `/api/memory/folders/${pathname.slice('/memory/api/folders/'.length)}`;
  }
  if (pathname === '/memory/api/documents') return '/api/memory/documents';
  if (pathname.startsWith('/memory/api/documents/')) {
    return `/api/memory/documents/${pathname.slice('/memory/api/documents/'.length)}`;
  }
  if (pathname === '/memory/api/search') return '/api/memory/search';
  return undefined;
}

export async function handleMetaMemoryProxyRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!url.startsWith('/memory/api/')) return false;

  if (method !== 'GET') {
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const core = resolveMetabotCoreConnection();
  if (!core.token) {
    jsonResponse(res, 503, {
      error: 'metabot-core token not configured',
      detail: `set METABOT_CORE_TOKEN or write ${core.tokenFile}`,
    });
    return true;
  }

  const parsed = new URL(url, 'http://localhost');
  const corePath = resolveCoreMemoryPath(parsed);
  if (!corePath) {
    jsonResponse(res, 404, { error: 'Not found' });
    return true;
  }

  const target = new URL(corePath, core.baseUrl);
  target.search = parsed.search;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const upstream = await proxyFetch(target, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${core.token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    ctx.logger.warn({ err, target: target.toString(), baseUrl: core.baseUrl }, 'metamemory proxy request failed');
    jsonResponse(res, 502, { error: 'metabot-core memory proxy failed' });
  } finally {
    clearTimeout(timeout);
  }
  return true;
}
