import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { WorkerMcpWireClient } from './wire.js';

export interface ConnectedWorkerClient {
  wire: WorkerMcpWireClient;
  close(): Promise<void>;
}

export async function connectWorkerMcp(options: {
  endpoint: URL | string;
  capability: string;
}): Promise<ConnectedWorkerClient> {
  const endpoint = options.endpoint instanceof URL ? options.endpoint : new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('ARC Worker endpoint must use loopback HTTP');
  }
  if (!options.capability.trim()) throw new Error('ARC Worker service capability is required');
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${options.capability.trim()}` } },
  });
  const client = new Client({ name: 'metabot-arc-worker-runner-adapter', version: '0.1.0' });
  await client.connect(transport);
  return {
    wire: new WorkerMcpWireClient(client),
    close: () => client.close(),
  };
}
