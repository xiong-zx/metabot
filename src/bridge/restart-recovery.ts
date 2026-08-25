import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import * as path from 'node:path';
import type { BotRegistry } from '../api/bot-registry.js';
import { probeLocalDaemon } from '../services/local-daemon-health.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import {
  RestartStore,
  type RestartRequestRecord,
} from '../runtime/restart-store.js';
import type { Logger } from '../utils/logger.js';
import type { ControlledRestartPlan } from './restart-coordinator.js';
import {
  clearRestartBreadcrumb,
  getRestartBreadcrumb,
  isFreshRestart,
} from './restart-notice.js';

export interface RestartStartupHealth {
  ok: boolean;
  error?: string;
}

export interface RestartRecoveryOptions {
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  apiServer?: Server;
  healthCheck?: (record: RestartRequestRecord) => Promise<RestartStartupHealth>;
  persistProcessList?: () => Promise<void>;
  store?: RestartStore;
  now?: () => number;
  recoverParticipants?: (health: RestartStartupHealth) => Promise<ControlledRestartPlan | undefined>;
}

const PROCESS_TIMEOUT_MS = 15_000;
const INTERNAL_CHAT_PREFIXES = [
  'team:',
  'teaminst:',
  'worker:',
  'worker-',
  'arc:',
  'arc-',
  'local:worker',
  'local:arc',
];

/**
 * Finalize one controlled restart in the new Bridge process. This deliberately
 * owns no engine, card, Agent Team, Worker Runner, ARC, or Memory recovery
 * state. Those systems keep their own durable recovery contracts.
 */
export async function finalizeControlledRestartAfterStartup(options: RestartRecoveryOptions): Promise<void> {
  if (!isFreshRestart()) return;
  const breadcrumb = getRestartBreadcrumb();
  if (!breadcrumb?.requestId) return;

  const ownsStore = !options.store;
  const store = options.store ?? new RestartStore();
  const now = options.now ?? Date.now;
  try {
    let record = store.get(breadcrumb.requestId);
    if (!record || record.targetRoot !== path.resolve(breadcrumb.targetRoot)) {
      options.logger.error(
        { requestId: breadcrumb.requestId },
        'Controlled restart breadcrumb has no matching durable request',
      );
      clearRestartBreadcrumb(breadcrumb.requestId);
      return;
    }

    if (record.status === 'claimed') {
      record = store.markFailed(record.requestId, 'Bridge started before the restart request was marked restarting', {
        runtimePid: process.pid,
        now: now(),
      });
    } else if (record.status === 'restarting') {
      try {
        if (options.apiServer) await waitForListening(options.apiServer);
        const health = await (options.healthCheck ?? checkRestartStartupHealth)(record);
        if (!health.ok) throw new Error(health.error || 'Controlled restart startup health failed');
        store.markStartupHealthy(record.requestId, { runtimePid: process.pid, now: now() });
        await (options.persistProcessList ?? persistPm2ProcessList)();
        record = store.markHealthy(record.requestId, { runtimePid: process.pid, now: now() });
        options.logger.info(
          { requestId: record.requestId, targetRoot: record.targetRoot, runtimePid: process.pid },
          'Controlled restart is healthy and the PM2 process list is saved',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record = store.markFailed(record.requestId, message, { runtimePid: process.pid, now: now() });
        options.logger.error(
          { err: error, requestId: record.requestId },
          'Controlled restart startup finalization failed; PM2 process list was not saved',
        );
      }
    }

    if (options.recoverParticipants) {
      let participantPlan: ControlledRestartPlan | undefined;
      try {
        participantPlan = await options.recoverParticipants({
          ok: record.status === 'healthy',
          ...(record.healthError ? { error: record.healthError } : {}),
        });
      } catch (error) {
        options.logger.error(
          { err: error, requestId: record.requestId },
          'Multi-bot restart recovery failed; retaining breadcrumb for startup replay',
        );
        return;
      }
      if (participantPlan?.requestId === record.requestId) {
        if (participantPlan.status !== 'completed') {
          options.logger.error(
            { requestId: record.requestId },
            'Multi-bot restart recovery is incomplete; retaining breadcrumb for startup replay',
          );
          return;
        }
        recordMultiBotRecoveryOutcome(record, participantPlan, store, now());
        clearRestartBreadcrumb(record.requestId);
        return;
      }
    }

    await reportRestartOnce(record, store, options, now());
    record = store.get(record.requestId) ?? record;
    if (decideContinuationOnce(record, store, options, now())) {
      clearRestartBreadcrumb(record.requestId);
    }
  } finally {
    if (ownsStore) store.close();
  }
}

function recordMultiBotRecoveryOutcome(
  record: RestartRequestRecord,
  plan: ControlledRestartPlan,
  store: RestartStore,
  now: number,
): void {
  if (store.claimReport(record.requestId, now)) {
    const expectedNotices = plan.participants.filter((participant) => participant.sendCards);
    const failedNotices = expectedNotices.filter((participant) => participant.completionNotice !== 'delivered');
    const outcome = expectedNotices.length === 0
      ? 'skipped:no-card-participants'
      : `multi-bot:${expectedNotices.length - failedNotices.length}/${expectedNotices.length}`;
    store.recordReportOutcome(record.requestId, outcome, {
      delivered: expectedNotices.length > 0 && failedNotices.length === 0,
      now,
    });
  }
  if (!record.continuationDecidedAt) {
    const scheduled = plan.participants.filter(
      (participant) => participant.continuationOutcome === 'scheduled',
    ).length;
    store.recordContinuationDecision(record.requestId, {
      recoveryOwner: record.status === 'healthy'
        ? `multi-bot-coordinator:${scheduled}`
        : 'none:restart-failed',
      ...(scheduled > 0 ? { continuationKey: `restart-resume:${record.requestId}:participants` } : {}),
      now,
    });
  }
}

async function reportRestartOnce(
  record: RestartRequestRecord,
  store: RestartStore,
  options: RestartRecoveryOptions,
  now: number,
): Promise<void> {
  if (!store.claimReport(record.requestId, now)) return;
  if (!record.requesterBot || !record.requesterChat) {
    store.recordReportOutcome(record.requestId, 'skipped:no-requester', { now });
    return;
  }
  const bot = options.registry.get(record.requesterBot);
  if (!bot) {
    store.recordReportOutcome(record.requestId, 'skipped:bot-not-found', { now });
    options.logger.warn(
      { requestId: record.requestId, botName: record.requesterBot },
      'Controlled restart report skipped because the requester bot is not registered',
    );
    return;
  }
  const healthy = record.status === 'healthy';
  const body = healthy
    ? `Controlled ${record.kind} ${record.requestId} completed. Runtime health passed and the PM2 process list was saved.`
    : `Controlled ${record.kind} ${record.requestId} failed. The PM2 process list was not saved.${record.healthError ? `\n${record.healthError}` : ''}`;
  try {
    await withTimeout(
      bot.sender.sendTextNotice(
        record.requesterChat,
        healthy ? 'MetaBot Restart Complete' : 'MetaBot Restart Failed',
        body,
        healthy ? 'green' : 'red',
      ),
      PROCESS_TIMEOUT_MS,
      'Restart requester report timed out',
    );
    store.recordReportOutcome(record.requestId, 'delivered', { delivered: true, now });
  } catch (error) {
    store.recordReportOutcome(record.requestId, 'failed:send', { now });
    options.logger.warn(
      { err: error, requestId: record.requestId, botName: record.requesterBot, chatId: record.requesterChat },
      'Controlled restart requester report failed',
    );
  }
}

function decideContinuationOnce(
  record: RestartRequestRecord,
  store: RestartStore,
  options: RestartRecoveryOptions,
  now: number,
): boolean {
  if (record.continuationDecidedAt) return true;
  if (record.status !== 'healthy') {
    store.recordContinuationDecision(record.requestId, { recoveryOwner: 'none:restart-failed', now });
    return true;
  }
  if (!record.resume) {
    store.recordContinuationDecision(record.requestId, { recoveryOwner: 'none:resume-disabled', now });
    return true;
  }
  if (!record.requesterBot || !record.requesterChat) {
    store.recordContinuationDecision(record.requestId, { recoveryOwner: 'none:no-requester', now });
    return true;
  }
  const internalOwner = internalRecoveryOwner(record.requesterChat);
  if (internalOwner) {
    store.recordContinuationDecision(record.requestId, { recoveryOwner: internalOwner, now });
    return true;
  }
  if (!options.registry.get(record.requesterBot)) {
    store.recordContinuationDecision(record.requestId, { recoveryOwner: 'none:bot-not-found', now });
    return true;
  }

  const continuationKey = `restart-resume:${record.requestId}`;
  try {
    const task = options.scheduler.scheduleTaskDurably({
      botName: record.requesterBot,
      chatId: record.requesterChat,
      prompt: buildContinuationPrompt(record),
      delaySeconds: 0,
      sendCards: true,
      label: `Continue after ${record.kind}`,
      dedupeKey: continuationKey,
    });
    store.recordContinuationDecision(record.requestId, {
      recoveryOwner: 'task-scheduler',
      continuationKey,
      continuationTaskId: task.id,
      now,
    });
    return true;
  } catch (error) {
    options.logger.error(
      { err: error, requestId: record.requestId, continuationKey },
      'Controlled restart continuation was not durably scheduled; retaining breadcrumb for startup replay',
    );
    return false;
  }
}

function internalRecoveryOwner(chatId: string): string | undefined {
  if (chatId.startsWith('team:') || chatId.startsWith('teaminst:')) return 'agent-team-supervisor';
  if (INTERNAL_CHAT_PREFIXES.some((prefix) => chatId.startsWith(prefix))) return 'execution-daemon';
  return undefined;
}

function buildContinuationPrompt(record: RestartRequestRecord): string {
  return [
    '<system-reminder>',
    `Controlled MetaBot ${record.kind} ${record.requestId} has completed successfully.`,
    'The Bridge process and its engine session were interrupted by that restart.',
    'Continue the interrupted task now from this chat\'s existing session context.',
    'Verify the post-restart state, finish only the remaining work, and do not run restart or update again.',
    '</system-reminder>',
  ].join('\n');
}

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await Promise.race([
    once(server, 'listening').then(() => undefined),
    timeoutReject(PROCESS_TIMEOUT_MS, 'Bridge API server did not start listening'),
  ]);
}

async function checkRestartStartupHealth(record: RestartRequestRecord): Promise<RestartStartupHealth> {
  try {
    const port = positiveInteger(process.env.API_PORT || process.env.METABOT_API_PORT, 9100);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Bridge health returned HTTP ${response.status}`);

    await withTimeout(probeLocalDaemon('worker'), PROCESS_TIMEOUT_MS, 'Worker Runner health timed out');

    if (record.targetApps.includes('metabot-core')) {
      const corePort = positiveInteger(process.env.METABOT_CORE_PORT, 9200);
      const core = await fetch(`http://127.0.0.1:${corePort}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!core.ok) throw new Error(`metabot-core health returned HTTP ${core.status}`);
    }

    const listed = await runProcess('pm2', ['jlist'], PROCESS_TIMEOUT_MS);
    if (listed.code !== 0) throw new Error(`pm2 jlist failed: ${listed.stderr || `exit ${listed.code}`}`);
    const rows = JSON.parse(listed.stdout || '[]') as Pm2RuntimeRow[];
    validatePm2RuntimeExpectations(record, rows);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface Pm2RuntimeRow {
  name?: string;
  pm2_env?: Record<string, unknown> & {
    status?: string;
    pm_cwd?: string;
    pm_exec_path?: string;
    exec_interpreter?: string;
    interpreter?: string;
    node_args?: unknown;
    interpreter_args?: unknown;
    env?: Record<string, unknown>;
  };
}

export function validatePm2RuntimeExpectations(record: RestartRequestRecord, rows: Pm2RuntimeRow[]): void {
  for (const appName of record.targetApps) {
    const app = rows.find((row) => row.name === appName);
    const env = app?.pm2_env;
    const expectation = record.runtimeExpectations[appName];
    const expectedCwd = expectation?.cwd || record.targetRoot;
    const expectedScript = expectation?.script || record.targetScripts[appName];
    if (!env || env.status !== 'online') throw new Error(`PM2 app ${appName} is not online`);
    if (path.resolve(env.pm_cwd || '') !== path.resolve(expectedCwd)) {
      throw new Error(`PM2 app ${appName} cwd does not match the controlled target`);
    }
    if (!expectedScript || path.resolve(env.pm_exec_path || '') !== path.resolve(expectedScript)) {
      throw new Error(`PM2 app ${appName} script does not match the controlled target`);
    }
    if (!expectation) continue;

    const interpreter = String(env.exec_interpreter || env.interpreter || 'node');
    if (interpreter !== expectation.interpreter) {
      throw new Error(`PM2 app ${appName} interpreter does not match the controlled plan`);
    }
    const interpreterArgs = normalizeStringArray(env.node_args ?? env.interpreter_args);
    if (JSON.stringify(interpreterArgs) !== JSON.stringify(expectation.interpreterArgs)) {
      throw new Error(`PM2 app ${appName} interpreter arguments do not match the controlled plan`);
    }
    const processEnv = env.env && typeof env.env === 'object' ? env.env : env;
    for (const [key, expectedHash] of Object.entries(expectation.envHashes)) {
      const actual = processEnv[key];
      if (actual === undefined || actual === null || fingerprint(actual) !== expectedHash) {
        throw new Error(`PM2 app ${appName} environment fingerprint mismatch for ${key}`);
      }
    }
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function persistPm2ProcessList(): Promise<void> {
  const result = await runProcess('pm2', ['save', '--force'], PROCESS_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`pm2 save failed: ${result.stderr || `exit ${result.code}`}`);
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code ?? 1,
        stdout: stdout.trim(),
        stderr: timedOut ? `timed out after ${timeoutMs}ms` : stderr.trim(),
      });
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([promise, timeoutReject<T>(timeoutMs, message)]);
}

function timeoutReject<T>(timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
