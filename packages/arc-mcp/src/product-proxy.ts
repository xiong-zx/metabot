import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { validateArcServiceUrl } from './product-config.js';

export async function runArcProductProxy(options: {
  endpoint: URL | string;
  bearer: string;
}): Promise<() => Promise<void>> {
  const endpoint = validateArcServiceUrl(String(options.endpoint));
  if (options.bearer.length < 32) throw new Error('ARC MCP bearer is invalid');
  const remote = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${options.bearer}` } },
  });
  const stdio = new StdioServerTransport();
  stdio.onmessage = (message) => void remote.send(message).catch((error) => stdio.onerror?.(error as Error));
  stdio.onerror = (error) => remote.onerror?.(error);
  remote.onmessage = (message) => void stdio.send(message).catch((error) => remote.onerror?.(error as Error));
  remote.onerror = (error) => process.stderr.write(`arc-mcp: ${error.message}\n`);
  await remote.start();
  await stdio.start();
  return async () => {
    await Promise.allSettled([stdio.close(), remote.close()]);
  };
}
