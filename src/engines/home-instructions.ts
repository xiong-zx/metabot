/**
 * METABOT_HOME project rules → system prompt.
 *
 * `$METABOT_HOME/CLAUDE.md` (with `AGENTS.md` as a symlink to it) is MetaBot's
 * only cross-host channel for project rules: MetaMemory is per-server and not
 * shared, so the file checked into the runtime directory is what every bot on
 * that machine is supposed to obey.
 *
 * The agent engines only auto-load `CLAUDE.md` / `AGENTS.md` by walking *up*
 * from the session cwd. A bot whose working directory lives outside
 * METABOT_HOME (the common case — e.g. cwd is the repo's parent directory)
 * therefore never sees those rules. This module reads the file at spawn time
 * and hands it back as a system-prompt section, which is both cwd-independent
 * and engine-independent.
 *
 * Deliberately NOT part of `buildPmSystemPrompt`: that one is gated behind
 * `pmPrompt: true` in all four executors, and these rules apply to every bot.
 */
import fs from 'node:fs';
import path from 'node:path';

/** File inside METABOT_HOME that holds the host's project rules. */
export const HOME_INSTRUCTIONS_FILENAME = 'CLAUDE.md';

/**
 * Cap on the injected body. The repo's own CLAUDE.md is ~26 KB, so 128 KiB
 * leaves generous headroom while keeping a pathological file (a stray log,
 * a committed dump) from eating the context window. Oversized files are
 * truncated with an explicit marker rather than dropped — partial rules beat
 * no rules, and the marker tells the model to go read the file itself.
 */
export const HOME_INSTRUCTIONS_MAX_BYTES = 128 * 1024;

export interface HomeInstructionsLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface HomeInstructionsOptions {
  /** Session working directory. Injection is skipped when it sits inside METABOT_HOME. */
  cwd: string;
  /**
   * Runtime directory. Defaults to the repo-wide convention
   * `process.env.METABOT_HOME || process.cwd()` (see bridge/restart-recovery.ts).
   */
  metabotHome?: string;
  logger?: HomeInstructionsLogger;
}

/**
 * Resolve to a canonical absolute path. `realpathSync` matters because cwd and
 * METABOT_HOME are frequently reached through symlinks (macOS `/tmp` →
 * `/private/tmp`, deploy-runtime symlinks); comparing un-canonicalized paths
 * would miss a containment that is real. Falls back to `path.resolve` when the
 * path does not exist yet.
 */
function canonicalize(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * True when `child` is `parent` itself or lives underneath it.
 *
 * The `path.sep` guard is what keeps `/root/metabot-foo` from being read as
 * "inside `/root/metabot`" — a plain `startsWith` would get that wrong.
 */
export function isInsideDirectory(child: string, parent: string): boolean {
  const c = canonicalize(child);
  const p = canonicalize(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Runtime directory, following the repo-wide `METABOT_HOME || cwd` convention. */
export function resolveMetabotHome(explicit?: string): string {
  return path.resolve(explicit || process.env.METABOT_HOME || process.cwd());
}

/**
 * Build the system-prompt section carrying `$METABOT_HOME/CLAUDE.md`.
 *
 * Returns `undefined` (never throws) when there is nothing to inject:
 *   - the session cwd is already inside METABOT_HOME, so the engine's own
 *     CLAUDE.md/AGENTS.md auto-load already covers these rules;
 *   - the file is missing / unreadable / empty.
 * Failing to read host instructions must never stop a session from starting.
 */
export function buildHomeInstructionsSection(options: HomeInstructionsOptions): string | undefined {
  const { cwd, logger } = options;
  const metabotHome = resolveMetabotHome(options.metabotHome);
  const instructionsPath = path.join(metabotHome, HOME_INSTRUCTIONS_FILENAME);

  try {
    if (cwd && isInsideDirectory(cwd, metabotHome)) {
      logger?.debug(
        { cwd, metabotHome },
        'Skipping METABOT_HOME instructions injection — cwd is inside METABOT_HOME (engine auto-loads them)',
      );
      return undefined;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(instructionsPath, 'utf-8');
    } catch (err) {
      logger?.debug(
        { instructionsPath, err },
        'No readable METABOT_HOME instructions file — skipping injection',
      );
      return undefined;
    }

    if (!raw.trim()) {
      logger?.debug({ instructionsPath }, 'METABOT_HOME instructions file is empty — skipping injection');
      return undefined;
    }

    let body = raw;
    const bytes = Buffer.byteLength(raw, 'utf-8');
    if (bytes > HOME_INSTRUCTIONS_MAX_BYTES) {
      body =
        Buffer.from(raw, 'utf-8').subarray(0, HOME_INSTRUCTIONS_MAX_BYTES).toString('utf-8') +
        `\n\n[... truncated: ${instructionsPath} is ${bytes} bytes, injected the first ${HOME_INSTRUCTIONS_MAX_BYTES}. Read the file directly for the rest.]`;
      logger?.warn(
        { instructionsPath, bytes, limit: HOME_INSTRUCTIONS_MAX_BYTES },
        'METABOT_HOME instructions file exceeds the injection limit — truncating',
      );
    }

    logger?.debug({ instructionsPath, bytes }, 'Injecting METABOT_HOME instructions into the system prompt');

    return [
      '## MetaBot Host Instructions (project rules for this machine)',
      '',
      `Source: \`${instructionsPath}\` (METABOT_HOME = \`${metabotHome}\`).`,
      '',
      'These are the project rules for the MetaBot runtime directory on THIS machine.',
      `Your working directory (\`${cwd}\`) is outside METABOT_HOME, so the agent engine did not`,
      'auto-load them. They still apply to you — treat them exactly like a CLAUDE.md / AGENTS.md',
      'found in your own working directory. Rules from your own working directory win on conflict.',
      '',
      '---',
      '',
      body.trimEnd(),
    ].join('\n');
  } catch (err) {
    // Belt-and-braces: nothing in this path is worth failing a session over.
    logger?.warn({ err, instructionsPath }, 'Failed to build METABOT_HOME instructions section — skipping');
    return undefined;
  }
}
