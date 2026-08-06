import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { EngineName } from './types.js';
import { buildExecutionMcpEntries, type McpEntry } from './mcp-entries.js';

interface McpMaterializeLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  debug?(fields: Record<string, unknown>, message: string): void;
}

export interface MaterializeExecutionMcpInput {
  executionEnv: Record<string, string> | undefined;
  bridgeEnv: NodeJS.ProcessEnv;
  runtimeRoot: string;
  engineName: EngineName;
  botName: string;
  chatId: string;
  logger: McpMaterializeLogger;
}

export interface MaterializedExecutionMcp {
  entries: McpEntry[];
  claudeMcpConfigPath?: string;
  cleanup(): void;
}

const fileLeases = new Map<string, number>();

/**
 * Materialize short-lived capabilities without putting token bytes in argv,
 * generated MCP config, prompts, or logs. Missing/unsafe inputs produce no
 * MCP entries and leave the underlying engine usable without external tools.
 */
export function materializeExecutionMcp(
  input: MaterializeExecutionMcpInput,
): MaterializedExecutionMcp | undefined {
  const executionEnv = input.executionEnv;
  const hasWorker = hasValue(executionEnv?.METABOT_WORKER_CAPABILITY);
  const hasArc = hasValue(executionEnv?.METABOT_ARC_CAPABILITY);
  if (!hasWorker && !hasArc) return undefined;

  if (input.engineName === 'kimi') {
    input.logger.warn(
      { engine: 'kimi', reason: 'no per-session MCP surface' },
      'Execution MCP unavailable; external tools fail closed for this session',
    );
    return undefined;
  }

  if (
    executionEnv?.METABOT_BOT_NAME !== input.botName ||
    executionEnv.METABOT_CHAT_ID !== input.chatId
  ) {
    input.logger.warn(
      { engine: input.engineName, reason: 'execution identity does not match this turn' },
      'Execution MCP unavailable; external tools fail closed for this session',
    );
    return undefined;
  }

  if (
    /^(?:teaminst|team):/.test(executionEnv.METABOT_CHAT_ID) ||
    /^(?:teaminst|team):/.test(input.chatId)
  ) {
    input.logger.warn(
      { engine: input.engineName, reason: 'team sessions are not authorized' },
      'Execution MCP unavailable; external tools fail closed for this session',
    );
    return undefined;
  }

  try {
    logEndpointRefusals(input, hasWorker, hasArc);
    return materializeAuthorizedExecutionMcp(input, executionEnv!, hasWorker, hasArc);
  } catch (error) {
    input.logger.warn(
      { engine: input.engineName, reason: errorMessage(error) },
      'Execution MCP materialization failed; external tools fail closed for this session',
    );
    return undefined;
  }
}

function materializeAuthorizedExecutionMcp(
  input: MaterializeExecutionMcpInput,
  executionEnv: Record<string, string>,
  hasWorker: boolean,
  hasArc: boolean,
): MaterializedExecutionMcp | undefined {
  const runtimeRoot = canonicalRuntimeRoot(input.runtimeRoot);
  const scratchDir = secureScratchDirectory(runtimeRoot);
  const scopeName = `${safePrefix(input.botName)}-${scopeHash(input.botName, input.chatId)}`;
  const capabilityFiles = {
    ...(hasWorker ? { worker: path.join(scratchDir, `${scopeName}-worker.token`) } : {}),
    ...(hasArc ? { arc: path.join(scratchDir, `${scopeName}-arc.token`) } : {}),
  };
  const entries = buildExecutionMcpEntries({
    executionEnv,
    bridgeEnv: input.bridgeEnv,
    runtimeRoot,
    capabilityFiles,
  });
  if (entries.length === 0) return undefined;

  const leasedPaths: string[] = [];
  try {
    for (const entry of entries) {
      if (entry.name === 'metabot-worker') {
        leasePrivateFile(capabilityFiles.worker!, executionEnv.METABOT_WORKER_CAPABILITY!);
        leasedPaths.push(capabilityFiles.worker!);
      } else {
        leasePrivateFile(capabilityFiles.arc!, executionEnv.METABOT_ARC_CAPABILITY!);
        leasedPaths.push(capabilityFiles.arc!);
      }
    }

    let claudeMcpConfigPath: string | undefined;
    if (input.engineName === 'claude') {
      claudeMcpConfigPath = path.join(scratchDir, `${scopeName}-claude-mcp.json`);
      leasePrivateFile(
        claudeMcpConfigPath,
        `${JSON.stringify({ mcpServers: Object.fromEntries(entries.map((entry) => [entry.name, {
          command: entry.command,
          args: entry.args,
          env: entry.env,
        }])) }, null, 2)}\n`,
      );
      leasedPaths.push(claudeMcpConfigPath);
    }

    let cleaned = false;
    return {
      entries,
      ...(claudeMcpConfigPath ? { claudeMcpConfigPath } : {}),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        for (const filePath of leasedPaths) releasePrivateFile(filePath, input.logger);
      },
    };
  } catch (error) {
    for (const filePath of leasedPaths) releasePrivateFile(filePath, input.logger);
    throw error;
  }
}

function logEndpointRefusals(input: MaterializeExecutionMcpInput, hasWorker: boolean, hasArc: boolean): void {
  const checks: Array<[boolean, 'worker' | 'arc', string | undefined]> = [
    [hasWorker, 'worker', input.bridgeEnv.METABOT_WORKER_DAEMON_URL],
    [hasArc, 'arc', input.bridgeEnv.METABOT_ARC_DAEMON_URL],
  ];
  for (const [authorized, purpose, endpoint] of checks) {
    if (!authorized) continue;
    if (!hasValue(endpoint)) {
      input.logger.warn(
        { engine: input.engineName, purpose, reason: 'daemon endpoint is not configured' },
        'Execution MCP entry omitted; external tool fails closed',
      );
      continue;
    }
    if (!isAcceptedEndpoint(endpoint)) {
      input.logger.warn(
        { engine: input.engineName, purpose, reason: 'daemon endpoint is not loopback HTTP' },
        'Execution MCP entry omitted; external tool fails closed',
      );
    }
  }
}

function isAcceptedEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(endpoint.hostname) &&
      !endpoint.username &&
      !endpoint.password
    );
  } catch {
    return false;
  }
}

function canonicalRuntimeRoot(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('runtime root must be absolute');
  return realpathSync(value);
}

function secureScratchDirectory(runtimeRoot: string): string {
  const scratchDir = path.join(runtimeRoot, 'data', 'mcp-capabilities');
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(scratchDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MCP capability scratch path is not a real directory');
  const canonical = realpathSync(scratchDir);
  if (!isWithin(runtimeRoot, canonical)) throw new Error('MCP capability scratch path escapes the runtime root');
  if (process.getuid && info.uid !== process.getuid()) throw new Error('MCP capability scratch directory owner mismatch');
  chmodSync(canonical, 0o700);
  return canonical;
}

function leasePrivateFile(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporaryPath, 0o600);
    const temporaryInfo = lstatSync(temporaryPath);
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink()) {
      throw new Error('MCP capability material is not a regular file');
    }
    if (process.getuid && temporaryInfo.uid !== process.getuid()) {
      throw new Error('MCP capability material owner mismatch');
    }
    renameSync(temporaryPath, filePath);
    fileLeases.set(filePath, (fileLeases.get(filePath) ?? 0) + 1);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function releasePrivateFile(filePath: string, logger: McpMaterializeLogger): void {
  const remaining = (fileLeases.get(filePath) ?? 1) - 1;
  if (remaining > 0) {
    fileLeases.set(filePath, remaining);
    return;
  }
  fileLeases.delete(filePath);
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    logger.warn(
      { path: filePath, reason: errorMessage(error) },
      'Failed to clean execution MCP material',
    );
  }
}

function scopeHash(botName: string, chatId: string): string {
  return createHash('sha256').update(botName).update('\0').update(chatId).digest('hex').slice(0, 24);
}

function safePrefix(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return normalized || 'bot';
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
