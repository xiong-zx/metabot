import type { BotConfigBase } from '../config.js';

/**
 * Data-driven registry of the MCP servers MetaBot can offer an engine session.
 *
 * Adding a server means adding a descriptor here. It must not mean widening a
 * hard-coded union, editing an existing product package, or routing anything
 * through a shared gateway: every server keeps its own audience, its own
 * signing keys, its own opt-in flag, and its own failure boundary.
 *
 * This registry stays product-schema-free. It knows a server's identity,
 * transport, audience, and environment contract; it never knows a tool name, a
 * scope vocabulary, a database, a profile, or a release layout. Those belong to
 * the product package behind the descriptor.
 */

/**
 * How an engine reaches the server.
 *
 * `loopback-proxy` spawns the product's own stdio proxy, which bridges to a
 * long-lived loopback HTTP daemon using a leased capability file. It exists for
 * servers that own durable state outliving one engine session.
 *
 * `native-stdio` spawns an MCP server directly with no daemon hop. It still
 * receives its own short-lived capability file: transport independence must
 * never be confused with authorization bypass.
 */
export type McpServerTransport = 'loopback-proxy' | 'native-stdio';

/**
 * Signed claim contract a server's verifier enforces.
 *
 * `v2.1-purpose` is the original claim set: exactly `v`, `purpose`, `role`,
 * `botName`, `chatId`, `exp`, with no audience claim.
 *
 * `v3-audience` adds a mandatory signed `aud`. A `v3-audience` server rejects a
 * token without one, so a capability minted before audiences existed, or minted
 * for a different server, cannot be replayed against it.
 *
 * Both are pinned per server rather than globally: a verifier and its issuer
 * must move together, and Worker Runner's shipped verifier is `v2.1-purpose`.
 */
export type CapabilityContract = 'v2.1-purpose' | 'v3-audience';

export interface McpServerDescriptor {
  /**
   * Stable internal id. Also the `purpose` claim and the signing-key namespace,
   * so each server verifies against its own keypair.
   */
  readonly id: string;
  /** Server name every engine sees in its MCP configuration. */
  readonly serverName: string;
  readonly transport: McpServerTransport;
  /** Bot configuration flag that opts a bot into this server. */
  readonly optIn: keyof Pick<BotConfigBase, 'workerTools' | 'arcTools' | 'metaclawTools'>;
  /** Signed audience and claim shape enforced by this product server. */
  readonly audience: string;
  readonly capabilityContract: CapabilityContract;
  /** Whether the future authenticated standalone issuer may mint this audience. */
  readonly standaloneEligible: boolean;
  /** Execution environment token and entry-facing private file variables. */
  readonly capabilityEnvVar: string;
  readonly capabilityFileEnvVar: string;
}

export interface LoopbackProxyDescriptor extends McpServerDescriptor {
  readonly transport: 'loopback-proxy';
  /** Bridge-environment variable carrying the loopback daemon endpoint. */
  readonly endpointEnvVar: string;
  /** Node entry script segments, resolved and confined inside the runtime root. */
  readonly proxyScript: readonly string[];
  readonly proxyUrlEnvVar: string;
}

export interface NativeStdioDescriptor extends McpServerDescriptor {
  readonly transport: 'native-stdio';
  /** Executable, resolved and confined inside the runtime root exactly as a proxy is. */
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly publicKeyEnvVar: string;
  readonly previousPublicKeyEnvVar: string;
}

export type AnyMcpServerDescriptor = LoopbackProxyDescriptor | NativeStdioDescriptor;

export function isLoopbackProxy(descriptor: AnyMcpServerDescriptor): descriptor is LoopbackProxyDescriptor {
  return descriptor.transport === 'loopback-proxy';
}

/**
 * Worker Runner keeps the original claim contract on purpose. Its shipped
 * verifier accepts exactly the v2.1 claim set and rejects any extra claim, so
 * minting an audience for it would break every existing Worker session without
 * making anything safer: its keypair is already separate from ARC's.
 */
const WORKER_RUNNER: LoopbackProxyDescriptor = {
  id: 'worker',
  serverName: 'metabot-worker',
  transport: 'loopback-proxy',
  audience: 'worker',
  capabilityContract: 'v2.1-purpose',
  standaloneEligible: false,
  optIn: 'workerTools',
  capabilityEnvVar: 'METABOT_WORKER_CAPABILITY',
  capabilityFileEnvVar: 'METABOT_WORKER_PROXY_CAPABILITY_FILE',
  endpointEnvVar: 'METABOT_WORKER_DAEMON_URL',
  proxyScript: ['packages', 'worker-runner-mcp', 'dist', 'proxy-cli.js'],
  proxyUrlEnvVar: 'METABOT_WORKER_PROXY_URL',
};

/**
 * ARC requires the audience claim. Its verifier and this issuer moved to
 * `v3-audience` together, so an ARC capability is refused unless it names ARC.
 */
const ARC: LoopbackProxyDescriptor = {
  id: 'arc',
  serverName: 'metabot-arc',
  transport: 'loopback-proxy',
  audience: 'arc',
  capabilityContract: 'v3-audience',
  standaloneEligible: false,
  optIn: 'arcTools',
  capabilityEnvVar: 'METABOT_ARC_CAPABILITY',
  capabilityFileEnvVar: 'METABOT_ARC_PROXY_CAPABILITY_FILE',
  endpointEnvVar: 'METABOT_ARC_DAEMON_URL',
  proxyScript: ['packages', 'arc-mcp', 'dist', 'proxy-cli.js'],
  proxyUrlEnvVar: 'METABOT_ARC_PROXY_URL',
};

const METACLAW: NativeStdioDescriptor = {
  id: 'metaclaw',
  serverName: 'metabot-metaclaw',
  transport: 'native-stdio',
  audience: 'metaclaw',
  capabilityContract: 'v3-audience',
  standaloneEligible: true,
  optIn: 'metaclawTools',
  capabilityEnvVar: 'METABOT_METACLAW_CAPABILITY',
  capabilityFileEnvVar: 'METACLAW_MCP_CAPABILITY_FILE',
  publicKeyEnvVar: 'METACLAW_MCP_CAPABILITY_PUBLIC_KEY_FILE',
  previousPublicKeyEnvVar: 'METACLAW_MCP_CAPABILITY_PREVIOUS_PUBLIC_KEY_FILE',
  binary: 'metabot-metaclaw-mcp',
  args: [],
  env: {},
};

export const EXECUTION_MCP_SERVERS: readonly AnyMcpServerDescriptor[] = Object.freeze([WORKER_RUNNER, ARC, METACLAW]);

/**
 * Startup guard. Two servers sharing an id, name, audience, environment
 * variable, or proxy binary would let one server's credential or configuration
 * reach the other, which is exactly the confusion the audience claim exists to
 * prevent.
 */
export function assertDistinctMcpServers(servers: readonly AnyMcpServerDescriptor[] = EXECUTION_MCP_SERVERS): void {
  const claimed = new Map<string, string>();
  const claim = (kind: string, value: string, owner: string): void => {
    const key = `${kind}:${value}`;
    const existing = claimed.get(key);
    if (existing !== undefined && existing !== owner) {
      throw new Error(`MCP registry reuses ${kind} "${value}" across ${existing} and ${owner}`);
    }
    claimed.set(key, owner);
  };
  for (const server of servers) {
    if (!server.id.trim() || !server.serverName.trim() || !server.audience.trim()) {
      throw new Error('MCP registry entries require a non-empty id, server name, and audience');
    }
    claim('id', server.id, server.id);
    claim('server name', server.serverName, server.id);
    if (!isLoopbackProxy(server)) {
      claim('executable', server.binary, server.id);
      claim('capability variable', server.capabilityEnvVar, server.id);
      claim('capability file variable', server.capabilityFileEnvVar, server.id);
      claim('public key variable', server.publicKeyEnvVar, server.id);
      claim('previous public key variable', server.previousPublicKeyEnvVar, server.id);
      claim('audience', server.audience, server.id);
      continue;
    }
    claim('audience', server.audience, server.id);
    claim('capability variable', server.capabilityEnvVar, server.id);
    claim('endpoint variable', server.endpointEnvVar, server.id);
    claim('executable', server.proxyScript.join('/'), server.id);
    claim('proxy url variable', server.proxyUrlEnvVar, server.id);
    claim('capability file variable', server.capabilityFileEnvVar, server.id);
  }
}

export function loopbackProxyServers(
  servers: readonly AnyMcpServerDescriptor[] = EXECUTION_MCP_SERVERS,
): LoopbackProxyDescriptor[] {
  return servers.filter(isLoopbackProxy);
}

/** Every generated server is capability-scoped, irrespective of transport. */
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
