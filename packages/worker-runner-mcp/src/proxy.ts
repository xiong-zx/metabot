import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface LocalMcpProxyOptions {
  endpoint: URL | string;
  capability: string;
  rulesPackGrantFile?: string;
}

/** Transparent JSON-RPC relay: the proxy adds authority only as an HTTP header. */
export async function runLocalMcpStdioProxy(options: LocalMcpProxyOptions): Promise<() => Promise<void>> {
  const endpoint = options.endpoint instanceof URL ? options.endpoint : new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Proxy endpoint must be loopback HTTP');
  }
  if (!options.capability.trim()) throw new Error('Proxy capability is required');
  const remote = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: {
      authorization: `Bearer ${options.capability.trim()}`,
      ...(options.rulesPackGrantFile
        ? { 'x-metabot-rulespack-grant-file': options.rulesPackGrantFile }
        : {}),
    } },
  });
  const stdio = new StdioServerTransport();
  stdio.onmessage = (message) => void remote.send(message).catch((error) => stdio.onerror?.(error as Error));
  stdio.onerror = (error) => remote.onerror?.(error);
  remote.onmessage = (message) => void stdio.send(message).catch((error) => remote.onerror?.(error as Error));
  remote.onerror = (error) => process.stderr.write(`local MCP proxy: ${error.message}\n`);
  await remote.start();
  await stdio.start();
  return async () => {
    await Promise.allSettled([stdio.close(), remote.close()]);
  };
}
