import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export async function runArcStdioProxy(options: {
  endpoint: URL | string;
  capability: string;
}): Promise<() => Promise<void>> {
  const endpoint = options.endpoint instanceof URL ? options.endpoint : new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('ARC proxy endpoint must use loopback HTTP');
  }
  if (!options.capability.trim()) throw new Error('ARC proxy capability is required');
  const remote = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${options.capability.trim()}` } },
  });
  const stdio = new StdioServerTransport();
  stdio.onmessage = (message) => void remote.send(message).catch((error) => stdio.onerror?.(error as Error));
  stdio.onerror = (error) => remote.onerror?.(error);
  remote.onmessage = (message) => void stdio.send(message).catch((error) => remote.onerror?.(error as Error));
  remote.onerror = (error) => process.stderr.write(`ARC local proxy: ${error.message}\n`);
  await remote.start();
  await stdio.start();
  return async () => {
    await Promise.allSettled([stdio.close(), remote.close()]);
  };
}
