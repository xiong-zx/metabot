import path from 'node:path';

export interface McpEntry {
  name: 'metabot-worker' | 'metabot-arc';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpEntryInput {
  executionEnv: Record<string, string> | undefined;
  bridgeEnv: NodeJS.ProcessEnv;
  runtimeRoot: string;
  capabilityFiles: { worker?: string; arc?: string };
}

export interface StdioMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Pure authority/config builder. It performs no IO and imports no downstream
 * package: Bridge-to-daemon contact stays on the package-owned proxy wire.
 */
export function buildExecutionMcpEntries(input: McpEntryInput): McpEntry[] {
  const executionEnv = input.executionEnv;
  if (!executionEnv || isTeamChat(executionEnv.METABOT_CHAT_ID) || !path.isAbsolute(input.runtimeRoot)) {
    return [];
  }

  const entries: McpEntry[] = [];
  const workerEndpoint = loopbackHttpEndpoint(input.bridgeEnv.METABOT_WORKER_DAEMON_URL);
  if (
    hasValue(executionEnv.METABOT_WORKER_CAPABILITY) &&
    workerEndpoint &&
    isAbsoluteFilePath(input.capabilityFiles.worker)
  ) {
    entries.push({
      name: 'metabot-worker',
      command: path.join(input.runtimeRoot, 'node_modules', '.bin', 'metabot-worker-runner-proxy'),
      args: [],
      env: {
        METABOT_WORKER_PROXY_URL: workerEndpoint,
        METABOT_WORKER_PROXY_CAPABILITY_FILE: input.capabilityFiles.worker,
      },
    });
  }

  const arcEndpoint = loopbackHttpEndpoint(input.bridgeEnv.METABOT_ARC_DAEMON_URL);
  if (
    hasValue(executionEnv.METABOT_ARC_CAPABILITY) &&
    arcEndpoint &&
    isAbsoluteFilePath(input.capabilityFiles.arc)
  ) {
    entries.push({
      name: 'metabot-arc',
      command: path.join(input.runtimeRoot, 'node_modules', '.bin', 'metabot-arc-proxy'),
      args: [],
      env: {
        METABOT_ARC_PROXY_URL: arcEndpoint,
        METABOT_ARC_PROXY_CAPABILITY_FILE: input.capabilityFiles.arc,
      },
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
