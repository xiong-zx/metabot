import path from 'node:path';
import {
  EXECUTION_MCP_SERVERS,
  isLoopbackProxy,
  type AnyMcpServerDescriptor,
} from '../services/mcp-registry.js';

export interface McpEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Codex-only policy for these generated, capability-scoped local tools. */
  codexToolsApprovalMode: 'approve';
}

export interface McpEntryInput {
  executionEnv: Record<string, string> | undefined;
  bridgeEnv: NodeJS.ProcessEnv;
  runtimeRoot: string;
  /** Capability file leased for each server, keyed by registry id. */
  capabilityFiles: Readonly<Record<string, string | undefined>>;
  /** Defaults to the full registry; overridden by fixtures. */
  servers?: readonly AnyMcpServerDescriptor[];
}

export interface StdioMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Pure authority/config builder. It performs no IO and imports no downstream
 * package: Bridge-to-daemon contact stays on the package-owned proxy wire.
 *
 * Every server is built from its registry descriptor, so registering a new one
 * never means editing this function, and one server's missing endpoint or
 * capability drops only that server's entry.
 */
export function buildExecutionMcpEntries(input: McpEntryInput): McpEntry[] {
  const executionEnv = input.executionEnv;
  if (!executionEnv || isTeamChat(executionEnv.METABOT_CHAT_ID) || !path.isAbsolute(input.runtimeRoot)) {
    return [];
  }

  const entries: McpEntry[] = [];
  for (const server of input.servers ?? EXECUTION_MCP_SERVERS) {
    const capabilityFile = input.capabilityFiles[server.id];
    if (!hasValue(executionEnv[server.capabilityEnvVar]) || !isAbsoluteFilePath(capabilityFile)) {
      continue;
    }
    if (!isLoopbackProxy(server)) {
      entries.push({
        name: server.serverName,
        command: path.join(input.runtimeRoot, 'node_modules', '.bin', server.binary),
        args: [...server.args],
        env: { ...server.env, [server.capabilityFileEnvVar]: capabilityFile },
        codexToolsApprovalMode: 'approve',
      });
      continue;
    }
    const endpoint = loopbackHttpEndpoint(input.bridgeEnv[server.endpointEnvVar]);
    if (!endpoint) continue;
    entries.push({
      name: server.serverName,
      command: process.execPath,
      args: [path.join(input.runtimeRoot, ...server.proxyScript)],
      env: {
        [server.proxyUrlEnvVar]: endpoint,
        [server.capabilityFileEnvVar]: capabilityFile,
      },
      codexToolsApprovalMode: 'approve',
    });
  }
  return entries;
}

/** Additive SDK representation; callers deliberately never set strictMcpConfig. */
export function toSdkMcpServers(entries: readonly McpEntry[]): Record<string, StdioMcpServerConfig> {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.name,
      { command: entry.command, args: [...entry.args], env: { ...entry.env } },
    ]),
  );
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTeamChat(chatId: string | undefined): boolean {
  return typeof chatId === 'string' && /^(?:teaminst|team):/.test(chatId);
}

function isAbsoluteFilePath(value: string | undefined): value is string {
  return hasValue(value) && path.isAbsolute(value);
}

function loopbackHttpEndpoint(value: string | undefined): string | undefined {
  if (!hasValue(value)) return undefined;
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password
    ) {
      return undefined;
    }
    return endpoint.toString();
  } catch {
    return undefined;
  }
}
