import {
  accessSync,
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type McpToolApprovalMode = 'auto' | 'prompt' | 'writes' | 'approve';

/**
 * Product-neutral description of an independently installed stdio MCP server.
 *
 * The descriptor deliberately contains no MetaBot identity, capability, daemon,
 * database, or lifecycle fields. Product-owned configuration is passed through
 * unchanged; the product remains responsible for its own authentication and
 * durable state.
 */
export interface ExternalMcpServerDescriptor {
  /** Stable MCP server name exposed to the engine. */
  name: string;
  /** Explicit per-bot opt-in. Only the literal value true enables the server. */
  enabled: boolean;
  /** Installed executable name or an absolute executable path. */
  command: string;
  args?: string[];
  /** Literal product configuration. Do not put credentials in bots.json. */
  env?: Record<string, string>;
  /** Product variable -> existing host variable, for secret-safe forwarding. */
  envFrom?: Record<string, string>;
  /** Codex-native default MCP tool approval policy. */
  approvalMode: McpToolApprovalMode;
  enabledTools?: string[];
  disabledTools?: string[];
  toolApprovals?: Record<string, McpToolApprovalMode>;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export interface ResolvedExternalMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  approvalMode: McpToolApprovalMode;
  enabledTools?: string[];
  disabledTools?: string[];
  toolApprovals: Record<string, McpToolApprovalMode>;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export interface ExternalMcpFailure {
  server: string;
  reason: string;
}

export interface ExternalMcpResolution {
  servers: ResolvedExternalMcpServer[];
  failures: ExternalMcpFailure[];
}

export interface ClaudeMcpConfigLease {
  path: string;
  cleanup(): void;
}

const APPROVAL_MODES = new Set<McpToolApprovalMode>(['auto', 'prompt', 'writes', 'approve']);
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve every enabled descriptor independently. A bad or missing product
 * removes only itself; other installed MCP servers remain available.
 */
export function resolveExternalMcpServers(
  descriptors: readonly ExternalMcpServerDescriptor[] | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): ExternalMcpResolution {
  const servers: ResolvedExternalMcpServer[] = [];
  const failures: ExternalMcpFailure[] = [];
  if (descriptors !== undefined && !Array.isArray(descriptors)) {
    return {
      servers,
      failures: [{ server: '(configuration)', reason: 'mcpServers must be an array' }],
    };
  }
  const names = new Set<string>();
  const forwardedEnvironment = new Map<string, { owner: string; value: string }>();

  for (const raw of descriptors ?? []) {
    if (!raw || raw.enabled !== true) continue;
    const label = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '(unnamed)';
    try {
      const server = resolveOne(raw, environment);
      if (names.has(server.name)) throw new Error('duplicate enabled server name');

      for (const [key, value] of Object.entries(server.env)) {
        const existing = forwardedEnvironment.get(key);
        if (existing && existing.value !== value) {
          throw new Error(`environment variable ${key} conflicts with server ${existing.owner}`);
        }
      }

      names.add(server.name);
      for (const [key, value] of Object.entries(server.env)) {
        forwardedEnvironment.set(key, { owner: server.name, value });
      }
      servers.push(server);
    } catch (error) {
      failures.push({ server: label, reason: errorMessage(error) });
    }
  }

  return { servers, failures };
}

/** SDK-native additive representation used by Claude Agent SDK. */
export function toClaudeMcpServers(
  servers: readonly ResolvedExternalMcpServer[],
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  return Object.fromEntries(
    servers.map((server) => [
      server.name,
      { command: server.command, args: [...server.args], env: { ...server.env } },
    ]),
  );
}

/**
 * Build Codex config overrides without placing product configuration values in
 * argv. Values are inherited from the Codex child environment via env_vars.
 */
export function buildCodexMcpConfigArgs(servers: readonly ResolvedExternalMcpServer[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    const prefix = `mcp_servers.${server.name}`;
    args.push('-c', `${prefix}.command=${tomlString(server.command)}`);
    args.push('-c', `${prefix}.default_tools_approval_mode=${tomlString(server.approvalMode)}`);
    if (server.args.length > 0) {
      args.push('-c', `${prefix}.args=${tomlStringArray(server.args)}`);
    }
    const envNames = Object.keys(server.env).sort();
    if (envNames.length > 0) {
      args.push('-c', `${prefix}.env_vars=${tomlStringArray(envNames)}`);
    }
    if (server.enabledTools) {
      args.push('-c', `${prefix}.enabled_tools=${tomlStringArray(server.enabledTools)}`);
    }
    if (server.disabledTools) {
      args.push('-c', `${prefix}.disabled_tools=${tomlStringArray(server.disabledTools)}`);
    }
    if (server.startupTimeoutSec !== undefined) {
      args.push('-c', `${prefix}.startup_timeout_sec=${server.startupTimeoutSec}`);
    }
    if (server.toolTimeoutSec !== undefined) {
      args.push('-c', `${prefix}.tool_timeout_sec=${server.toolTimeoutSec}`);
    }
    for (const [tool, approvalMode] of Object.entries(server.toolApprovals).sort(([left], [right]) => left.localeCompare(right))) {
      args.push('-c', `${prefix}.tools.${tool}.approval_mode=${tomlString(approvalMode)}`);
    }
  }
  return args;
}

/** Merge only the explicitly selected product variables into an engine child. */
export function externalMcpEnvironment(
  servers: readonly ResolvedExternalMcpServer[],
): Record<string, string> {
  return Object.assign({}, ...servers.map((server) => server.env)) as Record<string, string>;
}

/**
 * Claude CLI accepts MCP servers through a JSON file. The file is private,
 * per-executor, and removed when that executor closes.
 */
export function leaseClaudeMcpConfig(
  servers: readonly ResolvedExternalMcpServer[],
  temporaryRoot: string = os.tmpdir(),
): ClaudeMcpConfigLease | undefined {
  if (servers.length === 0) return undefined;
  const directory = mkdtempSync(path.join(temporaryRoot, 'metabot-external-mcp-'));
  try {
    chmodSync(directory, 0o700);
    const configPath = path.join(directory, 'mcp.json');
    writeFileSync(
      configPath,
      `${JSON.stringify({ mcpServers: toClaudeMcpServers(servers) }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    chmodSync(configPath, 0o600);
    let cleaned = false;
    return {
      path: configPath,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function resolveOne(
  raw: ExternalMcpServerDescriptor,
  environment: NodeJS.ProcessEnv,
): ResolvedExternalMcpServer {
  const name = requiredString(raw.name, 'server name');
  if (!SERVER_NAME.test(name)) throw new Error('server name may contain only letters, digits, underscore, and hyphen');
  const command = resolveExecutable(requiredString(raw.command, 'command'), environment);
  const args = stringList(raw.args, 'args') ?? [];
  const approvalMode = approval(raw.approvalMode, 'approvalMode');
  const enabledTools = toolList(raw.enabledTools, 'enabledTools');
  const disabledTools = toolList(raw.disabledTools, 'disabledTools');
  const env = stringMap(raw.env, 'env');
  const envFrom = stringMap(raw.envFrom, 'envFrom');

  for (const [target, source] of Object.entries(envFrom)) {
    assertEnvironmentName(target, 'product environment variable');
    assertEnvironmentName(source, 'source environment variable');
    if (Object.prototype.hasOwnProperty.call(env, target)) {
      throw new Error(`environment variable ${target} is configured by both env and envFrom`);
    }
    const value = environment[source];
    if (value === undefined || value.length === 0) {
      throw new Error(`required source environment variable ${source} is not set`);
    }
    env[target] = value;
  }
  for (const key of Object.keys(env)) assertEnvironmentName(key, 'product environment variable');

  const toolApprovals = stringMap(raw.toolApprovals, 'toolApprovals');
  for (const [tool, mode] of Object.entries(toolApprovals)) {
    if (!SERVER_NAME.test(tool)) throw new Error(`invalid tool name ${tool}`);
    approval(mode, `toolApprovals.${tool}`);
  }

  return {
    name,
    command,
    args,
    env,
    approvalMode,
    ...(enabledTools ? { enabledTools } : {}),
    ...(disabledTools ? { disabledTools } : {}),
    toolApprovals: toolApprovals as Record<string, McpToolApprovalMode>,
    ...optionalPositiveNumber(raw.startupTimeoutSec, 'startupTimeoutSec'),
    ...optionalPositiveNumber(raw.toolTimeoutSec, 'toolTimeoutSec'),
  };
}

function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(command)) return assertExecutable(command);
  if (command.includes('/') || command.includes('\\')) {
    throw new Error('command must be an installed executable name or absolute path');
  }
  const searchPath = environment.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        return assertExecutable(candidate);
      } catch {
        // Keep searching the remaining PATH entries.
      }
    }
  }
  throw new Error(`executable ${command} was not found on PATH`);
}

function assertExecutable(candidate: string): string {
  const canonical = realpathSync(candidate);
  if (!statSync(canonical).isFile()) throw new Error('command is not a regular file');
  if (process.platform !== 'win32') accessSync(canonical, fsConstants.X_OK);
  return canonical;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

function toolList(value: unknown, field: string): string[] | undefined {
  const items = stringList(value, field);
  if (!items) return undefined;
  if (items.some((item) => !SERVER_NAME.test(item))) throw new Error(`${field} contains an invalid tool name`);
  if (new Set(items).size !== items.length) throw new Error(`${field} contains a duplicate tool name`);
  return items;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function approval(value: unknown, field: string): McpToolApprovalMode {
  if (typeof value !== 'string' || !APPROVAL_MODES.has(value as McpToolApprovalMode)) {
    throw new Error(`${field} must be one of auto, prompt, writes, or approve`);
  }
  return value as McpToolApprovalMode;
}

function assertEnvironmentName(value: string, field: string): void {
  if (!ENV_NAME.test(value)) throw new Error(`${field} ${value} is invalid`);
}

function optionalPositiveNumber(
  value: unknown,
  field: 'startupTimeoutSec' | 'toolTimeoutSec',
): Partial<Pick<ResolvedExternalMcpServer, 'startupTimeoutSec' | 'toolTimeoutSec'>> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return { [field]: value };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
