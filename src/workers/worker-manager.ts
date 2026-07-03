import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from '../api/bot-registry.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { EngineName } from '../config.js';

// --- Types ---

/** Reasoning effort forwarded to the worker's engine (codex `-c
 *  model_reasoning_effort=...`; claude SDK `effort`). */
export type WorkerReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface WorkerRecord {
  id: string;
  botName: string;
  pmChatId: string;
  workerChatId: string;
  workingDirectory: string;
  prompt: string;
  label?: string;
  model: string;
  engine: EngineName;
  reasoningEffort?: WorkerReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandbox;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startTime: number;
  endTime?: number;
  resultSummary?: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

export interface DispatchInput {
  botName: string;
  pmChatId: string;
  workingDirectory: string;
  prompt: string;
  label?: string;
  /** Model name or alias — see {@link resolveWorkerModel}. */
  model?: string;
  /** Explicit engine override; usually inferred from the model name. */
  engine?: EngineName;
  reasoningEffort?: WorkerReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandbox;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface WorkerManagerConfig {
  /** Default worker model (alias-resolved). Default: gpt-5.4 (codex, real 1M ctx). */
  defaultModel: string;
  maxPerPm: number;
  /** Custom path to the worker CLAUDE.md template. */
  claudeMdTemplate?: string;
}

// --- Model alias resolution ---

/**
 * Friendly aliases the PM can pass as `model`. Keep in sync with the
 * worker_dispatch MCP tool description (src/mcp/worker-manager-mcp.ts).
 */
const WORKER_MODEL_ALIASES: Record<string, { model: string; engine: EngineName }> = {
  'opus': { model: 'claude-opus-4-8', engine: 'claude' },
  'sonnet': { model: 'claude-sonnet-4-6', engine: 'claude' },
};

/**
 * Resolve a model name/alias (+ optional explicit engine) to a concrete
 * {model, engine} pair. Inference: `gpt-*` → codex, `claude-*` → claude;
 * explicit engine always wins.
 */
export function resolveWorkerModel(
  rawModel: string | undefined,
  rawEngine: EngineName | undefined,
  defaultModel: string,
): { model: string; engine: EngineName } {
  const requested = (rawModel || defaultModel).trim();
  const alias = WORKER_MODEL_ALIASES[requested.toLowerCase()];
  const model = alias ? alias.model : requested;
  let engine: EngineName;
  if (rawEngine) {
    engine = rawEngine;
  } else if (alias) {
    engine = alias.engine;
  } else if (model.startsWith('gpt-')) {
    engine = 'codex';
  } else if (model.startsWith('claude-')) {
    engine = 'claude';
  } else if (model.startsWith('kimi')) {
    engine = 'kimi';
  } else {
    engine = 'claude';
  }
  return { model, engine };
}

// --- Persistence ---

// Honors SESSION_STORE_DIR like session-registry/activity-store do, so a
// second MetaBot instance on the same host (e.g. a test deployment beside
// production) can fully isolate its state.
const PERSISTENCE_DIR = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, 'workers.json');

function loadRecords(): WorkerRecord[] {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      return JSON.parse(fs.readFileSync(PERSISTENCE_FILE, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }
  return [];
}

function saveRecords(records: WorkerRecord[]): void {
  fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
  fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(records, null, 2));
}

// --- Worker CLAUDE.md injection ---

const WORKER_MARKER = '<!-- METABOT-WORKER -->';

function getWorkerClaudeMdTemplate(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return fs.readFileSync(customPath, 'utf-8');
  }
  const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.join(thisDir, '..', 'workspace', 'worker-CLAUDE.md'),
    path.join(thisDir, '..', '..', 'src', 'workspace', 'worker-CLAUDE.md'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8');
  }
  return `${WORKER_MARKER}\n# Worker Agent\nYou are a worker agent dispatched by the PM. Focus on completing your assigned task.\n`;
}

/**
 * Inject the worker spec template into the workdir's instruction files —
 * BOTH `CLAUDE.md` (read by claude-engine workers) and `AGENTS.md` (read by
 * codex-engine workers; doubles as the project-local memory file the PM
 * maintains). Marker-guarded: existing files get the template appended once;
 * any PM-curated AGENTS.md content is preserved.
 */
export function injectWorkerTemplates(workDir: string, customTemplatePath?: string): void {
  const template = getWorkerClaudeMdTemplate(customTemplatePath);
  for (const filename of ['CLAUDE.md', 'AGENTS.md']) {
    const filePath = path.join(workDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, template);
      continue;
    }
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing.includes(WORKER_MARKER)) continue;
    fs.writeFileSync(filePath, existing + '\n\n' + template);
  }
}

// --- WorkerManager ---

export class WorkerManager {
  private records: WorkerRecord[];

  constructor(
    private registry: BotRegistry,
    private logger: Logger,
    private config: WorkerManagerConfig,
  ) {
    this.records = loadRecords();
    // Mark stale "running" records from a previous process as failed.
    for (const r of this.records) {
      if (r.status === 'running') {
        r.status = 'failed';
        r.error = 'metabot restarted while worker was running';
        r.endTime = Date.now();
      }
    }
    this.persist();
  }

  dispatch(input: DispatchInput): WorkerRecord {
    const { botName, pmChatId, workingDirectory, prompt, label } = input;

    const runningCount = this.records.filter(
      (r) => r.pmChatId === pmChatId && r.status === 'running',
    ).length;
    if (runningCount >= this.config.maxPerPm) {
      throw new Error(`Max concurrent workers (${this.config.maxPerPm}) reached for this PM chat`);
    }

    const bot = this.registry.get(botName);
    if (!bot) {
      throw new Error(`Bot not found: ${botName}`);
    }

    const { model, engine } = resolveWorkerModel(input.model, input.engine, this.config.defaultModel);
    const id = crypto.randomUUID().slice(0, 8);

    const record: WorkerRecord = {
      id,
      botName,
      pmChatId,
      workerChatId: `worker-${id}`,
      workingDirectory,
      prompt,
      label,
      model,
      engine,
      reasoningEffort: input.reasoningEffort,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
      status: 'running',
      startTime: Date.now(),
    };

    this.records.push(record);
    this.persist();

    try {
      injectWorkerTemplates(workingDirectory, this.config.claudeMdTemplate);
    } catch (err) {
      this.logger.warn({ err, workDir: workingDirectory }, 'Failed to inject worker templates');
    }

    // Fire-and-forget worker execution
    this.runWorker(record, bot).catch((err) => {
      this.logger.error({ err, workerId: id }, 'Worker execution failed unexpectedly');
    });

    this.logger.info({
      workerId: id, botName, pmChatId, workerChatId: record.workerChatId,
      workDir: workingDirectory, model, engine, reasoningEffort: input.reasoningEffort, label,
    }, 'Worker dispatched');

    return record;
  }

  listWorkers(pmChatId?: string): WorkerRecord[] {
    return pmChatId ? this.records.filter((r) => r.pmChatId === pmChatId) : [...this.records];
  }

  getWorker(id: string): WorkerRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  abortWorker(id: string): boolean {
    const record = this.records.find((r) => r.id === id);
    if (!record || record.status !== 'running') return false;

    const bot = this.registry.get(record.botName);
    if (bot) {
      bot.bridge.stopChatTask(record.workerChatId);
    }

    record.status = 'aborted';
    record.endTime = Date.now();
    this.persist();
    this.logger.info({ workerId: id }, 'Worker aborted');
    return true;
  }

  redirectWorker(id: string, newPrompt: string): WorkerRecord | null {
    const record = this.records.find((r) => r.id === id);
    if (!record) return null;

    if (record.status === 'running') {
      this.abortWorker(id);
    }

    const redirectPrompt = `[CONTEXT] The previous task was: "${record.prompt}"\nIt has been interrupted. New instructions:\n\n${newPrompt}`;

    return this.dispatch({
      botName: record.botName,
      pmChatId: record.pmChatId,
      workingDirectory: record.workingDirectory,
      prompt: redirectPrompt,
      label: record.label ? `redirect-${record.label}` : undefined,
      model: record.model,
      engine: record.engine,
      reasoningEffort: record.reasoningEffort,
      approvalPolicy: record.approvalPolicy,
      sandbox: record.sandbox,
      timeoutMs: record.timeoutMs,
      idleTimeoutMs: record.idleTimeoutMs,
    });
  }

  /**
   * Append a synthetic record for a /bytheway side query. No worker is
   * spawned; the record is an audit entry so the PM (via worker_list) can
   * see /btw history. Caller closes it with {@link finishSyntheticTask}.
   */
  recordSyntheticTask(input: {
    botName: string;
    pmChatId: string;
    workingDirectory: string;
    prompt: string;
    label: string;
  }): WorkerRecord {
    const record: WorkerRecord = {
      id: 'btw-' + crypto.randomUUID().slice(0, 8),
      botName: input.botName,
      pmChatId: input.pmChatId,
      workerChatId: '',
      workingDirectory: input.workingDirectory,
      prompt: input.prompt,
      label: input.label,
      model: '-',
      engine: 'claude',
      status: 'running',
      startTime: Date.now(),
    };
    this.records.push(record);
    this.persist();
    return record;
  }

  /** Update a synthetic record's terminal state. */
  finishSyntheticTask(id: string, patch: {
    status: 'completed' | 'failed' | 'aborted';
    costUsd?: number;
    durationMs?: number;
    resultSummary?: string;
    error?: string;
  }): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    record.status = patch.status;
    record.endTime = Date.now();
    if (patch.costUsd !== undefined) record.costUsd = patch.costUsd;
    if (patch.durationMs !== undefined) record.durationMs = patch.durationMs;
    if (patch.resultSummary !== undefined) record.resultSummary = patch.resultSummary;
    if (patch.error !== undefined) record.error = patch.error;
    this.persist();
  }

  // --- Internal ---

  private async runWorker(record: WorkerRecord, bot: { bridge: MessageBridge }): Promise<void> {
    const startTime = Date.now();
    try {
      const result = await bot.bridge.executeApiTask({
        prompt: record.prompt,
        chatId: record.workerChatId,
        userId: 'worker-manager',
        sendCards: false,
        workingDirectory: record.workingDirectory,
        model: record.model,
        engine: record.engine,
        reasoningEffort: record.reasoningEffort,
        approvalPolicy: record.approvalPolicy,
        sandbox: record.sandbox,
        timeoutMs: record.timeoutMs,
        idleTimeoutMs: record.idleTimeoutMs,
      });

      record.endTime = Date.now();
      record.durationMs = record.endTime - startTime;
      record.costUsd = result.costUsd;

      if (result.success) {
        record.status = 'completed';
        record.resultSummary = result.responseText?.slice(0, 500) || '';
      } else {
        record.status = 'failed';
        record.error = result.error || 'Worker task failed';
        record.resultSummary = result.responseText?.slice(0, 500) || '';
      }
    } catch (err: any) {
      record.endTime = Date.now();
      record.durationMs = record.endTime - startTime;
      record.status = record.status === 'aborted' ? 'aborted' : 'failed';
      record.error = err.message || 'Unknown error';
    }

    this.persist();
    await this.notifyPm(record);
  }

  private async notifyPm(record: WorkerRecord): Promise<void> {
    const bot = this.registry.get(record.botName);
    if (!bot) return;

    const statusEmoji = record.status === 'completed' ? '✅'
      : record.status === 'aborted' ? '⏹️'
      : '❌';
    const durationMin = record.durationMs ? Math.round(record.durationMs / 60000) : '?';
    const costStr = record.costUsd ? `$${record.costUsd.toFixed(2)}` : 'unknown';

    const notifyPrompt = [
      `[WORKER COMPLETED NOTIFICATION]`,
      `Worker ${record.id} ${statusEmoji} ${record.status}`,
      `Label: ${record.label || 'none'}`,
      `Engine/Model: ${record.engine}/${record.model}`,
      `Duration: ${durationMin}min | Cost: ${costStr}`,
      `Working directory: ${record.workingDirectory}`,
      `Original task: ${record.prompt.slice(0, 200)}`,
      record.resultSummary ? `Result summary: ${record.resultSummary.slice(0, 300)}` : '',
      record.error ? `Error: ${record.error}` : '',
      '',
      'Please review the worker\'s output in the working directory and decide next steps.',
      'Check: worker-progress.json, results.json, train.log, and code changes.',
    ].filter(Boolean).join('\n');

    try {
      await bot.bridge.executeApiTask({
        prompt: notifyPrompt,
        chatId: record.pmChatId,
        userId: 'worker-manager',
        sendCards: true,
      });
      this.logger.info({ workerId: record.id, pmChatId: record.pmChatId }, 'PM notified of worker completion');
    } catch (err) {
      this.logger.error({ err, workerId: record.id }, 'Failed to notify PM of worker completion');
    }
  }

  private persist(): void {
    try {
      saveRecords(this.records);
    } catch (err) {
      this.logger.warn({ err }, 'Failed to persist worker records');
    }
  }
}
