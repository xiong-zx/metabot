import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { RulesPackChildGrantV1 } from '@metabot/rulespack';
import type { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { TrustedPrincipal, WorkerRulesPackMode } from './types.js';
import { WorkerRunnerError, isLocalLifecycleAdmin } from './types.js';
import { LocalCapabilityVerifier, readRulesPackChildGrantFile } from './local-auth.js';
import { createWorkerRunnerMcpServer } from './mcp-server.js';
import type { WorkerService } from './service.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpProtocolServer;
  principal: TrustedPrincipal;
  authorizingCapability: string;
  rulesPackChildGrant?: RulesPackChildGrantV1;
}

export interface WorkerRunnerDaemonOptions {
  endpoint: URL | string;
  capabilityVerifier: LocalCapabilityVerifier;
  maxRequestBytes?: number;
  maxStatusOutputChars?: number;
  rulesPackGrantRoot?: string;
}

/**
 * Long-lived loopback MCP transport. A capability is authenticated before an
 * MCP session exists, and its principal is then bound to that session. Tool
 * arguments remain identity-free.
 */
export class WorkerRunnerDaemon {
  private readonly endpointConfig: URL;
  private readonly maxRequestBytes: number;
  private readonly sessions = new Map<string, Session>();
  private httpServer?: HttpServer;
  private listeningUrl?: URL;

  constructor(
    private readonly service: WorkerService,
    private readonly options: WorkerRunnerDaemonOptions,
  ) {
    this.endpointConfig = validateLoopbackEndpoint(options.endpoint);
    this.maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1 || this.maxRequestBytes > 4_194_304) {
      throw new Error('maxRequestBytes must be an integer between 1 and 4194304');
    }
    if (options.capabilityVerifier.purpose !== 'worker') {
      throw new Error('Worker Runner daemon requires a worker capability verifier');
    }
  }

  get url(): URL {
    if (!this.listeningUrl) throw new Error('Worker Runner daemon is not listening');
    return new URL(this.listeningUrl);
  }

  async start(): Promise<void> {
    if (this.httpServer) throw new Error('Worker Runner daemon is already started');
    await this.service.startAll();
    const server = createServer((request, response) => void this.handle(request, response));
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(Number(this.endpointConfig.port), this.endpointConfig.hostname, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.listeningUrl = new URL(this.endpointConfig);
    this.listeningUrl.port = String(address.port);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async (session) => session.server.close()));
    const server = this.httpServer;
    this.httpServer = undefined;
    this.listeningUrl = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackPeer(request.socket.remoteAddress)) {
        sendJson(response, 403, rpcError('Loopback connections only'));
        return;
      }
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const rulesPackRoute = parseRulesPackOperatorRoute(this.endpointConfig.pathname, requestUrl.pathname);
      if (rulesPackRoute) {
        await this.handleRulesPackOperator(request, response, rulesPackRoute);
        return;
      }
      if (requestUrl.pathname !== this.endpointConfig.pathname) {
        sendJson(response, 404, rpcError('Not found'));
        return;
      }
      const authenticated = this.authenticate(request);
      const principal = authenticated.principal;
      const sessionId = singleHeader(request, 'mcp-session-id');
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          sendJson(response, 404, rpcError('Unknown MCP session'));
          return;
        }
        if (!samePrincipal(session.principal, principal)) {
          sendJson(response, 403, rpcError('Capability principal does not match the MCP session'));
          return;
        }
        if (session.rulesPackChildGrant?.grantId !== authenticated.rulesPackChildGrant?.grantId) {
          sendJson(response, 403, rpcError('RulesPack child grant does not match the MCP session'));
          return;
        }
        const body = request.method === 'POST' ? await readJsonBody(request, this.maxRequestBytes) : undefined;
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 400, rpcError('A session id is required'));
        return;
      }
      const body = await readJsonBody(request, this.maxRequestBytes);
      if (!isInitializeRequest(body)) {
        sendJson(response, 400, rpcError('Only initialize may create a session'));
        return;
      }

      const server = createWorkerRunnerMcpServer(this.service, principal, {
        authorizingCapability: authenticated.capability,
        ...(authenticated.rulesPackChildGrant ? { rulesPackChildGrant: authenticated.rulesPackChildGrant } : {}),
        maxStatusOutputChars: this.options.maxStatusOutputChars,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          this.sessions.set(id, {
            transport,
            server,
            principal,
            authorizingCapability: authenticated.capability,
            ...(authenticated.rulesPackChildGrant ? { rulesPackChildGrant: authenticated.rulesPackChildGrant } : {}),
          });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) this.sessions.delete(id);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (response.headersSent) return;
      const status = error instanceof WorkerRunnerError
        ? error.code === 'FORBIDDEN'
          ? 401
          : error.code === 'CONFLICT'
            ? 409
            : error.code === 'NOT_FOUND'
              ? 404
              : 400
        : 400;
      sendJson(response, status, rpcError(error instanceof Error ? error.message : String(error)));
    }
  }

  private async handleRulesPackOperator(
    request: IncomingMessage,
    response: ServerResponse,
    route: { botName: string; action: 'status' | 'mode' },
  ): Promise<void> {
    const principal = this.authenticate(request).principal;
    if (!isLocalLifecycleAdmin(principal)) {
      sendJson(response, 403, rpcError('Only the fixed local lifecycle admin may control Worker RulesPack'));
      return;
    }
    if (request.method === 'GET' && route.action === 'status') {
      sendJson(response, 200, this.service.rulesPackStatus(route.botName, principal));
      return;
    }
    if (request.method === 'PATCH' && route.action === 'mode') {
      const body = requireRecord(await readJsonBody(request, this.maxRequestBytes));
      if (Object.keys(body).sort().join(',') !== 'expectedVersion,mode,operationId') {
        throw new WorkerRunnerError(
          'Worker RulesPack mode request must contain exactly expectedVersion, mode, and operationId',
          'INVALID_INPUT',
        );
      }
      const mode = body.mode;
      if (mode !== null && mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
        throw new WorkerRunnerError('Worker RulesPack mode must be off, shadow, enforce, or null', 'INVALID_INPUT');
      }
      sendJson(response, 200, this.service.setRulesPackMode(
        route.botName,
        mode as WorkerRulesPackMode | null,
        body.expectedVersion as number,
        body.operationId as string,
        principal,
      ));
      return;
    }
    sendJson(response, 405, rpcError('Unsupported Worker RulesPack operator action'));
  }

  private authenticate(request: IncomingMessage): {
    capability: string;
    principal: TrustedPrincipal;
    rulesPackChildGrant?: RulesPackChildGrantV1;
  } {
    const authorization = singleHeader(request, 'authorization');
    if (!authorization?.startsWith('Bearer ')) throw new WorkerRunnerError('Bearer capability required', 'FORBIDDEN');
    const capability = authorization.slice('Bearer '.length);
    const principal = this.options.capabilityVerifier.verify(capability).principal;
    const grantFile = singleHeader(request, 'x-metabot-rulespack-grant-file');
    if (!grantFile) return { capability, principal };
    const grant = readRulesPackChildGrantFile(grantFile);
    const root = realpathSync.native(this.options.rulesPackGrantRoot ?? path.join(
      process.env.METABOT_HOME ?? process.cwd(),
      'data',
      'mcp-capabilities',
    ));
    const candidate = realpathSync.native(grantFile);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new WorkerRunnerError('RulesPack child grant file escapes its private root', 'FORBIDDEN');
    }
    const rulesPackChildGrant = this.options.capabilityVerifier.verifyRulesPackChildGrant(
      grant,
      capability,
    );
    return { capability, principal, rulesPackChildGrant };
  }
}

function validateLoopbackEndpoint(value: URL | string): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Daemon endpoint must use http on 127.0.0.1 or ::1');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Daemon endpoint must not contain credentials/query/hash');
  if (!url.port) throw new Error('Daemon endpoint must include an explicit port (0 is allowed for tests)');
  if (!url.pathname || url.pathname === '/') throw new Error('Daemon endpoint must include a dedicated path');
  return url;
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function samePrincipal(a: TrustedPrincipal, b: TrustedPrincipal): boolean {
  return a.role === b.role && a.botName === b.botName && a.chatId === b.chatId;
}

function parseRulesPackOperatorRoute(
  endpointPathname: string,
  requestPathname: string,
): { botName: string; action: 'status' | 'mode' } | undefined {
  const base = endpointPathname.replace(/\/+$/u, '');
  const match = new RegExp(`^${escapeRegex(base)}/rulespack/bots/([^/]+)/(status|mode)$`, 'u').exec(requestPathname);
  if (!match) return undefined;
  let botName: string;
  try {
    botName = decodeURIComponent(match[1]);
  } catch {
    throw new WorkerRunnerError('Worker RulesPack bot name is not valid URL encoding', 'INVALID_INPUT');
  }
  return { botName, action: match[2] as 'status' | 'mode' };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new Error(`Multiple ${name} headers are not allowed`);
  return value;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('MCP request body is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    size += chunk.length;
    if (size > maxBytes) throw new Error('MCP request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('MCP request body is not valid JSON');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerRunnerError('Worker RulesPack request body must be an object', 'INVALID_INPUT');
  }
  return value as Record<string, unknown>;
}

function rpcError(message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
