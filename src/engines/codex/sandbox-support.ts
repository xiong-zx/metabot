/**
 * Codex sandbox capability probe.
 *
 * `codex --sandbox read-only|workspace-write` confines the agent with Linux
 * user namespaces (via bubblewrap). Containers that forbid unprivileged
 * namespace creation — a common AppArmor/seccomp posture, including this
 * project's AutoDL hosts — fail every write with
 * `bwrap: No permissions to create new namespace`.
 *
 * So the *default* sandbox mode has to be environment-aware: keep the safe
 * `workspace-write` wherever the kernel can actually enforce it, and degrade to
 * `danger-full-access` only where it provably cannot, with a loud warning. An
 * explicitly configured sandbox (bots.json `codex.sandbox` or `CODEX_SANDBOX`)
 * is never touched by this module.
 *
 * The probe mirrors the `codex_sandbox_namespaces` check in `bin/metabot`
 * (`metabot doctor`) so the two agree on what "available" means.
 */

import { spawnSync } from 'node:child_process';
import type { Logger } from '../../utils/logger.js';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Upstream default — a real sandbox, used whenever the host can enforce it. */
export const DEFAULT_CODEX_SANDBOX: CodexSandboxMode = 'workspace-write';
/** Degraded default for hosts that cannot create user namespaces. */
export const DEGRADED_CODEX_SANDBOX: CodexSandboxMode = 'danger-full-access';

const PROBE_TIMEOUT_MS = 5_000;

export interface CodexSandboxSupport {
  /** False only when a probe ran and positively failed. */
  available: boolean;
  /** Which probe produced the verdict. */
  probe: 'bwrap' | 'unshare' | 'none' | 'non-linux';
  /** Why the probe failed, when it did. */
  reason?: string;
}

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  /** Returns undefined when the command is not installed. */
  run?: (command: string, args: string[]) => { status: number | null; stderr: string } | undefined;
}

function defaultRun(command: string, args: string[]): { status: number | null; stderr: string } | undefined {
  const result = spawnSync(command, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf-8' });
  // ENOENT means the tool isn't installed — that is "unknown", not "unavailable".
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  return { status: result.status, stderr: (result.stderr || '').trim() };
}

/**
 * Uncached probe. Exported so tests can drive it with fake platform/runner.
 *
 * Fails safe: if no probe tool is available we report `available`, because
 * degrading the sandbox on a guess would be a silent security downgrade.
 */
export function probeCodexSandboxSupport(deps: ProbeDeps = {}): CodexSandboxSupport {
  const platform = deps.platform ?? process.platform;
  // macOS uses Seatbelt and Windows has no bwrap; neither goes through
  // namespaces, so a bwrap probe would say "unavailable" for the wrong reason.
  if (platform !== 'linux') return { available: true, probe: 'non-linux' };

  const run = deps.run ?? defaultRun;

  const bwrap = run('bwrap', [
    '--unshare-user',
    '--uid', '0',
    '--gid', '0',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '/bin/sh', '-lc', 'true',
  ]);
  if (bwrap) {
    if (bwrap.status === 0) return { available: true, probe: 'bwrap' };
    return { available: false, probe: 'bwrap', reason: bwrap.stderr || 'bwrap namespace smoke test failed' };
  }

  const unshare = run('unshare', ['-Ur', 'true']);
  if (unshare) {
    if (unshare.status === 0) return { available: true, probe: 'unshare' };
    return { available: false, probe: 'unshare', reason: unshare.stderr || 'unshare -Ur failed' };
  }

  return { available: true, probe: 'none' };
}

let cachedSupport: CodexSandboxSupport | undefined;
let warned = false;

/** Cached probe — spawning a child process per Codex turn would be wasteful. */
export function getCodexSandboxSupport(): CodexSandboxSupport {
  cachedSupport ??= probeCodexSandboxSupport();
  return cachedSupport;
}

/**
 * The sandbox mode to use when neither bots.json nor `CODEX_SANDBOX` names one.
 * Warns once per process when it has to degrade.
 */
export function resolveDefaultCodexSandbox(logger?: Pick<Logger, 'warn'>): CodexSandboxMode {
  const support = getCodexSandboxSupport();
  if (support.available) return DEFAULT_CODEX_SANDBOX;

  if (!warned) {
    warned = true;
    logger?.warn(
      { engine: 'codex', probe: support.probe, reason: support.reason, sandbox: DEGRADED_CODEX_SANDBOX },
      `Codex sandbox degraded: this host cannot create the user namespaces that `
      + `--sandbox ${DEFAULT_CODEX_SANDBOX} needs, so Codex will run with `
      + `--sandbox ${DEGRADED_CODEX_SANDBOX} (no filesystem confinement). `
      + `Set codex.sandbox in bots.json or CODEX_SANDBOX to override this explicitly, `
      + `or run 'metabot doctor --json' and see codex_sandbox_namespaces to fix the host.`,
    );
  }
  return DEGRADED_CODEX_SANDBOX;
}

/** Test seam: pin the probe result. */
export function setCodexSandboxSupportForTests(support: CodexSandboxSupport | undefined): void {
  cachedSupport = support;
  warned = false;
}

/** Test seam: drop the cached probe result and the warn-once latch. */
export function resetCodexSandboxSupportForTests(): void {
  cachedSupport = undefined;
  warned = false;
}
