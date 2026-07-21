import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServiceRestartBlocker, ServiceRestartRequest } from './command-handler.js';
import type { ActiveTaskRecord } from './restart-recovery.js';
import { checkpointCardLifecycle } from './card-lifecycle-store.js';

export type RestartCoordinationStatus = 'blocked' | 'scheduled' | 'forced' | 'timed_out';

export interface RestartCoordinationRecord {
  requestId: string;
  requesterBotName: string;
  requesterChatId: string;
  userId: string;
  reason?: string;
  force: boolean;
  status: RestartCoordinationStatus;
  blockers: ServiceRestartBlocker[];
  readiness: RestartReadinessAck[];
  createdAt: number;
  updatedAt: number;
  timeoutMs?: number;
  deadlineAt?: number;
  scheduledAt?: number;
  timedOutAt?: number;
  reportedAt?: number;
}

export interface RestartReadinessAck {
  botName: string;
  chatId: string;
  userId: string;
  status: 'ready' | 'blocked';
  note?: string;
  acknowledgedAt: number;
}

export interface RestartReadinessSummary {
  total: number;
  ready: number;
  blocked: number;
  pending: number;
  allReady: boolean;
  pendingBlockers: ServiceRestartBlocker[];
  readyBlockers: ServiceRestartBlocker[];
  blockedAcks: RestartReadinessAck[];
  timedOut: boolean;
  deadlineAt?: number;
  remainingMs?: number;
}

const RESTART_REQUESTS_FILENAME = 'restart-requests.json';
const RESTART_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_RESTART_READY_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveRestartReadyTimeoutMs(value = process.env.METABOT_RESTART_READY_TIMEOUT_MS): number {
  if (!value) return DEFAULT_RESTART_READY_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESTART_READY_TIMEOUT_MS;
  return Math.max(1_000, Math.floor(parsed));
}

export function collectServiceRestartBlockers(input: {
  request: ServiceRestartRequest;
  requesterBotName: string;
  activeTasks: ActiveTaskRecord[];
  now?: number;
}): ServiceRestartBlocker[] {
  const now = input.now ?? Date.now();
  return input.activeTasks
    .filter((record) => !(record.botName === input.requesterBotName && record.chatId === input.request.chatId))
    .map((record) => ({
      botName: record.botName,
      chatId: record.chatId,
      messageId: record.messageId || undefined,
      lifecycleKey: record.lifecycleKey || undefined,
      source: record.source,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      userPrompt: record.userPrompt,
    }))
    .sort((a, b) => (a.startedAt || now) - (b.startedAt || now));
}

export function recordServiceRestartRequest(input: {
  requestId: string;
  requesterBotName: string;
  request: ServiceRestartRequest;
  status: RestartCoordinationStatus;
  blockers?: ServiceRestartBlocker[];
  timeoutMs?: number;
  now?: number;
}): RestartCoordinationRecord {
  const now = input.now ?? Date.now();
  const cutoff = now - RESTART_REQUEST_TTL_MS;
  const records = readRestartRequests().filter((record) => record.updatedAt >= cutoff || record.requestId === input.requestId);
  const existing = records.find((record) => record.requestId === input.requestId);
  const blockers = input.blockers ?? existing?.blockers ?? [];
  const timeoutMs = input.timeoutMs ?? existing?.timeoutMs ?? resolveRestartReadyTimeoutMs();
  const needsDeadline = input.status === 'blocked' || input.status === 'timed_out';
  const next: RestartCoordinationRecord = {
    requestId: input.requestId,
    requesterBotName: input.requesterBotName,
    requesterChatId: input.request.chatId,
    userId: input.request.userId,
    ...(input.request.reason ? { reason: input.request.reason } : existing?.reason ? { reason: existing.reason } : {}),
    force: input.request.force === true,
    status: input.status,
    blockers,
    readiness: existing?.readiness || [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(needsDeadline
      ? {
        timeoutMs,
        deadlineAt: existing?.deadlineAt ?? now + timeoutMs,
      }
      : existing?.deadlineAt ? { deadlineAt: existing.deadlineAt } : {}),
    ...(input.status === 'scheduled' || input.status === 'forced'
      ? { scheduledAt: existing?.scheduledAt ?? now }
      : existing?.scheduledAt ? { scheduledAt: existing.scheduledAt } : {}),
    ...(input.status === 'timed_out'
      ? { timedOutAt: existing?.timedOutAt ?? now }
      : existing?.timedOutAt ? { timedOutAt: existing.timedOutAt } : {}),
    ...(existing?.reportedAt ? { reportedAt: existing.reportedAt } : {}),
  };

  const withoutExisting = records.filter((record) => record.requestId !== input.requestId);
  withoutExisting.push(next);
  writeRestartRequests(withoutExisting);
  return next;
}

export function markServiceRestartReportSent(input: {
  requestId: string;
  now?: number;
}): RestartCoordinationRecord | undefined {
  const records = readRestartRequests();
  const existing = records.find((record) => record.requestId === input.requestId);
  if (!existing) return undefined;
  const now = input.now ?? Date.now();
  const next: RestartCoordinationRecord = {
    ...existing,
    reportedAt: existing.reportedAt ?? now,
    updatedAt: now,
  };
  writeRestartRequests(records.map((record) => record.requestId === input.requestId ? next : record));
  return next;
}

export function markServiceRestartRequestTimedOut(input: {
  requestId: string;
  now?: number;
}): RestartCoordinationRecord | undefined {
  const records = readRestartRequests();
  const existing = records.find((record) => record.requestId === input.requestId);
  if (!existing) return undefined;
  const now = input.now ?? Date.now();
  const next: RestartCoordinationRecord = {
    ...existing,
    status: 'timed_out',
    timedOutAt: existing.timedOutAt ?? now,
    updatedAt: now,
  };
  writeRestartRequests(records.map((record) => record.requestId === input.requestId ? next : record));
  return next;
}

export function expireTimedOutServiceRestartRequests(now = Date.now()): RestartCoordinationRecord[] {
  const records = readRestartRequests();
  let changed = false;
  const nextRecords = records.map((record) => {
    if (record.status !== 'blocked') return record;
    const deadlineAt = record.deadlineAt ?? record.createdAt + (record.timeoutMs ?? resolveRestartReadyTimeoutMs());
    const summary = summarizeServiceRestartReadiness({ ...record, deadlineAt }, record.blockers, now);
    if (!summary.timedOut) return record;
    changed = true;
    return {
      ...record,
      status: 'timed_out' as const,
      timeoutMs: record.timeoutMs ?? resolveRestartReadyTimeoutMs(),
      deadlineAt,
      timedOutAt: record.timedOutAt ?? now,
      updatedAt: now,
    };
  });
  if (changed) writeRestartRequests(nextRecords);
  return nextRecords;
}

export function recordServiceRestartReadiness(input: {
  requestId: string;
  botName: string;
  chatId: string;
  userId: string;
  status?: RestartReadinessAck['status'];
  note?: string;
  now?: number;
}): RestartCoordinationRecord | undefined {
  const records = readRestartRequests();
  const existing = records.find((record) => record.requestId === input.requestId);
  if (!existing) return undefined;
  const now = input.now ?? Date.now();
  const ack: RestartReadinessAck = {
    botName: input.botName,
    chatId: input.chatId,
    userId: input.userId,
    status: input.status || 'ready',
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
    acknowledgedAt: now,
  };
  const next: RestartCoordinationRecord = {
    ...existing,
    readiness: [
      ...(existing.readiness || []).filter((item) => !(item.botName === input.botName && item.chatId === input.chatId)),
      ack,
    ].sort((a, b) => a.acknowledgedAt - b.acknowledgedAt),
    updatedAt: now,
  };
  writeRestartRequests(records.map((record) => record.requestId === input.requestId ? next : record));
  const blocker = existing.blockers.find((item) => item.botName === input.botName && item.chatId === input.chatId);
  if (blocker?.lifecycleKey) {
    checkpointCardLifecycle({
      lifecycleKey: blocker.lifecycleKey,
      note: input.note || `Ready for controlled restart ${input.requestId}.`,
      by: input.botName,
      restartRequestId: input.requestId,
      now,
    });
  }
  return next;
}

export function summarizeServiceRestartReadiness(
  record: Pick<RestartCoordinationRecord, 'blockers' | 'readiness'> & Partial<Pick<RestartCoordinationRecord, 'deadlineAt'>>,
  blockers: ServiceRestartBlocker[] = record.blockers,
  now = Date.now(),
): RestartReadinessSummary {
  const readinessByBlocker = new Map((record.readiness || []).map((ack) => [restartParticipantKey(ack), ack]));
  const readyBlockers: ServiceRestartBlocker[] = [];
  const pendingBlockers: ServiceRestartBlocker[] = [];
  const blockedAcks: RestartReadinessAck[] = [];

  for (const blocker of blockers) {
    const ack = readinessByBlocker.get(restartParticipantKey(blocker));
    if (ack?.status === 'ready') {
      readyBlockers.push(blocker);
      continue;
    }
    pendingBlockers.push(blocker);
    if (ack?.status === 'blocked') blockedAcks.push(ack);
  }
  const deadlineAt = record.deadlineAt;
  const remainingMs = typeof deadlineAt === 'number' ? Math.max(0, deadlineAt - now) : undefined;
  const timedOut = pendingBlockers.length > 0 && typeof deadlineAt === 'number' && now >= deadlineAt;

  return {
    total: blockers.length,
    ready: readyBlockers.length,
    blocked: blockedAcks.length,
    pending: pendingBlockers.length,
    allReady: blockers.length > 0 && pendingBlockers.length === 0,
    pendingBlockers,
    readyBlockers,
    blockedAcks,
    timedOut,
    ...(typeof deadlineAt === 'number' ? { deadlineAt } : {}),
    ...(typeof remainingMs === 'number' ? { remainingMs } : {}),
  };
}

export function findReusableServiceRestartRequest(input: {
  requesterBotName: string;
  request: ServiceRestartRequest;
  now?: number;
}): RestartCoordinationRecord | undefined {
  const now = input.now ?? Date.now();
  const cutoff = now - RESTART_REQUEST_TTL_MS;
  return readRestartRequests()
    .filter((record) => record.status === 'blocked' || record.status === 'timed_out')
    .filter((record) => record.updatedAt >= cutoff)
    .filter((record) => record.requesterBotName === input.requesterBotName)
    .filter((record) => record.requesterChatId === input.request.chatId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function getServiceRestartRequest(requestId: string): RestartCoordinationRecord | undefined {
  return readRestartRequests().find((record) => record.requestId === requestId);
}

export function listServiceRestartRequests(): RestartCoordinationRecord[] {
  return readRestartRequests();
}

function dataDir(): string {
  return process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
}

function restartRequestsPath(): string {
  return path.join(dataDir(), RESTART_REQUESTS_FILENAME);
}

function restartParticipantKey(input: Pick<ServiceRestartBlocker | RestartReadinessAck, 'botName' | 'chatId'>): string {
  return `${input.botName}\0${input.chatId}`;
}

function readRestartRequests(): RestartCoordinationRecord[] {
  try {
    const raw = fs.readFileSync(restartRequestsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRestartCoordinationRecord).map((record) => ({
      ...record,
      readiness: record.readiness || [],
    }));
  } catch {
    return [];
  }
}

function writeRestartRequests(records: RestartCoordinationRecord[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = restartRequestsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function isRestartCoordinationRecord(value: unknown): value is RestartCoordinationRecord {
  const row = value as RestartCoordinationRecord;
  return !!row
    && typeof row.requestId === 'string'
    && typeof row.requesterBotName === 'string'
    && typeof row.requesterChatId === 'string'
    && typeof row.userId === 'string'
    && typeof row.force === 'boolean'
    && (row.status === 'blocked' || row.status === 'scheduled' || row.status === 'forced' || row.status === 'timed_out')
    && Array.isArray(row.blockers)
    && (row.readiness === undefined || Array.isArray(row.readiness))
    && typeof row.createdAt === 'number'
    && typeof row.updatedAt === 'number'
    && (row.timeoutMs === undefined || typeof row.timeoutMs === 'number')
    && (row.deadlineAt === undefined || typeof row.deadlineAt === 'number')
    && (row.scheduledAt === undefined || typeof row.scheduledAt === 'number')
    && (row.timedOutAt === undefined || typeof row.timedOutAt === 'number')
    && (row.reportedAt === undefined || typeof row.reportedAt === 'number');
}
