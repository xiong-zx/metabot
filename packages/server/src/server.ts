import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { CredentialsStore } from './auth/credentials-store.js';
import { authenticate, authenticateWeb, extractBearer, isAuthFailure } from './auth/auth-middleware.js';
import { MemoryStore, ALLOWED_CONTENT_TYPES } from './memory/memory-store.js';
import { SkillStore } from './skills/skill-store.js';
import { AgentStore } from './agents/agent-store.js';
import { T5tStore } from './t5t/t5t-store.js';
import { loadT5tFolderIds } from './t5t/folder-ids.js';
import { AuditLog, createDefaultAuditLog, type AuditOp } from './observability/audit-log.js';
import * as memoryRoutes from './memory/memory-routes.js';
import * as skillRoutes from './skills/skill-routes.js';
import * as agentRoutes from './agents/agent-routes.js';
import * as t5tRoutes from './t5t/t5t-routes.js';
import * as adminRoutes from './admin/admin-routes.js';
import * as webRoutes from './web/web-routes.js';
import { name as pkgName, version as pkgVersion } from './pkg-meta.js';

export interface ServerOptions {
  port: number;
  /**
   * Bind address. Defaults to '127.0.0.1' so the server is only reachable via
   * the Caddy reverse proxy on metabot-core.xvirobotics.com. Set explicitly to
   * '0.0.0.0' for dev/test on remote hosts.
   */
  host?: string;
  dataDir: string;
  instanceName?: string;
  /**
   * If set, GET requests whose Host header matches this value fall through to
   * static file serving from `packages/server/static/` (SPA Web UI). Other
   * Host values continue to behave as a pure API server (404 for non-API
   * paths). Default unset → SPA serving is disabled entirely.
   */
  uiHost?: string;
  /**
   * Comma-separated email whitelist for browser SSO (oauth2-proxy injects
   * `X-Forwarded-Email`). When empty/undefined, web-identity auth is fully
   * disabled and only Bearer auth is accepted. See README "Browser SSO".
   */
  uiAllowedEmails?: string[];
  logger: Logger;
}

export interface ServerHandle {
  server: http.Server;
  db: Database.Database;
  credentialsStore: CredentialsStore;
  memoryStore: MemoryStore;
  skillStore: SkillStore;
  agentStore: AgentStore;
  t5tStore: T5tStore;
  auditLog: AuditLog;
  startedAt: number;
  close(): Promise<void>;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024;

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json);
}

class PayloadTooLargeError extends Error {
  statusCode = 413;
  constructor() {
    super('payload_too_large');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_SIZE) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new PayloadTooLargeError());
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', reject);
  });
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  }
}

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.tgz': 'application/gzip',
};

function hasTraversal(pathname: string): boolean {
  // After URL decode, reject any '..' path segment.
  return pathname.split('/').some((seg) => seg === '..');
}

function serveStaticFile(
  res: http.ServerResponse,
  absPath: string,
  isImmutableAsset: boolean,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(absPath).toLowerCase();
  const mime = STATIC_MIME[ext] || 'application/octet-stream';
  const cacheControl = isImmutableAsset
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(absPath).pipe(res);
  return true;
}

/**
 * Try to serve a static file (or SPA fallback to index.html) from STATIC_DIR.
 * Returns true if a response was sent (including a 404 when index.html is
 * missing and the path didn't resolve). Returns false only if the caller
 * should treat this as "no UI configured / not eligible" and continue with
 * normal API routing.
 */
function tryServeStatic(
  res: http.ServerResponse,
  pathname: string,
): boolean {
  if (hasTraversal(pathname)) {
    jsonResponse(res, 400, { error: 'bad_path' });
    return true;
  }

  // Normalize: strip leading slash; collapse '' to 'index.html'
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absRequested = path.join(STATIC_DIR, rel);
  // Defense-in-depth: ensure resolved path stays within STATIC_DIR.
  const resolved = path.resolve(absRequested);
  if (resolved !== STATIC_DIR && !resolved.startsWith(STATIC_DIR + path.sep)) {
    jsonResponse(res, 400, { error: 'bad_path' });
    return true;
  }

  const isImmutable = pathname.startsWith('/assets/');
  if (serveStaticFile(res, resolved, isImmutable)) return true;

  // SPA fallback → index.html (no-cache).
  const indexPath = path.join(STATIC_DIR, 'index.html');
  if (serveStaticFile(res, indexPath, false)) return true;

  jsonResponse(res, 404, { error: 'ui_not_installed' });
  return true;
}

/**
 * Structural read-only fork for web-identity (browser SSO) credentials.
 * Returns true only for the explicitly enumerated GETs in §11.5 of
 * `docs/internal/web-ui-arch.md`. Anything else is returned as a 404
 * `not_found` (deliberately not 403 — we don't leak route existence to a
 * browser-origin caller).
 */
function isWebReadableRoute(method: string, pathname: string): boolean {
  if (method !== 'GET') return false;
  if (pathname === '/api/memory/folders') return true;
  if (pathname === '/api/memory/folders/tree') return true;
  if (pathname.startsWith('/api/memory/folders/')) return true;
  if (pathname === '/api/memory/documents') return true;
  if (pathname.startsWith('/api/memory/documents/')) return true;
  if (pathname === '/api/memory/search') return true;
  if (pathname === '/api/skills') return true;
  if (pathname === '/api/skills/search') return true;
  if (pathname.startsWith('/api/skills/')) return true;
  if (pathname === '/api/agents') return true;
  if (pathname === '/api/whoami') return true;
  if (pathname === '/api/t5t/board') return true;
  if (pathname.startsWith('/api/t5t/projects/')) return true;
  return false;
}

/**
 * Structural write allowlist for web-identity (browser SSO) credentials.
 * Separate from `isWebReadableRoute` so the GET allowlist stays GET-only
 * and Memory/Skills writes remain Bearer-only. Deny-by-default: this list
 * permits exactly `POST /api/t5t/feedback` and `POST /api/web/issue-token`
 * (self-service onboarding). Anything else falls through to the 404-fork
 * (we don't leak route existence to browser-origin callers).
 */
function isWebWritableRoute(method: string, pathname: string): boolean {
  if (method === 'POST' && pathname === '/api/t5t/feedback') return true;
  if (method === 'POST' && pathname === '/api/web/issue-token') return true;
  // Project kill (soft-kill via append-only doc) — owner-auth enforced at the
  // route layer. Matches the shape `POST /api/t5t/projects/:slug/kill`.
  if (
    method === 'POST'
    && pathname.startsWith('/api/t5t/projects/')
    && pathname.endsWith('/kill')
  ) return true;
  return false;
}

/**
 * Resolve a memory `idOrPath` slice from a URL pathname. UUIDs never contain
 * `/`, so an interior `/` reliably marks a path lookup. oauth2-proxy v7
 * decodes `%2F` → `/` upstream and Caddy collapses `//` → `/`, so the leading
 * `/` of a path-style lookup is stripped by the time we slice it off the URL.
 * Re-add it so `findFolderByPath` / path-based document lookups still hit.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode a URL slice into either a memory UUID or a logical `/`-prefixed path.
 *
 * We loop `decodeURIComponent` until the value stops changing (cap 5
 * iterations) instead of a single decode pass.
 *
 * Why decode-until-stable: the cookie-auth request path traverses
 * Caddy + oauth2-proxy v7, which re-encodes already-percent-encoded bytes
 * (`%XX` → `%25XX`) on every hop because oauth2-proxy reads `URL.Path`
 * instead of `URL.RawPath` before forwarding. CJK segments like
 * `%E6%8A%80%E6%9C%AF%E6%96%87%E6%A1%A3` arrive at this server as
 * `%25E6%258A%2580%25E6%259C%25AF%25E6%2596%2587%25E6%25A1%25A3`, so a
 * single `decodeURIComponent` peels just one of two layers and the resulting
 * string never matches the stored path. The Bearer-bypass route in Caddy
 * (`@bearer`) is unaffected because it routes verbatim through
 * `httputil.ReverseProxy` and skips oauth2-proxy entirely. MR !17 fixed the
 * pchar-literal case (`@`, sub-delims) by sending literal bytes the proxy
 * can't mangle, but CJK has no literal-alternative encoding, so we must
 * normalize on the server.
 *
 * This is lossless: memory paths never contain a literal `%` (slug
 * normalization strips it; emails don't include it; CJK is non-ASCII), and
 * the proxy chain is monotonic (only ever adds `%25`, never removes), so
 * iterating to a fixed point converges to the canonical logical path. Mirrors
 * the client-side `fullyDecodeSegment` shipped in MR !16
 * (`packages/web-ui/src/routes/memory-path.tsx`), applied symmetrically here.
 *
 * Malformed `%`-sequences (e.g. `%ZZ`) make `decodeURIComponent` throw; we
 * trap and return the last valid value so a hand-crafted URL can't 500.
 */
export function decodeMemoryIdOrPath(slice: string): string {
  let current = slice;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed percent-encoding — stick with the last decodable value.
      break;
    }
    if (next === current) break;
    current = next;
  }
  if (current.startsWith('/')) return current;
  // The browser cookie path (oauth2-proxy/Caddy) collapses the `//` boundary
  // between the route prefix and a slash-prefixed path, stripping the path's
  // leading slash. A genuine UUID id has no slash either, so we can't branch
  // on "contains a slash" — a top-level folder like `shared` would be missed.
  // Disambiguate by shape: anything not UUID-shaped is a path missing its `/`.
  if (UUID_RE.test(current)) return current;
  return '/' + current;
}

function deriveOp(method: string, pathname: string): AuditOp | string {
  if (pathname.startsWith('/admin/')) return 'admin';
  if (pathname === '/api/memory/search' || pathname === '/api/skills/search') return 'search';
  if (pathname.endsWith('/publish')) return 'publish';
  if (pathname.endsWith('/install')) return 'install';
  if (pathname === '/api/agents/heartbeat' && method === 'POST') return 'heartbeat';
  if (pathname === '/api/agents/bulk' && method === 'POST') return 'register';
  if (pathname === '/api/agents' && method === 'POST') return 'register';
  if (pathname === '/api/whoami' && method === 'GET') return 'whoami';
  if (pathname.endsWith('/visibility') && method === 'PATCH') return 'visibility';
  // T5T-specific ops (must precede the generic POST/GET fallbacks).
  if (pathname === '/api/t5t/feedback' && method === 'POST') return 'feedback';
  if (pathname === '/api/t5t/cli/feedback' && method === 'POST') return 'feedback';
  if (pathname === '/api/t5t/cli/push' && method === 'POST') return 'push';
  if (pathname === '/api/t5t/cli/goal' && method === 'POST') return 'goal';
  if (pathname === '/api/t5t/cli/evaluator' && method === 'POST') return 'evaluator';
  if (pathname === '/api/t5t/cli/bottleneck' && method === 'POST') return 'bottleneck';
  if (pathname === '/api/t5t/cli/wip' && method === 'POST') return 'wip';
  if (pathname === '/api/t5t/cli/kill' && method === 'POST') return 'kill';
  if (
    method === 'POST'
    && pathname.startsWith('/api/t5t/projects/')
    && pathname.endsWith('/kill')
  ) return 'kill';
  if (pathname === '/api/t5t/board' && method === 'GET') return 'list';
  if (pathname.startsWith('/api/t5t/projects/') && method === 'GET') return 'get';
  if (pathname === '/api/web/issue-token' && method === 'POST') return 'issue';
  if (method === 'POST') return 'create';
  if (method === 'PATCH' || method === 'PUT') return 'update';
  if (method === 'DELETE') return 'delete';
  if (method === 'GET') {
    const isCollection = pathname === '/api/memory/folders'
      || pathname === '/api/memory/documents'
      || pathname === '/api/skills'
      || pathname === '/api/agents';
    return isCollection ? 'list' : 'get';
  }
  return method.toLowerCase();
}

export function startServer(options: ServerOptions): ServerHandle {
  const { port, dataDir, logger } = options;
  const host = options.host || '127.0.0.1';
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'central.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const credentialsStore = new CredentialsStore(db, logger.child({ module: 'credentials' }));
  const memoryStore = new MemoryStore(db, logger.child({ module: 'memory' }));
  const skillStore = new SkillStore(db, logger.child({ module: 'skills' }));
  const agentStore = new AgentStore(db, logger.child({ module: 'agents' }));
  const t5tFolderIds = loadT5tFolderIds(
    process.env,
    memoryStore,
    logger.child({ module: 't5t-folders' }),
  );
  const t5tStore = new T5tStore(memoryStore, t5tFolderIds, logger.child({ module: 't5t' }));
  const auditLog = createDefaultAuditLog(dataDir, logger);

  // Admin bootstrap
  const tokenFile = path.join(dataDir, 'admin-bootstrap-token.txt');
  const bootstrapToken = credentialsStore.bootstrapAdmin(tokenFile);
  if (bootstrapToken) {
    logger.warn({ tokenFile }, 'ADMIN TOKEN BOOTSTRAPPED — SAVE IT NOW; this is the only time it is displayed');
    logger.warn({ token: bootstrapToken }, 'metabot-core admin token (one-time)');
  }

  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';
    const parsed = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const query = parsed.searchParams;

    const auditStart = Date.now();
    let credentialId = 'anonymous';
    let role = 'anonymous';
    let authSource: 'web' | 'bearer' | undefined;
    const audited = pathname.startsWith('/api/') || pathname.startsWith('/admin/');
    if (audited) {
      res.on('finish', () => {
        try {
          auditLog.append({
            ts: new Date().toISOString(),
            op: deriveOp(method, pathname),
            path: pathname,
            credentialId,
            role,
            sourceIp: req.socket.remoteAddress || 'unknown',
            status: res.statusCode,
            latencyMs: Date.now() - auditStart,
            ...(authSource ? { authSource } : {}),
          });
        } catch { /* audit must never break the request */ }
      });
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // Anonymous CLI distribution endpoints. Self-hosted internal install:
    //   curl -fsSL <host>/cli/install.sh | METABOT_CORE_TOKEN=... bash
    // The tarball + script are built by `packages/cli/scripts/pack.sh` into
    // `packages/server/static/cli/` and rsynced to /opt/metabot-core/static/
    // by deploy/install.sh. Reachable on every host (UI + bare API) and
    // intentionally bypass auth — the host already sits behind 飞连 VPN, and
    // the tarball carries no secrets (tokens are user-supplied at install
    // time, not embedded).
    if (
      method === 'GET'
      && (pathname === '/cli/install.sh' || pathname === '/cli/latest.tgz')
    ) {
      const rel = pathname.replace(/^\/+/, '');
      const abs = path.resolve(path.join(STATIC_DIR, rel));
      if (abs !== STATIC_DIR && !abs.startsWith(STATIC_DIR + path.sep)) {
        jsonResponse(res, 400, { error: 'bad_path' });
        return;
      }
      if (!serveStaticFile(res, abs, false)) {
        jsonResponse(res, 404, { error: 'cli_not_installed' });
      }
      return;
    }

    // Host-based dispatch for the Web UI. Only GET on the configured UI host
    // and only for non-API/non-admin paths falls through to static serving.
    // /health and /api/manifest stay accessible on the UI host (handled below).
    const uiHost = options.uiHost;
    const reqHost = (req.headers.host || '').split(':')[0].toLowerCase();
    const isUiHost = !!uiHost && reqHost === uiHost;

    if (
      isUiHost
      && method === 'GET'
      && !pathname.startsWith('/api/')
      && !pathname.startsWith('/admin/')
      && pathname !== '/health'
    ) {
      try {
        if (tryServeStatic(res, pathname)) return;
      } catch (err) {
        logger.error({ err, pathname }, 'static-serve error');
        jsonResponse(res, 500, { error: 'internal' });
        return;
      }
    }

    try {
      // Health (open)
      if (method === 'GET' && pathname === '/health') {
        jsonResponse(res, 200, {
          ok: true,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          version: pkgVersion,
        });
        return;
      }

      // Manifest (open)
      if (method === 'GET' && pathname === '/api/manifest') {
        jsonResponse(res, 200, {
          schemaVersion: 1,
          instance: { name: options.instanceName || pkgName },
          capabilities: {
            memory: true,
            skills: true,
            content_types: [...ALLOWED_CONTENT_TYPES],
          },
        });
        return;
      }

      // Authenticate everything else under /api/* or /admin/*
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/admin/')) {
        jsonResponse(res, 404, { error: 'not_found' });
        return;
      }

      // Auth resolution: Bearer always wins when present. The web-identity
      // chain is only entered when (a) the email-whitelist env is non-empty
      // (default-off), (b) no Bearer header is present, and (c) an
      // `X-Forwarded-Email` header is present (oauth2-proxy strips
      // client-forged X-Forwarded-* at the edge, so on the UI host this
      // header is trustworthy). A forged email + valid Bearer downgrades to
      // the Bearer branch — never to the web branch.
      const allowedEmails = options.uiAllowedEmails || [];
      const hasBearer = extractBearer(req) !== null;
      const webIdentityEnabled = allowedEmails.length > 0;
      const auth = (!hasBearer && webIdentityEnabled && req.headers['x-forwarded-email'])
        ? authenticateWeb(req, allowedEmails)
        : authenticate(req, credentialsStore);
      if (isAuthFailure(auth)) {
        jsonResponse(res, auth.status, { error: auth.error });
        return;
      }
      const cred = auth.credential;
      credentialId = cred.id;
      role = cred.role;
      authSource = cred.authSource === 'web' ? 'web' : 'bearer';

      // Structural fork for web-identity. Reads must be on the GET allowlist;
      // writes must be on the (deny-by-default) write allowlist. Anything
      // outside both returns 404 (not 403) so route existence is never leaked
      // to a browser-origin caller. Defense in depth: even if a write handler
      // were reached, role='member' + empty writableNamespaces would still
      // reject Memory/Skills writes — T5T uses an internal admin cred via
      // T5tStore and gates ownership at the route layer.
      if (
        cred.authSource === 'web'
        && !isWebReadableRoute(method, pathname)
        && !isWebWritableRoute(method, pathname)
      ) {
        jsonResponse(res, 404, { error: 'not_found' });
        return;
      }

      // ---- Admin routes ----
      if (pathname === '/admin/credentials/issue' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, adminRoutes.issueCredential(credentialsStore, body, cred));
      }
      if (pathname === '/admin/credentials/revoke' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, adminRoutes.revokeCredential(credentialsStore, body, cred));
      }
      if (pathname === '/admin/credentials' && method === 'GET') {
        return jsonResult(res, adminRoutes.listCredentials(credentialsStore, cred));
      }
      if (pathname === '/admin/audit' && method === 'GET') {
        return jsonResult(res, adminRoutes.readAudit(auditLog, query, cred));
      }

      // ---- Self-service web token issuance ----
      // Web-identity only (the handler rejects Bearer callers). Identity is
      // server-derived from cred.botName; the request body is never read
      // (anti-squat — body cannot override botName).
      if (pathname === '/api/web/issue-token' && method === 'POST') {
        return jsonResult(res, webRoutes.issueWebToken(credentialsStore, cred));
      }

      // ---- Memory routes ----
      if (pathname === '/api/memory/folders' && method === 'GET') {
        return jsonResult(res, memoryRoutes.listFolders(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/folders/tree' && method === 'GET') {
        return jsonResult(res, memoryRoutes.getFolderTree(memoryStore, cred));
      }
      if (pathname === '/api/memory/folders' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.createFolder(memoryStore, body, cred));
      }
      if (pathname.startsWith('/api/memory/folders/') && method === 'GET') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/folders/'.length));
        return jsonResult(res, memoryRoutes.getFolder(memoryStore, idOrPath, cred));
      }
      if (pathname.startsWith('/api/memory/folders/') && method === 'DELETE') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/folders/'.length));
        return jsonResult(res, memoryRoutes.deleteFolder(memoryStore, idOrPath, cred));
      }

      if (pathname === '/api/memory/search' && method === 'GET') {
        return jsonResult(res, memoryRoutes.search(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/documents' && method === 'GET') {
        return jsonResult(res, memoryRoutes.listDocuments(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/documents' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.createDocument(memoryStore, body, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && method === 'GET') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/documents/'.length));
        return jsonResult(res, memoryRoutes.getDocument(memoryStore, idOrPath, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && (method === 'PATCH' || method === 'PUT')) {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/documents/'.length));
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.updateDocument(memoryStore, idOrPath, body, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && method === 'DELETE') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/documents/'.length));
        return jsonResult(res, memoryRoutes.deleteDocument(memoryStore, idOrPath, cred));
      }

      // ---- Skill routes ----
      if (pathname === '/api/skills' && method === 'GET') {
        return jsonResult(res, skillRoutes.listSkills(skillStore, cred));
      }
      if (pathname === '/api/skills/search' && method === 'GET') {
        return jsonResult(res, skillRoutes.searchSkills(skillStore, query, cred));
      }
      // POST /api/skills/:name/publish — publish skill content for :name
      const publishMatch = pathname.match(/^\/api\/skills\/([^/]+)\/publish$/);
      if (publishMatch && method === 'POST') {
        const name = decodeURIComponent(publishMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, skillRoutes.publishSkill(skillStore, name, body, cred));
      }
      // GET /api/skills/:name/references — unpacked file list (lazy-loaded by skill-hub install)
      const referencesMatch = pathname.match(/^\/api\/skills\/([^/]+)\/references$/);
      if (referencesMatch && method === 'GET') {
        const name = decodeURIComponent(referencesMatch[1]);
        return jsonResult(res, skillRoutes.getSkillReferences(skillStore, name, cred));
      }
      if (pathname.startsWith('/api/skills/') && method === 'GET') {
        const name = decodeURIComponent(pathname.slice('/api/skills/'.length));
        return jsonResult(res, skillRoutes.getSkill(skillStore, name, cred));
      }
      if (pathname.startsWith('/api/skills/') && method === 'DELETE') {
        const name = decodeURIComponent(pathname.slice('/api/skills/'.length));
        return jsonResult(res, skillRoutes.deleteSkill(skillStore, name, cred));
      }

      // ---- Whoami (token introspection / bridge token-verify hop) ----
      if (pathname === '/api/whoami' && method === 'GET') {
        return jsonResult(res, webRoutes.getWhoami(cred, agentStore));
      }

      // ---- Agent-bus routes ----
      if (pathname === '/api/agents' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.registerAgent(agentStore, body, cred));
      }
      if (pathname === '/api/agents/bulk' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.registerAgentsBulk(agentStore, body, cred));
      }
      if (pathname === '/api/agents/heartbeat' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.heartbeat(agentStore, body, cred));
      }
      if (pathname === '/api/agents' && method === 'GET') {
        return jsonResult(res, agentRoutes.listAgents(agentStore, query, cred));
      }
      const visMatch = pathname.match(/^\/api\/agents\/([^/]+)\/visibility$/);
      if (visMatch && method === 'PATCH') {
        const botName = decodeURIComponent(visMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.setAgentVisibility(agentStore, botName, body, cred));
      }
      const memVisMatch = pathname.match(/^\/api\/agents\/([^/]+)\/memory-visibility$/);
      if (memVisMatch && method === 'PATCH') {
        const botName = decodeURIComponent(memVisMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.setAgentMemoryPublic(agentStore, botName, body, cred));
      }
      const vtoMatch = pathname.match(/^\/api\/agents\/([^/]+)\/visible-to-owners$/);
      if (vtoMatch && method === 'PATCH') {
        const botName = decodeURIComponent(vtoMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.setAgentVisibleToOwners(agentStore, botName, body, cred));
      }
      if (pathname.startsWith('/api/agents/') && method === 'DELETE') {
        const botName = decodeURIComponent(pathname.slice('/api/agents/'.length));
        return jsonResult(res, agentRoutes.removeAgent(agentStore, botName, cred));
      }

      // ---- T5T routes ----
      if (pathname === '/api/t5t/board' && method === 'GET') {
        return jsonResult(res, t5tRoutes.getBoard(t5tStore, cred));
      }
      // Specific project subresource — kill must precede the generic
      // `/api/t5t/projects/:slug` GET below.
      const killMatch = pathname.match(/^\/api\/t5t\/projects\/(.+)\/kill$/);
      if (killMatch && method === 'POST') {
        const slug = decodeURIComponent(killMatch[1]);
        return jsonResult(res, t5tRoutes.postKillProject(t5tStore, slug, cred));
      }
      if (pathname.startsWith('/api/t5t/projects/') && method === 'GET') {
        const slug = decodeURIComponent(pathname.slice('/api/t5t/projects/'.length));
        return jsonResult(res, t5tRoutes.getProject(t5tStore, slug, cred));
      }
      if (pathname === '/api/t5t/feedback' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postFeedback(t5tStore, body, cred));
      }

      // ---- T5T CLI routes (Bearer-only) ----
      // Web-identity is already excluded by the structural fork above
      // (these paths are in neither isWebReadableRoute nor
      // isWebWritableRoute, so a synthetic web:<email> cred 404s here).
      if (pathname === '/api/t5t/cli/push' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postCliPush(t5tStore, body, cred));
      }
      if (pathname === '/api/t5t/cli/goal' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postCliGoal(t5tStore, body, cred));
      }
      if (pathname === '/api/t5t/cli/evaluator' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postCliEvaluator(t5tStore, body, cred));
      }
      if (pathname === '/api/t5t/cli/bottleneck' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postCliBottleneck(t5tStore, body, cred));
      }
      if (pathname === '/api/t5t/cli/wip' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postCliWip(t5tStore, body, cred));
      }
      if (pathname === '/api/t5t/cli/kill' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postCliKill(t5tStore, body, cred));
      }
      if (pathname === '/api/t5t/cli/feedback' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, t5tRoutes.postCliFeedback(t5tStore, body, cred));
      }
      if (pathname === '/api/t5t/cli/board' && method === 'GET') {
        return jsonResult(res, t5tRoutes.getCliBoard(t5tStore, cred));
      }
      if (pathname === '/api/t5t/cli/status' && method === 'GET') {
        return jsonResult(res, t5tRoutes.getCliStatus(t5tStore, cred));
      }
      if (pathname === '/api/t5t/cli/whoami' && method === 'GET') {
        return jsonResult(res, t5tRoutes.getCliWhoami(cred));
      }
      const cliWipMatch = pathname.match(/^\/api\/t5t\/cli\/wip\/([^/]+)\/(.+)$/);
      if (cliWipMatch && method === 'GET') {
        const slug = decodeURIComponent(cliWipMatch[1]);
        const wipId = decodeURIComponent(cliWipMatch[2]);
        return jsonResult(res, t5tRoutes.getCliWipItem(t5tStore, slug, wipId, cred));
      }
      if (pathname.startsWith('/api/t5t/cli/project/') && method === 'GET') {
        const slug = decodeURIComponent(pathname.slice('/api/t5t/cli/project/'.length));
        return jsonResult(res, t5tRoutes.getCliProject(t5tStore, slug, cred));
      }

      jsonResponse(res, 404, { error: 'not_found' });
    } catch (err: unknown) {
      const sc = (err as { statusCode?: number }).statusCode;
      if (typeof sc === 'number') {
        jsonResponse(res, sc, { error: (err as Error).message || 'error' });
        return;
      }
      logger.error({ err, method, url: rawUrl }, 'request error');
      jsonResponse(res, 500, { error: 'internal' });
    }
  });

  server.listen(port, host, () => {
    logger.info({ host, port, dbPath }, 'metabot-core server started');
  });

  return {
    server,
    db,
    credentialsStore,
    memoryStore,
    skillStore,
    agentStore,
    t5tStore,
    auditLog,
    startedAt,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      credentialsStore.close();
      db.close();
    },
  };
}

function jsonResult(res: http.ServerResponse, result: { status: number; body: unknown }): void {
  jsonResponse(res, result.status, result.body);
}
