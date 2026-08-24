/**
 * In-memory store for async task status.
 *
 * When /api/talk receives `async: true`, the task is executed in the background
 * and this store tracks its lifecycle (accepted → running → completed/failed).
 * Completed tasks are automatically cleaned up after 1 hour.
 */

import * as crypto from 'node:crypto';
import type { ApiTaskResult } from '../bridge/message-bridge.js';

export interface AsyncTask {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  /** Signed engine session that created this task, when delegated over Agent Bus talk. */
  sourceBotName?: string;
  sourceChatId?: string;
  /** Target-chat delivery receipt. The message id exists only after a real card was created. */
  cardMessageId?: string;
  deliveryState?: 'accepted' | 'pending' | 'running' | 'complete' | 'error';
  createdAt: number;
  completedAt?: number;
  result?: Pick<
    ApiTaskResult,
    'success' | 'responseText' | 'costUsd' | 'durationMs' | 'error' | 'rulesPackDelivery'
  >;
  callbackChatId?: string;
  callbackBotName?: string;
  requestIssuer?: string;
  requestSourceBot?: string;
  requestBodySha256?: string;
}

export class AsyncTaskStore {
  private tasks = new Map<string, AsyncTask>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Clean up completed tasks older than 1 hour
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 3600_000;
      for (const [id, task] of this.tasks) {
        if (task.completedAt && task.completedAt < cutoff) {
          this.tasks.delete(id);
        }
      }
    }, 300_000); // every 5 minutes
  }

  create(opts: {
    id?: string;
    botName: string;
    chatId: string;
    prompt: string;
    sourceBotName?: string;
    sourceChatId?: string;
    callbackChatId?: string;
    callbackBotName?: string;
    requestIssuer?: string;
    requestSourceBot?: string;
    requestBodySha256?: string;
  }): AsyncTask {
    const id = opts.id ?? crypto.randomUUID();
    if (this.tasks.has(id)) throw new Error(`Async task already exists: ${id}`);
    const task: AsyncTask = {
      id,
      botName: opts.botName,
      chatId: opts.chatId,
      prompt: opts.prompt,
      status: 'accepted',
      ...(opts.sourceBotName ? { sourceBotName: opts.sourceBotName } : {}),
      ...(opts.sourceChatId ? { sourceChatId: opts.sourceChatId } : {}),
      deliveryState: 'accepted',
      createdAt: Date.now(),
      callbackChatId: opts.callbackChatId,
      callbackBotName: opts.callbackBotName,
      requestIssuer: opts.requestIssuer,
      requestSourceBot: opts.requestSourceBot,
      requestBodySha256: opts.requestBodySha256,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): AsyncTask | undefined {
    return this.tasks.get(id);
  }

  update(id: string, updates: Partial<AsyncTask>): void {
    const task = this.tasks.get(id);
    if (task) {
      Object.assign(task, updates);
    }
  }

  list(): AsyncTask[] {
    return Array.from(this.tasks.values());
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
