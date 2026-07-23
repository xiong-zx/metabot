import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CardLifecycleStage, CardStatus, ModelTelemetry } from '../types.js';

export interface CardLifecycleRecord {
  lifecycleKey: string;
  botName: string;
  chatId: string;
  messageId?: string;
  source: string;
  teamName?: string;
  instanceId?: string;
  agentName?: string;
  runId?: string;
  taskIds?: number[];
  status: CardStatus;
  lifecycleStage?: CardLifecycleStage;
  userPrompt?: string;
  responsePreview?: string;
  modelTelemetry?: ModelTelemetry;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  checkpointNote?: string;
  checkpointBy?: string;
  checkpointAt?: number;
  restartRequestId?: string;
  finalDeliveredAt?: number;
  finalDeliveryStatus?: 'card' | 'fallback' | 'failed';
  finalDeliveryMessageId?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

const CARD_LIFECYCLE_FILENAME = 'card-lifecycle.json';
const CARD_LIFECYCLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CARD_LIFECYCLE_LEASE_TTL_MS = 15 * 60 * 1000;

function dataDir(): string {
  return process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
}

function storePath(): string {
  return path.join(dataDir(), CARD_LIFECYCLE_FILENAME);
}

function readRecords(): CardLifecycleRecord[] {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCardLifecycleRecord);
  } catch {
    return [];
  }
}

function writeRecords(records: CardLifecycleRecord[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = storePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function isCardLifecycleRecord(value: unknown): value is CardLifecycleRecord {
  const row = value as CardLifecycleRecord;
  return !!row
    && typeof row.lifecycleKey === 'string'
    && typeof row.botName === 'string'
    && typeof row.chatId === 'string'
    && typeof row.source === 'string'
    && (row.teamName === undefined || typeof row.teamName === 'string')
    && (row.instanceId === undefined || typeof row.instanceId === 'string')
    && (row.agentName === undefined || typeof row.agentName === 'string')
    && (row.runId === undefined || typeof row.runId === 'string')
    && (row.taskIds === undefined || Array.isArray(row.taskIds))
    && (row.modelTelemetry === undefined || (typeof row.modelTelemetry === 'object' && row.modelTelemetry !== null))
    && typeof row.status === 'string'
    && (row.leaseOwner === undefined || typeof row.leaseOwner === 'string')
    && (row.leaseExpiresAt === undefined || typeof row.leaseExpiresAt === 'number')
    && (row.checkpointNote === undefined || typeof row.checkpointNote === 'string')
    && (row.checkpointBy === undefined || typeof row.checkpointBy === 'string')
    && (row.checkpointAt === undefined || typeof row.checkpointAt === 'number')
    && (row.restartRequestId === undefined || typeof row.restartRequestId === 'string')
    && (row.finalDeliveredAt === undefined || typeof row.finalDeliveredAt === 'number')
    && (row.finalDeliveryStatus === undefined || row.finalDeliveryStatus === 'card' || row.finalDeliveryStatus === 'fallback' || row.finalDeliveryStatus === 'failed')
    && (row.finalDeliveryMessageId === undefined || typeof row.finalDeliveryMessageId === 'string')
    && typeof row.createdAt === 'number'
    && typeof row.updatedAt === 'number';
}

function isClosedStatus(status: CardStatus): boolean {
  return status === 'complete' || status === 'error' || status === 'agent_activity';
}

export function recordCardLifecycle(input: {
  lifecycleKey?: string;
  botName: string;
  chatId: string;
  messageId?: string;
  source: string;
  teamName?: string;
  instanceId?: string;
  agentName?: string;
  runId?: string;
  taskIds?: number[];
  status: CardStatus;
  lifecycleStage?: CardLifecycleStage;
  userPrompt?: string;
  responseText?: string;
  modelTelemetry?: ModelTelemetry;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  leaseTtlMs?: number;
  checkpointNote?: string;
  checkpointBy?: string;
  checkpointAt?: number;
  restartRequestId?: string;
  finalDeliveryStatus?: 'card' | 'fallback' | 'failed';
  finalDeliveryMessageId?: string;
  now?: number;
}): CardLifecycleRecord | undefined {
  const lifecycleKey = input.lifecycleKey?.trim();
  if (!lifecycleKey) return undefined;

  const now = input.now ?? Date.now();
  const cutoff = now - CARD_LIFECYCLE_TTL_MS;
  const records = readRecords().filter((record) => {
    const timestamp = record.closedAt ?? record.updatedAt;
    return timestamp >= cutoff || record.lifecycleKey === lifecycleKey;
  });
  const existing = records.find((record) => record.lifecycleKey === lifecycleKey);
  const closed = isClosedStatus(input.status) || input.lifecycleStage === 'closed';
  const checkpointNote = input.checkpointNote ?? (input.lifecycleStage === 'checkpointing' ? input.responseText : undefined);
  const checkpointBy = input.checkpointBy ?? (checkpointNote ? input.botName : undefined);
  const checkpointAt = checkpointNote || checkpointBy ? input.checkpointAt ?? now : undefined;
  const leaseOwner = closed
    ? undefined
    : input.leaseOwner ?? existing?.leaseOwner ?? `${input.botName}:${input.chatId}`;
  const leaseExpiresAt = closed
    ? undefined
    : input.leaseExpiresAt ?? (input.leaseTtlMs ? now + input.leaseTtlMs : now + CARD_LIFECYCLE_LEASE_TTL_MS);
  const next: CardLifecycleRecord = {
    lifecycleKey,
    botName: input.botName,
    chatId: input.chatId,
    ...(input.messageId ? { messageId: input.messageId } : existing?.messageId ? { messageId: existing.messageId } : {}),
    source: input.source,
    ...(input.teamName ? { teamName: input.teamName } : existing?.teamName ? { teamName: existing.teamName } : {}),
    ...(input.instanceId ? { instanceId: input.instanceId } : existing?.instanceId ? { instanceId: existing.instanceId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : existing?.agentName ? { agentName: existing.agentName } : {}),
    ...(input.runId ? { runId: input.runId } : existing?.runId ? { runId: existing.runId } : {}),
    ...(input.taskIds ? { taskIds: input.taskIds } : existing?.taskIds ? { taskIds: existing.taskIds } : {}),
    status: input.status,
    ...(input.lifecycleStage ? { lifecycleStage: input.lifecycleStage } : {}),
    ...(input.userPrompt ? { userPrompt: input.userPrompt.slice(0, 500) } : {}),
    ...(input.responseText ? { responsePreview: input.responseText.slice(0, 1000) } : {}),
    ...(input.modelTelemetry
      ? { modelTelemetry: { ...input.modelTelemetry } }
      : existing?.modelTelemetry ? { modelTelemetry: existing.modelTelemetry } : {}),
    ...(leaseOwner ? { leaseOwner } : {}),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
    ...(checkpointNote ? { checkpointNote: checkpointNote.slice(0, 500) } : existing?.checkpointNote ? { checkpointNote: existing.checkpointNote } : {}),
    ...(checkpointBy ? { checkpointBy } : existing?.checkpointBy ? { checkpointBy: existing.checkpointBy } : {}),
    ...(checkpointAt ? { checkpointAt } : existing?.checkpointAt ? { checkpointAt: existing.checkpointAt } : {}),
    ...(input.restartRequestId ? { restartRequestId: input.restartRequestId } : existing?.restartRequestId ? { restartRequestId: existing.restartRequestId } : {}),
    ...(input.finalDeliveryStatus ? { finalDeliveryStatus: input.finalDeliveryStatus, finalDeliveredAt: now } : existing?.finalDeliveryStatus ? { finalDeliveryStatus: existing.finalDeliveryStatus } : {}),
    ...(input.finalDeliveryMessageId ? { finalDeliveryMessageId: input.finalDeliveryMessageId } : existing?.finalDeliveryMessageId ? { finalDeliveryMessageId: existing.finalDeliveryMessageId } : {}),
    ...(input.finalDeliveryStatus ? {} : existing?.finalDeliveredAt ? { finalDeliveredAt: existing.finalDeliveredAt } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(closed
      ? { closedAt: existing?.closedAt ?? now }
      : existing?.closedAt ? { closedAt: existing.closedAt } : {}),
  };

  const withoutExisting = records.filter((record) => record.lifecycleKey !== lifecycleKey);
  withoutExisting.push(next);
  writeRecords(withoutExisting);
  return next;
}

export function getCardLifecycleRecord(lifecycleKey: string): CardLifecycleRecord | undefined {
  return readRecords().find((record) => record.lifecycleKey === lifecycleKey);
}

export function checkpointCardLifecycle(input: {
  lifecycleKey?: string;
  note?: string;
  by?: string;
  restartRequestId?: string;
  now?: number;
}): CardLifecycleRecord | undefined {
  const lifecycleKey = input.lifecycleKey?.trim();
  if (!lifecycleKey) return undefined;
  const existing = getCardLifecycleRecord(lifecycleKey);
  if (!existing) return undefined;
  return recordCardLifecycle({
    lifecycleKey,
    botName: existing.botName,
    chatId: existing.chatId,
    messageId: existing.messageId,
    source: existing.source,
    teamName: existing.teamName,
    instanceId: existing.instanceId,
    agentName: existing.agentName,
    runId: existing.runId,
    taskIds: existing.taskIds,
    status: existing.status,
    lifecycleStage: 'checkpointing',
    userPrompt: existing.userPrompt,
    responseText: existing.responsePreview,
    modelTelemetry: existing.modelTelemetry,
    checkpointNote: input.note,
    checkpointBy: input.by,
    restartRequestId: input.restartRequestId,
    now: input.now,
  });
}

export function listCardLifecycleRecords(): CardLifecycleRecord[] {
  return readRecords();
}
