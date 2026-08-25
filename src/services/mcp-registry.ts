import type { BotConfigBase } from '../config.js';

/**
 * Legacy Worker Runner session entry.
 *
 * Independently installed product MCPs do not belong here. They use the
 * product-neutral external descriptor and their own configuration/authentication.
 * This registry remains only for Worker Runner's existing v2.1 Bridge session
 * contract until that product migrates independently.
 */
export interface LoopbackProxyDescriptor {
  readonly id: 'worker';
  readonly serverName: 'metabot-worker';
  readonly transport: 'loopback-proxy';
  readonly optIn: keyof Pick<BotConfigBase, 'workerTools'>;
  readonly capabilityContract: 'v2.1-purpose';
  readonly leaseNamespace: 'worker';
  readonly capabilityEnvVar: 'METABOT_WORKER_CAPABILITY';
  readonly capabilityFileEnvVar: 'METABOT_WORKER_PROXY_CAPABILITY_FILE';
  readonly rulesPackGrantFileEnvVar?: 'METABOT_WORKER_PROXY_RULESPACK_GRANT_FILE';
  readonly endpointEnvVar: 'METABOT_WORKER_DAEMON_URL';
  readonly proxyScript: readonly ['packages', 'worker-runner-mcp', 'dist', 'proxy-cli.js'];
  readonly proxyUrlEnvVar: 'METABOT_WORKER_PROXY_URL';
}

export type AnyMcpServerDescriptor = LoopbackProxyDescriptor;

const WORKER_RUNNER: LoopbackProxyDescriptor = {
  id: 'worker',
  serverName: 'metabot-worker',
  transport: 'loopback-proxy',
  optIn: 'workerTools',
  capabilityContract: 'v2.1-purpose',
  leaseNamespace: 'worker',
  capabilityEnvVar: 'METABOT_WORKER_CAPABILITY',
  capabilityFileEnvVar: 'METABOT_WORKER_PROXY_CAPABILITY_FILE',
  rulesPackGrantFileEnvVar: 'METABOT_WORKER_PROXY_RULESPACK_GRANT_FILE',
  endpointEnvVar: 'METABOT_WORKER_DAEMON_URL',
  proxyScript: ['packages', 'worker-runner-mcp', 'dist', 'proxy-cli.js'],
  proxyUrlEnvVar: 'METABOT_WORKER_PROXY_URL',
};

export const EXECUTION_MCP_SERVERS: readonly AnyMcpServerDescriptor[] = Object.freeze([WORKER_RUNNER]);

export function isLoopbackProxy(descriptor: AnyMcpServerDescriptor): descriptor is LoopbackProxyDescriptor {
  return descriptor.transport === 'loopback-proxy';
}

export function assertDistinctMcpServers(
  servers: readonly AnyMcpServerDescriptor[] = EXECUTION_MCP_SERVERS,
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id) || names.has(server.serverName)) throw new Error('Worker MCP registry contains a duplicate');
    ids.add(server.id);
    names.add(server.serverName);
  }
}

export function loopbackProxyServers(
  servers: readonly AnyMcpServerDescriptor[] = EXECUTION_MCP_SERVERS,
): LoopbackProxyDescriptor[] {
  return [...servers];
}

export function capabilityServers(
  servers: readonly AnyMcpServerDescriptor[] = EXECUTION_MCP_SERVERS,
): AnyMcpServerDescriptor[] {
  return [...servers];
}

export function findMcpServer(
  id: string,
  servers: readonly AnyMcpServerDescriptor[] = EXECUTION_MCP_SERVERS,
): AnyMcpServerDescriptor | undefined {
  return servers.find((server) => server.id === id);
}
