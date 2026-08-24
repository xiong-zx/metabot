import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { EngineName } from './types.js';
import { buildExecutionMcpEntries, type McpEntry } from './mcp-entries.js';
import {
  EXECUTION_MCP_SERVERS,
  type AnyMcpServerDescriptor,
} from '../services/mcp-registry.js';
import { EXECUTION_CAPABILITY_TTL_MS } from '../services/execution-capabilities.js';
import {
  leaseCapabilityFile,
  sweepExpiredCapabilityLeases,
  type CapabilityLease,
} from '../services/capability-lease.js';

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
  /** Defaults to the full registry; overridden by fixtures. */
  servers?: readonly AnyMcpServerDescriptor[];
  /** Injectable only so tests can force a filename collision. */
  nonce?: () => string;
  /** Injectable only so lease expiry and collision tests are deterministic. */
  now?: () => number;
}

export interface MaterializedExecutionMcp {
  entries: McpEntry[];
  claudeMcpConfigPath?: string;
  cleanup(): void;
}

/**
 * Capability material older than this at Bridge startup cannot belong to a live
 * turn: capabilities themselves expire in an hour, and any file still present
 * is a crash leftover rather than state a running session depends on.
 */
export const CAPABILITY_SWEEP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const CAPABILITY_SCRATCH_SEGMENTS = ['data', 'mcp-capabilities'] as const;

/**
 * Materialize short-lived capabilities without putting token bytes in argv,
 * generated MCP config, prompts, or logs. Missing/unsafe inputs produce no
 * MCP entries and leave the underlying engine usable without external tools.
 */
export function materializeExecutionMcp(
  input: MaterializeExecutionMcpInput,
): MaterializedExecutionMcp | undefined {
  const executionEnv = input.executionEnv;
  const servers = input.servers ?? EXECUTION_MCP_SERVERS;
  const authorized = servers.filter((server) => hasValue(executionEnv?.[server.capabilityEnvVar]));
  if (authorized.length === 0) return undefined;

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
    logEndpointRefusals(input, authorized);
    return materializeAuthorizedExecutionMcp(input, executionEnv!, authorized);
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
  servers: readonly AnyMcpServerDescriptor[],
): MaterializedExecutionMcp | undefined {
  const runtimeRoot = canonicalRuntimeRoot(input.runtimeRoot);
  const scratchDir = secureScratchDirectory(runtimeRoot);
  // Two turns in one chat overlap routinely, and a shared per-chat filename
  // makes the second turn's write visible to the first turn's already-running
  // proxy and makes the first cleanup delete the second turn's credential.
  // A per-turn nonce gives every turn its own path, so concurrent turns and
  // crash leftovers can never collide.
  const scopeName = `${safePrefix(input.botName)}-${scopeHash(input.botName, input.chatId)}-${(input.nonce ?? randomUUID)()}`;
  const capabilityFiles: Record<string, string> = {};
  const entries: McpEntry[] = [];
  const leases: CapabilityLease[] = [];
  const leasedPaths: string[] = [];
  try {
    // Each product server is independent, so one unusable entry must remove
    // only itself. A missing ARC proxy can never disable Worker Runner, and a
    // failed Worker lease can never disable ARC.
    for (const server of servers) {
      let lease: CapabilityLease | undefined;
      try {
        lease = leaseCapabilityFile({
          runtimeRoot,
          audience: server.leaseNamespace,
          scope: `${input.botName}\0${input.chatId}\0${scopeName}`,
          token: executionEnv[server.capabilityEnvVar]!,
          expiresAt: (input.now ?? Date.now)() + EXECUTION_CAPABILITY_TTL_MS,
          nonce: input.nonce,
        });
        capabilityFiles[server.id] = lease.path;
        const [entry] = buildExecutionMcpEntries({
          executionEnv,
          bridgeEnv: input.bridgeEnv,
          runtimeRoot,
          capabilityFiles,
          servers: [server],
        });
        if (!entry) throw new Error('MCP entry configuration is incomplete');
        assertConfinedExecutionEntry(entry, runtimeRoot);
        leases.push(lease);
        entries.push(entry);
      } catch (error) {
        lease?.release();
        input.logger.warn(
          { engine: input.engineName, server: server.serverName, reason: errorMessage(error) },
          'Execution MCP entry omitted; other external tools stay available',
        );
        continue;
      }
    }
    if (entries.length === 0) {
      for (const lease of leases) lease.release();
      return undefined;
    }

    let claudeMcpConfigPath: string | undefined;
    if (input.engineName === 'claude') {
      // Assembled only from entries that actually survived leasing, so Claude
      // never receives a server whose credential was not written.
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
        for (const lease of leases) lease.release();
      },
    };
  } catch (error) {
    for (const filePath of leasedPaths) releasePrivateFile(filePath, input.logger);
    for (const lease of leases) lease.release();
    throw error;
  }
}

/**
 * Bridge-startup sweep.
 *
 * A crash between leasing and cleanup leaves capability material on disk with
 * nothing left to delete it. Per-turn filenames mean those leftovers accumulate
 * instead of being overwritten, so startup removes anything older than a
 * capability could still be valid. Live turns are younger than the cutoff, so
 * this never deletes credentials a running session still needs.
 */
export function sweepExpiredCapabilityFiles(
  runtimeRoot: string,
  logger: McpMaterializeLogger,
  options: { now?: number; maxAgeMs?: number } = {},
): { removed: string[]; kept: number } {
  const removed: string[] = [];
  let kept = 0;
  let scratchDir: string;
  try {
    const canonical = sweepExpiredCapabilityLeases(runtimeRoot, { now: options.now });
    scratchDir = canonical.directory;
    removed.push(...canonical.removed.map((name) => path.join(scratchDir, name)));
  } catch {
    return { removed, kept };
  }
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? CAPABILITY_SWEEP_MAX_AGE_MS);
  let names: string[];
  try {
    names = readdirSync(scratchDir);
  } catch (error) {
    logger.warn({ path: scratchDir, reason: errorMessage(error) }, 'Failed to sweep execution MCP material');
    return { removed, kept };
  }
  for (const name of names) {
    if (/^scope-[0-9a-f]{24}-[A-Za-z0-9_]{1,64}-[1-9][0-9]*-[0-9a-f-]{36}\.token$/.test(name)) {
      kept += 1;
      continue;
    }
    const candidate = path.join(scratchDir, name);
    try {
      const info = lstatSync(candidate);
      if (!info.isFile()) continue;
      if (statSync(candidate).mtimeMs > cutoff) {
        kept += 1;
        continue;
      }
      rmSync(candidate, { force: true });
      removed.push(candidate);
    } catch (error) {
      logger.warn({ path: candidate, reason: errorMessage(error) }, 'Failed to sweep execution MCP material');
    }
  }
  return { removed, kept };
}

/**
 * An executable path only reaches an engine configuration after it is proven to
 * be a real file inside the runtime root, so a stale workspace link or an
 * uninstalled package cannot point an engine at an arbitrary binary.
 */
function assertConfinedExecutionEntry(entry: McpEntry, runtimeRoot: string): void {
  let canonicalCommand: string;
  try {
    canonicalCommand = realpathSync(entry.command);
  } catch {
    throw new Error('MCP proxy executable is missing');
  }
  const canonicalNode = realpathSync(process.execPath);
  if (canonicalCommand === canonicalNode) {
    if (entry.args.length !== 1) throw new Error('Node MCP proxy must name exactly one entry script');
    assertConfinedFile(entry.args[0], runtimeRoot, 'script');
    return;
  }
  assertConfinedFile(entry.command, runtimeRoot, 'executable');
}

function assertConfinedFile(candidate: string, runtimeRoot: string, kind: 'executable' | 'script'): void {
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new Error(`MCP proxy ${kind} is missing`);
  }
  if (!isWithin(runtimeRoot, canonical)) throw new Error(`MCP proxy ${kind} escapes the runtime root`);
  const info = lstatSync(canonical);
  if (!info.isFile()) throw new Error(`MCP proxy ${kind} is not a regular file`);
}

function logEndpointRefusals(
  input: MaterializeExecutionMcpInput,
  servers: readonly AnyMcpServerDescriptor[],
): void {
  for (const server of servers) {
    const endpoint = input.bridgeEnv[server.endpointEnvVar];
    if (!hasValue(endpoint)) {
      input.logger.warn(
        { engine: input.engineName, purpose: server.id, reason: 'daemon endpoint is not configured' },
        'Execution MCP entry omitted; external tool fails closed',
      );
      continue;
    }
    if (!isAcceptedEndpoint(endpoint)) {
      input.logger.warn(
        { engine: input.engineName, purpose: server.id, reason: 'daemon endpoint is not loopback HTTP' },
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
  const scratchDir = path.join(runtimeRoot, ...CAPABILITY_SCRATCH_SEGMENTS);
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
    // Per-turn names make this exclusive, so an existing file is a real
    // collision rather than a previous turn to overwrite.
    if (existsSync(filePath)) throw new Error('MCP capability path is already leased');
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function releasePrivateFile(filePath: string, logger: McpMaterializeLogger): void {
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
