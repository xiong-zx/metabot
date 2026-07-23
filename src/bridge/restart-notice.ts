import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Restart breadcrumb + one-shot reminder.
 *
 * `pm2 restart` kills the whole node process — including every Claude session —
 * and respawns it. The agent that ran `metabot restart` therefore loses all
 * memory of having done so; when the next message arrives the session resumes
 * with "please restart" still in its history and the agent restarts again, in a
 * loop. To break it, `bin/metabot` writes a timestamp breadcrumb just before
 * `pm2 restart`; we load it at boot, retain it until startup health and
 * recovery complete, then inject a one-shot `<system-reminder>` into the first
 * turn of each chat telling the agent the restart already happened.
 */

const BREADCRUMB_FILENAME = 'last-restart.json';
// Only treat the breadcrumb as a "fresh restart" within this window. Guards
// against a stale file (e.g. a crash where boot never ran to delete it) firing
// the reminder days later on an unrelated start.
const RESTART_WINDOW_MS = 15 * 60 * 1000;

export interface RestartBreadcrumb {
  restartedAt: number;
  botName?: string;
  chatId?: string;
  reason?: string;
  source?: string;
  requestId?: string;
  /** Whether restart recovery should schedule an agent continuation turn. */
  resume?: boolean;
}

let restartBreadcrumb: RestartBreadcrumb | undefined;
let restartedAtMs: number | undefined;
const remindedChats = new Set<string>();

function breadcrumbPath(): string {
  const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
  return path.join(dir, BREADCRUMB_FILENAME);
}

export function writeRestartBreadcrumb(input: Omit<RestartBreadcrumb, 'restartedAt'> & { restartedAt?: number }): string {
  const file = breadcrumbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data: RestartBreadcrumb = {
    restartedAt: input.restartedAt ?? Math.floor(Date.now() / 1000),
    ...(input.botName ? { botName: input.botName } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Read the restart breadcrumb at boot and stash the timestamp in memory. The
 * file is intentionally kept until startup health and recovery complete, so a
 * crash during boot can retry the same request instead of losing its audit
 * trail. Call once during bridge startup. Safe when no breadcrumb exists.
 */
export function loadRestartBreadcrumb(): void {
  const file = breadcrumbPath();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as RestartBreadcrumb;
    if (typeof parsed.restartedAt === 'number') {
      restartBreadcrumb = {
        restartedAt: parsed.restartedAt,
        ...(typeof parsed.botName === 'string' && parsed.botName ? { botName: parsed.botName } : {}),
        ...(typeof parsed.chatId === 'string' && parsed.chatId ? { chatId: parsed.chatId } : {}),
        ...(typeof parsed.reason === 'string' && parsed.reason ? { reason: parsed.reason } : {}),
        ...(typeof parsed.source === 'string' && parsed.source ? { source: parsed.source } : {}),
        ...(typeof parsed.requestId === 'string' && parsed.requestId ? { requestId: parsed.requestId } : {}),
        ...(typeof parsed.resume === 'boolean' ? { resume: parsed.resume } : {}),
      };
      restartedAtMs = parsed.restartedAt * 1000; // breadcrumb stores epoch seconds
    }
  } catch {
    /* missing/unreadable — nothing to do */
  }
}

/** Clear a breadcrumb only after startup health and recovery have completed. */
export function clearRestartBreadcrumb(): void {
  const file = breadcrumbPath();
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** True if we should inject the restart reminder for this chat's next turn. */
export function shouldRemindRestart(chatId: string): boolean {
  if (!isFreshRestart()) return false;
  if (restartBreadcrumb?.resume === false) return false;
  return !remindedChats.has(chatId);
}

/** Mark a chat as having received the restart reminder (one-shot per chat). */
export function markReminded(chatId: string): void {
  remindedChats.add(chatId);
}

/** Whole seconds since the recorded restart (0 if unknown). */
export function restartSecondsAgo(): number {
  if (restartedAtMs === undefined) return 0;
  return Math.max(0, Math.round((Date.now() - restartedAtMs) / 1000));
}

export function isFreshRestart(): boolean {
  return restartedAtMs !== undefined && Date.now() - restartedAtMs <= RESTART_WINDOW_MS;
}

export function getRestartBreadcrumb(): RestartBreadcrumb | undefined {
  if (!isFreshRestart()) return undefined;
  return restartBreadcrumb;
}

export function shouldResumeAfterRestart(): boolean {
  return isFreshRestart() && restartBreadcrumb?.resume !== false;
}
