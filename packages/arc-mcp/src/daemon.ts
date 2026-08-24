import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { ArcCoordinator } from './coordinator.js';
import { ArcError } from './errors.js';
import { ArcCapabilityVerifier } from './local-auth.js';
import type { ArcTerminalNotifierService } from './notifier.js';
import { createArcMcpServer, type ArcTrustedPrincipal } from './server.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  principal: ArcTrustedPrincipal;
  authorizingCapability: string;
}

export interface ArcDaemonOptions {
  endpoint: URL | string;
  capabilityVerifier: ArcCapabilityVerifier;
  notifications?: ArcTerminalNotifierService;
  maxRequestBytes?: number;
}

export class ArcDaemon {
  private readonly endpointConfig: URL;
  private readonly maxRequestBytes: number;
  private readonly sessions = new Map<string, Session>();
  private httpServer?: HttpServer;
  private listeningUrl?: URL;

  constructor(
    private readonly coordinator: ArcCoordinator,
    private readonly options: ArcDaemonOptions,
  ) {
    this.endpointConfig = validateEndpoint(options.endpoint);
    this.maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1 || this.maxRequestBytes > 4_194_304) {
      throw new Error('maxRequestBytes must be an integer between 1 and 4194304');
    }
  }

  get url(): URL {
    if (!this.listeningUrl) throw new Error('ARC daemon is not listening');
    return new URL(this.listeningUrl);
  }

  async start(): Promise<void> {
    if (this.httpServer) throw new Error('ARC daemon is already started');
    await this.coordinator.recover();
    this.options.notifications?.start();
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
    this.options.notifications?.dispose();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.server.close()));
    const server = this.httpServer;
    this.httpServer = undefined;
    this.listeningUrl = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(request.socket.remoteAddress)) return sendJson(response, 403, rpcError('Loopback only'));
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      if (requestUrl.pathname !== this.endpointConfig.pathname) return sendJson(response, 404, rpcError('Not found'));
      const authenticated = this.authenticate(request);
      const principal = authenticated.principal;
      const sessionId = singleHeader(request, 'mcp-session-id');
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return sendJson(response, 404, rpcError('Unknown MCP session'));
        if (!samePrincipal(session.principal, principal)) {
          return sendJson(response, 403, rpcError('Capability principal does not match the MCP session'));
        }
        const body = request.method === 'POST' ? await readJson(request, this.maxRequestBytes) : undefined;
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if (request.method !== 'POST') return sendJson(response, 400, rpcError('A session id is required'));
      const body = await readJson(request, this.maxRequestBytes);
      if (!isInitializeRequest(body)) return sendJson(response, 400, rpcError('Only initialize may create a session'));

      const server = createArcMcpServer(this.coordinator, {
        principal,
        authorizingCapability: authenticated.capability,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          this.sessions.set(id, {
            transport,
            server,
            principal,
            authorizingCapability: authenticated.capability,
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
      sendJson(
        response,
        error instanceof ArcError && error.code === 'scope_denied' ? 401 : 400,
        rpcError(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private authenticate(request: IncomingMessage): { capability: string; principal: ArcTrustedPrincipal } {
    const authorization = singleHeader(request, 'authorization');
    if (!authorization?.startsWith('Bearer ')) throw new ArcError('scope_denied', 'Bearer capability required');
    const capability = authorization.slice('Bearer '.length);
    return { capability, principal: this.options.capabilityVerifier.verify(capability).principal };
  }
}

function validateEndpoint(value: URL | string): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('ARC daemon endpoint must use loopback HTTP');
  }
  if (!url.port || !url.pathname || url.pathname === '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('ARC daemon endpoint must include a port and dedicated path only');
  }
  return url;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function samePrincipal(a: ArcTrustedPrincipal, b: ArcTrustedPrincipal): boolean {
  return a.role === b.role && a.botName === b.botName && a.chatId === b.chatId;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new Error(`Multiple ${name} headers are not allowed`);
  return value;
}

async function readJson(request: IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > max) throw new Error('ARC MCP request is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    size += chunk.length;
    if (size > max) throw new Error('ARC MCP request is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('ARC MCP request is not valid JSON');
  }
}

function rpcError(message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
