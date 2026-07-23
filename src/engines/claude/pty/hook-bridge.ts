/**
 * PTY backend — hook bridge.
 *
 * In SDK mode, hooks are JS callbacks invoked in-process. In PTY mode the
 * spawned `claude` runs hooks as shell `command`s defined in --settings json.
 * This bridge:
 *   1. Generates a settings.json with command hooks pointing at small shell
 *      snippets that write sentinel/event files.
 *   2. Watches the Stop sentinel to fire `onTurnComplete`.
 *   3. Tails the team-event file to fire `onTeamEvent`.
 *
 * NOTE: PreToolUse(AskUserQuestion) interactive answering is OUT OF SCOPE for
 * phase 1 — the bridge does not intercept or respond to AskUserQuestion hooks.
 * // phase 2: wire PreToolUse(AskUserQuestion) hook that writes the question
 * // payload to a file, then blocks until an answer file appears. The bridge
 * // would watch for the question file and invoke a callback to get the answer.
 */

import {
  mkdirSync, writeFileSync, rmSync, existsSync, watch,
  openSync, readSync, statSync, closeSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FSWatcher } from 'node:fs';
import type { PtyHookBridge } from './contract.js';
import type { Logger } from '../../../utils/logger.js';

const BRIDGE_DIR_RE = /^metabot-pty-[0-9a-f]{8}$/;

/**
 * Remove orphaned `metabot-pty-*` temp dirs left behind by a previous
 * process instance.
 *
 * dispose() (below) only runs on the normal PTY-session teardown path. A
 * crash, `kill -9`, or `pm2 restart` skips it, so every session live at that
 * moment leaks its bridge dir — sentinel files, and (until the 0700/0600
 * fix) a world-readable copy of METABOT_API_SECRET. Nothing later cleans
 * these up, so they accumulate for as long as the machine stays up.
 *
 * Call this exactly once, at process startup, before any bridge is created
 * in this process. At that point every directory matching the naming
 * pattern was necessarily created by a *previous* process instance — this
 * one has made zero bridges so far — so all of them are safe to remove.
 * Any `claude` child process that still holds one open is itself orphaned:
 * MetaBot has no session-registry pointer to it in the new process, and PTY
 * sessions are not resumed by re-attaching to an old bridge dir, so it is
 * unreachable garbage regardless of whether we delete its temp dir out from
 * under it.
 *
 * Do not call after this process has started creating its own bridges —
 * it does not distinguish "created by this process" from "created by a
 * prior one" beyond the startup-ordering guarantee above.
 *
 * @param logger optional; warnings on individual removal failures.
 * @param baseDir directory to scan, default `os.tmpdir()`. Tests should pass
 *   an isolated scratch dir here — scanning the real OS tmp dir from a test
 *   would delete any bridge dir a live PTY session on the same machine
 *   currently owns.
 */
export function cleanupStaleBridgeDirs(logger?: Pick<Logger, 'warn'>, baseDir: string = tmpdir()): number {
  const dir = baseDir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (!BRIDGE_DIR_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger?.warn({ err, dir: full }, 'hook-bridge: failed to remove stale bridge dir');
    }
  }
  return removed;
}

export interface HookBridgeOptions {
  /**
   * Include TaskCreated/TaskCompleted/TeammateIdle command hooks in the
   * generated settings.json. Default: false.
   *
   * These hook events are REJECTED by the current claude CLI settings
   * validator — including them causes a validation dialog that blocks the
   * TUI from starting. Kept behind this flag for phase 2 when the CLI
   * schema is updated or we find a workaround. The SDK path still receives
   * team events via JS callbacks; PTY team-event observation is deferred.
   */
  teamEvents?: boolean;
}

/**
 * Create a new PtyHookBridge instance. Each instance owns a temp directory
 * for its sentinel/event files and generated settings.json.
 */
export function createHookBridge(options?: HookBridgeOptions): PtyHookBridge {
  const enableTeamEvents = options?.teamEvents === true;

  const bridgeId = randomUUID().slice(0, 8);
  const bridgeDir = join(tmpdir(), `metabot-pty-${bridgeId}`);
  // 0700: mcp-config.json below carries METABOT_API_SECRET in plaintext, so
  // nothing in this dir may be readable by other users on the machine.
  mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });

  const sentinelPath = join(bridgeDir, 'stop.flag');
  const teamEventPath = join(bridgeDir, 'team-events.jsonl');
  const settingsPath = join(bridgeDir, 'settings.json');
  const mcpConfigPath = join(bridgeDir, 'mcp-config.json');

  let turnCb: (() => void) | null = null;
  let teamCb: ((event: { kind: string; payload: unknown }) => void) | null = null;

  let sentinelWatcher: FSWatcher | null = null;
  let teamEventInterval: ReturnType<typeof setInterval> | null = null;
  let teamEventOffset = 0;
  let disposed = false;

  // ── writeSettings ────────────────────────────────────────────────────────

  async function writeSettings(): Promise<string> {
    // Stop hook: Claude pipes hook JSON on stdin to the command.
    // We `cat` stdin into the sentinel file so the watcher sees it change.
    const stopCommand = `cat > ${sentinelPath}`;

    const hooks: Record<string, unknown> = {
      Stop: [
        {
          hooks: [{ type: 'command', command: stopCommand }],
        },
      ],
    };

    // phase 2: team-event hooks are rejected by the current claude CLI
    // settings validator. Only include them when explicitly opted in.
    if (enableTeamEvents) {
      const taskCreatedCommand = `{ printf '{"kind":"TaskCreated","payload":'; cat; printf '}\\n'; } >> ${teamEventPath}`;
      const taskCompletedCommand = `{ printf '{"kind":"TaskCompleted","payload":'; cat; printf '}\\n'; } >> ${teamEventPath}`;
      const agentIdleCommand = `{ printf '{"kind":"TeammateIdle","payload":'; cat; printf '}\\n'; } >> ${teamEventPath}`;

      hooks.TaskCreated = [
        { hooks: [{ type: 'command', command: taskCreatedCommand }] },
      ];
      hooks.TaskCompleted = [
        { hooks: [{ type: 'command', command: taskCompletedCommand }] },
      ];
      hooks.TeammateIdle = [
        { hooks: [{ type: 'command', command: agentIdleCommand }] },
      ];
    }

    // Claude Code 2.1.20x introduced a blocking startup consent dialog for
    // `--dangerously-skip-permissions` ("You accept all responsibility for
    // actions taken while running in Bypass Permissions mode. 1. No, exit /
    // 2. Yes, I accept"). Our PTY driver's waitForReady() sees that dialog's
    // `❯` pointer, types the prompt into it, and the leading keystroke selects
    // the default option "1. No, exit" — so claude quits immediately after the
    // prompt is typed (exit 1), and typePrompt() then crashes on the disposed
    // pty. Setting skipDangerousModePermissionPrompt in the CLI --settings file
    // (loaded as the "flagSettings" source) makes claude's gate return true and
    // suppresses the dialog entirely. Safe here: the whole point of this backend
    // is unattended bypass-permissions execution.
    const settings = { hooks, skipDangerousModePermissionPrompt: true };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    return settingsPath;
  }

  // ── writeMcpConfig ───────────────────────────────────────────────────────

  /**
   * Materialize MCP server definitions for `claude --mcp-config <file>`.
   *
   * These cannot ride along in the --settings file: the CLI reads MCP servers
   * only from --mcp-config / .mcp.json / ~/.claude.json, never from a settings
   * json. Lives in the bridge's temp dir so it is removed by dispose() with
   * everything else.
   */
  async function writeMcpConfig(servers: Record<string, unknown>): Promise<string> {
    // 0600: the server env blocks embed METABOT_API_SECRET in plaintext.
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: servers }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return mcpConfigPath;
  }

  // ── onTurnComplete ───────────────────────────────────────────────────────

  function onTurnComplete(cb: () => void): void {
    turnCb = cb;
    startSentinelWatcher();
  }

  function startSentinelWatcher(): void {
    if (sentinelWatcher || disposed) return;

    // fs.watch fires on file creation/modification.
    // We need to handle the case where the file doesn't exist yet.
    const watchDir = bridgeDir;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    sentinelWatcher = watch(watchDir, (eventType, filename) => {
      if (filename !== 'stop.flag') return;
      // Debounce — fs.watch can fire multiple events for a single write.
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (turnCb && !disposed) {
          turnCb();
        }
      }, 50);
    });

    sentinelWatcher.on('error', () => {
      // Silently ignore watch errors (e.g. dir removed).
    });
  }

  // ── onTeamEvent ──────────────────────────────────────────────────────────

  function onTeamEvent(
    cb: (event: { kind: string; payload: unknown }) => void,
  ): void {
    teamCb = cb;
    startTeamEventTailer();
  }

  function startTeamEventTailer(): void {
    if (teamEventInterval || disposed) return;

    // Poll the team-events JSONL file for new lines (reuse the same
    // byte-offset approach as jsonl-scanner, but simpler inline version).
    teamEventInterval = setInterval(() => {
      if (disposed || !teamCb) return;
      if (!existsSync(teamEventPath)) return;

      let size: number;
      try {
        size = statSync(teamEventPath).size;
      } catch {
        return;
      }
      if (size <= teamEventOffset) return;

      const bytesToRead = size - teamEventOffset;
      const buf = Buffer.alloc(bytesToRead);
      let fd: number | undefined;
      try {
        fd = openSync(teamEventPath, 'r');
        readSync(fd, buf, 0, bytesToRead, teamEventOffset);
      } catch {
        return;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      teamEventOffset = size;

      const lines = buf.toString('utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed) as { kind: string; payload: unknown };
          if (evt.kind && teamCb) {
            teamCb(evt);
          }
        } catch {
          // Malformed line — skip.
        }
      }
    }, 200);
  }

  // ── dispose ──────────────────────────────────────────────────────────────

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;

    if (sentinelWatcher) {
      sentinelWatcher.close();
      sentinelWatcher = null;
    }
    if (teamEventInterval) {
      clearInterval(teamEventInterval);
      teamEventInterval = null;
    }

    // Clean up temp directory.
    try {
      rmSync(bridgeDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  return {
    writeSettings,
    writeMcpConfig,
    onTurnComplete,
    onTeamEvent,
    dispose,
  };
}
