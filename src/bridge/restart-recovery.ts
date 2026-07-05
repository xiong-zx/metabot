import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BotRegistry } from '../api/bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { getRestartBreadcrumb, isFreshRestart, restartSecondsAgo } from './restart-notice.js';

export interface ActiveTaskRecord {
  botName: string;
  chatId: string;
  messageId: string;
  userPrompt: string;
  startedAt: number;
  updatedAt: number;
  source: 'chat' | 'api';
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
    && typeof row.userPrompt === 'string'
    && typeof row.startedAt === 'number'
    && typeof row.updatedAt === 'number'
    && (row.source === 'chat' || row.source === 'api');
}

function taskKey(record: Pick<ActiveTaskRecord, 'botName' | 'chatId' | 'messageId'>): string {
  return `${record.botName}\0${record.chatId}\0${record.messageId}`;
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
  const now = Date.now();
  const expiredRecords = readActiveTasks()
    .filter((record) => now - record.updatedAt > ACTIVE_TASK_STALE_MS)
    .filter((record) => !record.chatId.startsWith('worker-') && !record.chatId.startsWith('team:'));
  for (const record of expiredRecords) {
    input.logger.warn(
      { botName: record.botName, chatId: record.chatId, messageId: record.messageId },
      'restart recovery cleared expired active task',
    );
    clearActiveTask(record);
  }

  const records = readActiveTasks()
    .filter((record) => now - record.updatedAt <= ACTIVE_TASK_STALE_MS)
    .filter((record) => !record.chatId.startsWith('worker-') && !record.chatId.startsWith('team:'));

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

      const responseText = freshRestart
        ? [
          'MetaBot service restarted successfully.',
          'The previous turn was interrupted by the restart.',
          'A continuation turn has been queued so the bot can continue the interrupted work.',
        ].join('\n')
        : [
          'MetaBot service restarted.',
          'The previous turn was interrupted before it could finish.',
          'It was not resumed automatically; please resend the request if it still matters.',
        ].join('\n');

      if (record.messageId) {
        const state: CardState = {
          status: freshRestart ? 'complete' : 'error',
          userPrompt: record.userPrompt,
          responseText,
          toolCalls: [],
          durationMs: Math.max(0, now - record.startedAt),
          errorMessage: freshRestart ? undefined : 'Task interrupted by service restart',
        };
        try {
          await bot.sender.updateCard(record.messageId, state);
        } catch (err) {
          input.logger.warn(
            { err, botName: record.botName, chatId: record.chatId, messageId: record.messageId },
            'restart recovery card update failed',
          );
        }
      }

      if (freshRestart) {
        try {
          await bot.sender.sendTextNotice(
            record.chatId,
            'MetaBot Restart Complete',
            'Service restart completed. I queued a continuation turn for the interrupted work.',
            'green',
          );
        } catch (err) {
          input.logger.warn({ err, botName: record.botName, chatId: record.chatId }, 'restart recovery notice failed');
        }

        input.scheduler.scheduleTask({
          botName: record.botName,
          chatId: record.chatId,
          prompt: buildContinuationPrompt(record),
          delaySeconds: 2,
          sendCards: true,
          label: `restart-resume-${record.chatId}`,
        });
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
}

function buildContinuationPrompt(record: ActiveTaskRecord): string {
  const secs = restartSecondsAgo();
  const previous = record.userPrompt.length > 1200
    ? `${record.userPrompt.slice(0, 1197)}...`
    : record.userPrompt;
  return [
    '<system-reminder>',
    `MetaBot bridge was restarted successfully about ${secs} seconds ago. Your previous turn was interrupted by that planned restart.`,
    'Do not run metabot restart or metabot update again for the previous request.',
    'First tell the user the service restart completed, then continue any remaining work from the interrupted turn.',
    'If the only remaining work was restarting the service, report completion and stop.',
    '',
    'Interrupted user prompt:',
    previous,
    '</system-reminder>',
  ].join('\n');
}
