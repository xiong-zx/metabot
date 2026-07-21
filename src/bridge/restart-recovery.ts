import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BotRegistry } from '../api/bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { recordCardLifecycle } from './card-lifecycle-store.js';
import {
  getServiceRestartRequest,
  markServiceRestartReportSent,
  summarizeServiceRestartReadiness,
} from './restart-coordinator.js';
import { getRestartBreadcrumb, isFreshRestart, restartSecondsAgo, shouldResumeAfterRestart } from './restart-notice.js';

export interface ActiveTaskRecord {
  botName: string;
  chatId: string;
  messageId: string;
  lifecycleKey?: string;
  userPrompt: string;
  startedAt: number;
  updatedAt: number;
  source: 'chat' | 'api';
}

interface RestartRecoveryOutcome {
  botName: string;
  chatId: string;
  messageId: string;
  queuedContinuation: boolean;
}

const ACTIVE_TASKS_FILENAME = 'active-tasks.json';
const ACTIVE_TASK_STALE_MS = 24 * 60 * 60 * 1000;

function dataDir(): string {
  return process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
}

function activeTasksPath(): string {
  return path.join(dataDir(), ACTIVE_TASKS_FILENAME);
}

function readActiveTasks(): ActiveTaskRecord[] {
  try {
    const raw = fs.readFileSync(activeTasksPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isActiveTaskRecord);
  } catch {
    return [];
  }
}

function writeActiveTasks(records: ActiveTaskRecord[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = activeTasksPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function isActiveTaskRecord(value: unknown): value is ActiveTaskRecord {
  const row = value as ActiveTaskRecord;
  return !!row
    && typeof row.botName === 'string'
    && typeof row.chatId === 'string'
    && typeof row.messageId === 'string'
    && (row.lifecycleKey === undefined || typeof row.lifecycleKey === 'string')
    && typeof row.userPrompt === 'string'
    && typeof row.startedAt === 'number'
    && typeof row.updatedAt === 'number'
    && (row.source === 'chat' || row.source === 'api');
}

function taskKey(record: Pick<ActiveTaskRecord, 'botName' | 'chatId' | 'messageId'>): string {
  return `${record.botName}\0${record.chatId}\0${record.messageId}`;
}

function isInternalExecutionChat(chatId: string): boolean {
  return chatId.startsWith('worker-') || chatId.startsWith('team:') || chatId.startsWith('teaminst:');
}

export function recordActiveTask(record: Omit<ActiveTaskRecord, 'updatedAt'>): void {
  const records = readActiveTasks();
  const key = taskKey(record);
  const next = records.filter((item) => taskKey(item) !== key);
  next.push({ ...record, updatedAt: Date.now() });
  writeActiveTasks(next);
}

export function clearActiveTask(input: { botName: string; chatId: string; messageId?: string }): void {
  const records = readActiveTasks();
  const next = records.filter((item) => {
    if (item.botName !== input.botName || item.chatId !== input.chatId) return true;
    if (input.messageId && item.messageId !== input.messageId) return true;
    return false;
  });
  if (next.length !== records.length) writeActiveTasks(next);
}

export function listActiveTaskRecords(): ActiveTaskRecord[] {
  return readActiveTasks();
}

export async function recoverInterruptedTasksAfterRestart(input: {
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
}): Promise<void> {
  const freshRestart = isFreshRestart();
  const breadcrumb = getRestartBreadcrumb();
  const resumeAfterRestart = shouldResumeAfterRestart();
  const now = Date.now();
  const outcomes: RestartRecoveryOutcome[] = [];

  const internalRecords = readActiveTasks().filter((record) => isInternalExecutionChat(record.chatId));
  for (const record of internalRecords) {
    input.logger.info(
      { botName: record.botName, chatId: record.chatId, messageId: record.messageId },
      'restart recovery cleared internal active task record',
    );
    clearActiveTask(record);
  }

  const expiredRecords = readActiveTasks()
    .filter((record) => now - record.updatedAt > ACTIVE_TASK_STALE_MS)
    .filter((record) => !isInternalExecutionChat(record.chatId));
  for (const record of expiredRecords) {
    input.logger.warn(
      { botName: record.botName, chatId: record.chatId, messageId: record.messageId },
      'restart recovery cleared expired active task',
    );
    clearActiveTask(record);
  }

  const records = readActiveTasks()
    .filter((record) => now - record.updatedAt <= ACTIVE_TASK_STALE_MS)
    .filter((record) => !isInternalExecutionChat(record.chatId));

  if (freshRestart && records.length === 0 && breadcrumb?.botName && breadcrumb.chatId) {
    records.push({
      botName: breadcrumb.botName,
      chatId: breadcrumb.chatId,
      messageId: '',
      userPrompt: 'Service restart requested from this chat.',
      startedAt: breadcrumb.restartedAt * 1000,
      updatedAt: now,
      source: 'chat',
    });
  }

  for (const record of records) {
    try {
      const bot = input.registry.get(record.botName);
      if (!bot) {
        input.logger.warn({ botName: record.botName, chatId: record.chatId }, 'restart recovery skipped: bot not found');
        continue;
      }

      const queueContinuation = Boolean(record.messageId) && (freshRestart ? resumeAfterRestart : true);
      const responseText = freshRestart
        ? [
          'MetaBot service restarted successfully.',
          'The previous turn was interrupted by the restart.',
          queueContinuation
            ? 'A continuation turn has been queued so the bot can continue the interrupted work.'
            : 'No continuation turn was queued because there was no recorded in-flight agent turn for this chat.',
        ].join('\n')
        : [
          'MetaBot service restarted without a fresh controlled-restart breadcrumb.',
          'The previous turn was interrupted before it could finish.',
          queueContinuation
            ? 'A recovery continuation has been queued so the bot can continue the interrupted work.'
            : 'No continuation turn was queued because there was no recorded in-flight message for this chat.',
        ].join('\n');

      if (record.messageId) {
        const state: CardState = {
          status: queueContinuation ? 'complete' : 'error',
          userPrompt: record.userPrompt,
          responseText,
          toolCalls: [],
          durationMs: Math.max(0, now - record.startedAt),
          lifecycleKey: record.lifecycleKey,
          lifecycleStage: queueContinuation ? 'recovering' : undefined,
          errorMessage: queueContinuation ? undefined : 'Task interrupted by service restart',
        };
        try {
          await bot.sender.updateCard(record.messageId, state);
          recordCardLifecycle({
            lifecycleKey: record.lifecycleKey,
            botName: record.botName,
            chatId: record.chatId,
            messageId: record.messageId,
            source: 'restart-recovery',
            status: state.status,
            lifecycleStage: state.lifecycleStage,
            userPrompt: state.userPrompt,
            responseText: state.responseText,
            now,
          });
        } catch (err) {
          input.logger.warn(
            { err, botName: record.botName, chatId: record.chatId, messageId: record.messageId },
            'restart recovery card update failed',
          );
        }
      }

      if (freshRestart || queueContinuation) {
        try {
          const noticeBody = queueContinuation
            ? freshRestart
              ? 'Service restart completed. I queued a continuation turn for the interrupted work.'
              : 'Service restarted without a fresh controlled-restart breadcrumb. I queued a recovery continuation for the interrupted work.'
            : 'Service restart completed. No in-flight agent turn was recorded for this chat, so I did not queue a continuation here.';
          await bot.sender.sendTextNotice(
            record.chatId,
            'MetaBot Restart Complete',
            noticeBody,
            'green',
          );
        } catch (err) {
          input.logger.warn({ err, botName: record.botName, chatId: record.chatId }, 'restart recovery notice failed');
        }

        if (queueContinuation) {
          outcomes.push({
            botName: record.botName,
            chatId: record.chatId,
            messageId: record.messageId,
            queuedContinuation: true,
          });
          const label = `restart-resume-${record.chatId}`;
          input.scheduler.scheduleTask({
            botName: record.botName,
            chatId: record.chatId,
            prompt: buildContinuationPrompt(record, freshRestart),
            delaySeconds: 2,
            sendCards: true,
            label,
            dedupeKey: `restart-resume:${record.botName}:${record.chatId}`,
          });
        }
      }
    } catch (err) {
      input.logger.warn(
        { err, botName: record.botName, chatId: record.chatId, messageId: record.messageId },
        'restart recovery failed while finalizing active task',
      );
    } finally {
      clearActiveTask(record);
    }
  }

  if (freshRestart && breadcrumb?.requestId) {
    await sendRestartCoordinationReport({
      requestId: breadcrumb.requestId,
      registry: input.registry,
      logger: input.logger,
      outcomes,
      now,
    });
  }
}

async function sendRestartCoordinationReport(input: {
  requestId: string;
  registry: BotRegistry;
  logger: Logger;
  outcomes: RestartRecoveryOutcome[];
  now: number;
}): Promise<void> {
  const record = getServiceRestartRequest(input.requestId);
  if (!record || record.reportedAt) return;
  const summary = summarizeServiceRestartReadiness(record, record.blockers, input.now);
  const continuationCount = input.outcomes.filter((outcome) => outcome.queuedContinuation).length;
  const targetMap = new Map<string, { botName: string; chatId: string; role: 'requester' | 'blocker' }>();
  targetMap.set(`${record.requesterBotName}\0${record.requesterChatId}`, {
    botName: record.requesterBotName,
    chatId: record.requesterChatId,
    role: 'requester',
  });
  for (const blocker of record.blockers) {
    targetMap.set(`${blocker.botName}\0${blocker.chatId}`, {
      botName: blocker.botName,
      chatId: blocker.chatId,
      role: 'blocker',
    });
  }

  const lines = [
    `Restart request \`${record.requestId}\` completed after service reconnect.`,
    `Status: ${record.status}${record.force ? ' (forced)' : ''}.`,
    record.reason ? `Reason: ${record.reason}` : '',
    `Readiness before restart: ready=${summary.ready}/${summary.total}${summary.pending > 0 ? `, pending=${summary.pending}` : ''}${summary.timedOut || record.status === 'timed_out' ? ', timed_out=true' : ''}.`,
    `Recovery continuations queued: ${continuationCount}.`,
    record.blockers.length > 0
      ? `Affected blocker chats: ${record.blockers.map((blocker) => `${blocker.botName}/${blocker.chatId}`).join(', ')}.`
      : 'Affected blocker chats: none.',
  ].filter(Boolean);

  let sent = 0;
  for (const target of targetMap.values()) {
    const bot = input.registry.get(target.botName);
    if (!bot) {
      input.logger.warn({ requestId: record.requestId, botName: target.botName, chatId: target.chatId }, 'restart report skipped: bot not found');
      continue;
    }
    try {
      await bot.sender.sendTextNotice(
        target.chatId,
        target.role === 'requester' ? 'MetaBot Restart Report' : 'MetaBot Restart Recovery Report',
        lines.join('\n'),
        record.status === 'forced' ? 'orange' : 'green',
      );
      sent += 1;
    } catch (err) {
      input.logger.warn({ err, requestId: record.requestId, botName: target.botName, chatId: target.chatId }, 'restart report notice failed');
    }
  }
  if (sent > 0) markServiceRestartReportSent({ requestId: record.requestId, now: input.now });
}

function buildContinuationPrompt(record: ActiveTaskRecord, controlledRestart: boolean): string {
  const secs = restartSecondsAgo();
  const previous = record.userPrompt.length > 1200
    ? `${record.userPrompt.slice(0, 1197)}...`
    : record.userPrompt;
  const restartLine = controlledRestart
    ? `MetaBot bridge was restarted successfully about ${secs} seconds ago. Your previous turn was interrupted by that planned restart.`
    : 'MetaBot bridge restarted while your previous turn was still recorded as active. The restart did not leave a fresh controlled-restart breadcrumb, so this is a recovery continuation.';
  return [
    '<system-reminder>',
    restartLine,
    'Do not run metabot restart or metabot update again merely to satisfy the previous interrupted request.',
    'If the user sends a new explicit request to restart or update after recovery, treat it as a new request.',
    'First tell the user the service restart completed, then continue any remaining work from the interrupted turn.',
    'If the only remaining work was restarting the service, report completion and stop.',
    '',
    'Interrupted user prompt:',
    previous,
    '</system-reminder>',
  ].join('\n');
}
