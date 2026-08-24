import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { ArcCoordinator } from './coordinator.js';
import { ArcError } from './errors.js';
import { validateArcServiceUrl } from './product-config.js';
import { createArcMcpServer } from './server.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface ArcProductServiceOptions {
  endpoint: URL | string;
  bearer: string;
  maxRequestBytes?: number;
}

export class ArcProductService {
  private readonly endpoint: URL;
  private readonly maxRequestBytes: number;
  private readonly sessions = new Map<string, Session>();
  private server?: HttpServer;
  private listeningUrl?: URL;

  constructor(
    private readonly coordinator: ArcCoordinator,
    private readonly options: ArcProductServiceOptions,
  ) {
    this.endpoint = validateArcServiceUrl(String(options.endpoint));
    if (options.bearer.length < 32) throw new Error('ARC MCP service bearer is invalid');
    this.maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  }

  get url(): URL {
    if (!this.listeningUrl) throw new Error('ARC MCP service is not listening');
    return new URL(this.listeningUrl);
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('ARC MCP service is already started');
    await this.coordinator.recover();
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(this.endpoint.port), this.endpoint.hostname, resolve);
    });
    const address = server.address() as AddressInfo;
    this.listeningUrl = new URL(this.endpoint);
    this.listeningUrl.port = String(address.port);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.server.close()));
    const server = this.server;
    this.server = undefined;
    this.listeningUrl = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!loopback(request.socket.remoteAddress)) return send(response, 403, 'Loopback only');
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      if (requestUrl.pathname !== this.endpoint.pathname) return send(response, 404, 'Not found');
      this.authenticate(request);
      const sessionId = singleHeader(request, 'mcp-session-id');
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return send(response, 404, 'Unknown MCP session');
        const body = request.method === 'POST' ? await readJson(request, this.maxRequestBytes) : undefined;
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if (request.method !== 'POST') return send(response, 400, 'A session id is required');
      const body = await readJson(request, this.maxRequestBytes);
      if (!isInitializeRequest(body)) return send(response, 400, 'Only initialize may create a session');
      const server = createArcMcpServer(this.coordinator);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id): void => {
          this.sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        send(response, error instanceof ArcError && error.code === 'scope_denied' ? 401 : 400, errorMessage(error));
      }
    }
  }

  private authenticate(request: IncomingMessage): void {
    const authorization = singleHeader(request, 'authorization');
    if (!authorization?.startsWith('Bearer ')) throw new ArcError('scope_denied', 'ARC MCP bearer required');
    const provided = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(this.options.bearer);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ArcError('scope_denied', 'ARC MCP bearer is invalid');
    }
  }
}

function loopback(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new Error(`Multiple ${name} headers are not allowed`);
  return value;
}

async function readJson(request: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > max) throw new Error('ARC MCP request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function send(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
