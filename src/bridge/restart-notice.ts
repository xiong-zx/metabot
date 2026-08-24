import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RestartStore,
  assertRestartRequestId,
  resolveRestartStateDir,
  restartStatePath,
  type RestartKind,
} from '../runtime/restart-store.js';

/** Durable pointer from the old Bridge process to the new one. */
export interface RestartBreadcrumb {
  version: 1;
  restartedAt: number;
  requestId: string;
  kind: RestartKind;
  botName?: string;
  chatId?: string;
  source?: string;
  reason?: string;
  resume: boolean;
  targetRoot: string;
}

const BREADCRUMB_FILENAME = 'last-restart.json';
const RESTART_WINDOW_MS = 15 * 60 * 1000;

let restartBreadcrumb: RestartBreadcrumb | undefined;
let restartedAtMs: number | undefined;
const remindedChats = new Set<string>();

function breadcrumbPath(): string {
  return path.join(resolveRestartStateDir(), BREADCRUMB_FILENAME);
}

export function writeRestartBreadcrumb(
  input: Omit<RestartBreadcrumb, 'version' | 'restartedAt'> & { restartedAt?: number },
): string {
  assertRestartRequestId(input.requestId);
  if (input.kind !== 'restart' && input.kind !== 'deploy') throw new Error('Invalid restart breadcrumb kind');
  if (!path.isAbsolute(input.targetRoot)) throw new Error('Restart breadcrumb targetRoot must be absolute');
  const file = breadcrumbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const data: RestartBreadcrumb = {
    version: 1,
    restartedAt: input.restartedAt ?? Math.floor(Date.now() / 1000),
    requestId: input.requestId,
    kind: input.kind,
    ...(input.botName?.trim() ? { botName: input.botName.trim().slice(0, 1_000) } : {}),
    ...(input.chatId?.trim() ? { chatId: input.chatId.trim().slice(0, 1_000) } : {}),
    ...(input.source?.trim() ? { source: input.source.trim().slice(0, 1_000) } : {}),
    ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 1_000) } : {}),
    resume: input.resume,
    targetRoot: path.resolve(input.targetRoot),
  };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}

/** Load but retain the breadcrumb until startup finalization and recovery finish. */
export function loadRestartBreadcrumb(): RestartBreadcrumb | undefined {
  restartBreadcrumb = undefined;
  restartedAtMs = undefined;
  const file = breadcrumbPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RestartBreadcrumb>;
    if (!isRestartBreadcrumb(parsed)) {
      fs.rmSync(file, { force: true });
      return undefined;
    }
    restartBreadcrumb = parsed;
    restartedAtMs = parsed.restartedAt * 1000;
    if (!isFreshRestart()) {
      const pending = hasPendingDurableRecovery(parsed.requestId);
      if (pending === true) {
        restartedAtMs = Date.now();
      } else {
        if (pending === false) fs.rmSync(file, { force: true });
        restartBreadcrumb = undefined;
        restartedAtMs = undefined;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') fs.rmSync(file, { force: true });
  }
  return restartBreadcrumb;
}

function hasPendingDurableRecovery(requestId: string): boolean | undefined {
  if (!fs.existsSync(restartStatePath())) return false;
  let store: RestartStore | undefined;
  try {
    store = new RestartStore();
    const record = store.get(requestId);
    return Boolean(record && !record.continuationDecidedAt);
  } catch {
    // Keep the file when the ledger is temporarily unreadable. A later startup
    // can retry without turning a storage outage into permanent task loss.
    return undefined;
  } finally {
    store?.close();
  }
}

/** Clear only the breadcrumb for the expected request, never a newer request. */
export function clearRestartBreadcrumb(expectedRequestId?: string): void {
  const file = breadcrumbPath();
  if (expectedRequestId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RestartBreadcrumb>;
      if (parsed.requestId !== expectedRequestId) return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      return;
    }
  }
  fs.rmSync(file, { force: true });
  if (!expectedRequestId || restartBreadcrumb?.requestId === expectedRequestId) {
    restartBreadcrumb = undefined;
    restartedAtMs = undefined;
  }
}

export function getRestartBreadcrumb(): RestartBreadcrumb | undefined {
  return isFreshRestart() ? restartBreadcrumb : undefined;
}

export function isFreshRestart(now = Date.now()): boolean {
  return restartedAtMs !== undefined
    && now >= restartedAtMs
    && now - restartedAtMs <= RESTART_WINDOW_MS;
}

export function shouldRemindRestart(chatId: string): boolean {
  return isFreshRestart()
    && restartBreadcrumb?.resume !== false
    && !remindedChats.has(chatId);
}

export function markReminded(chatId: string): void {
  remindedChats.add(chatId);
}

export function restartSecondsAgo(): number {
  if (restartedAtMs === undefined) return 0;
  return Math.max(0, Math.round((Date.now() - restartedAtMs) / 1000));
}

function isRestartBreadcrumb(value: Partial<RestartBreadcrumb>): value is RestartBreadcrumb {
  try {
    if (value.version !== 1
      || typeof value.restartedAt !== 'number'
      || !Number.isFinite(value.restartedAt)
      || typeof value.requestId !== 'string'
      || (value.kind !== 'restart' && value.kind !== 'deploy')
      || typeof value.resume !== 'boolean'
      || typeof value.targetRoot !== 'string'
      || !path.isAbsolute(value.targetRoot)) return false;
    assertRestartRequestId(value.requestId);
    return true;
  } catch {
    return false;
  }
}
