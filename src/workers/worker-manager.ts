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
export type WorkerExecutionStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'idle_timed_out' | 'transport_error' | 'aborted';
export type WorkerArtifactStatus = 'unknown' | 'missing' | 'invalid' | 'valid_partial' | 'valid_complete';

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
  /** Process/stream outcome. This can differ from `status` when a valid artifact recovered a failed stream. */
  executionStatus?: WorkerExecutionStatus;
  /** Best-effort validation of durable worker output files under the workdir. */
  artifactStatus?: WorkerArtifactStatus;
  artifactPath?: string;
  terminalError?: string;
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
const MIN_DURABLE_WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_DURABLE_WORKER_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DURABLE_WORKER_PATTERN = /(autoresearchclaw|auto[-_\s]?research|research[-_\s]?worker|dashboard[-_\s]?research|调研)/i;

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

function isDurableWorkerTask(input: Pick<DispatchInput, 'prompt' | 'label'>): boolean {
  return DURABLE_WORKER_PATTERN.test(`${input.label || ''}\n${input.prompt || ''}`);
}

function normalizeWorkerTimeouts(input: DispatchInput): { timeoutMs?: number; idleTimeoutMs?: number; adjusted: boolean } {
  if (!isDurableWorkerTask(input)) {
    return { timeoutMs: input.timeoutMs, idleTimeoutMs: input.idleTimeoutMs, adjusted: false };
  }
  const timeoutMs = input.timeoutMs === undefined
    ? undefined
    : Math.max(input.timeoutMs, MIN_DURABLE_WORKER_TIMEOUT_MS);
  const idleTimeoutMs = input.idleTimeoutMs === undefined
    ? undefined
    : Math.max(input.idleTimeoutMs, MIN_DURABLE_WORKER_IDLE_TIMEOUT_MS);
  return {
    timeoutMs,
    idleTimeoutMs,
    adjusted: timeoutMs !== input.timeoutMs || idleTimeoutMs !== input.idleTimeoutMs,
  };
}

function classifyExecutionStatus(error: string | undefined): WorkerExecutionStatus {
  const text = error || '';
  if (/no activity|idle timeout/i.test(text)) return 'idle_timed_out';
  if (/timed out|timeout/i.test(text)) return 'timed_out';
  if (/stream disconnected|transport error|network error|decoding response body/i.test(text)) return 'transport_error';
  return 'failed';
}

function appendSummary(existing: string | undefined, addition: string): string {
  const prefix = existing?.trim();
  return (prefix ? `${prefix}\n${addition}` : addition).slice(0, 500);
}

function readJsonFile(filePath: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function artifactStatusFromJson(value: any): WorkerArtifactStatus {
  if (!value || typeof value !== 'object') return 'invalid';
  const contractVersion = value.contract_version;
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (typeof contractVersion !== 'string' || !status) return 'invalid';
  if (status === 'complete' || status === 'completed') return 'valid_complete';
  if (status === 'partial') return 'valid_partial';
  return 'invalid';
}

function inspectArtifactFile(filePath: string): { status: WorkerArtifactStatus; path: string } {
  return { status: artifactStatusFromJson(readJsonFile(filePath)), path: filePath };
}

function inspectWorkerArtifacts(workDir: string): { status: WorkerArtifactStatus; path?: string } {
  const resolvedWorkDir = path.resolve(workDir);
  const candidates: string[] = [path.join(resolvedWorkDir, 'results.json')];
  const autoResearchDir = path.join(resolvedWorkDir, '.metabot-memory', 'autoresearchclaw');
  try {
    for (const entry of fs.readdirSync(autoResearchDir)) {
      if (entry.endsWith('.json')) candidates.push(path.join(autoResearchDir, entry));
    }
  } catch {
    // Missing AutoResearchClaw artifact directory is common for non-research workers.
  }

  let sawInvalid = false;
  let partialPath: string | undefined;
  for (const candidate of candidates) {
    if (!candidate.startsWith(resolvedWorkDir + path.sep) && candidate !== path.join(resolvedWorkDir, 'results.json')) continue;
    if (!fs.existsSync(candidate)) continue;
    const inspected = inspectArtifactFile(candidate);
    if (inspected.status === 'valid_complete') return inspected;
    if (inspected.status === 'valid_partial') partialPath = partialPath || inspected.path;
    else if (inspected.status === 'invalid') sawInvalid = true;
  }

  if (partialPath) return { status: 'valid_partial', path: partialPath };
  return { status: sawInvalid ? 'invalid' : 'missing' };
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
    const effectiveTimeouts = normalizeWorkerTimeouts(input);

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
      timeoutMs: effectiveTimeouts.timeoutMs,
      idleTimeoutMs: effectiveTimeouts.idleTimeoutMs,
      status: 'running',
      executionStatus: 'running',
      artifactStatus: 'unknown',
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
      timeoutAdjusted: effectiveTimeouts.adjusted, timeoutMs: record.timeoutMs, idleTimeoutMs: record.idleTimeoutMs,
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
        record.executionStatus = 'completed';
        record.resultSummary = result.responseText?.slice(0, 500) || '';
      } else {
        record.status = 'failed';
        record.error = result.error || 'Worker task failed';
        record.executionStatus = classifyExecutionStatus(record.error);
        record.resultSummary = result.responseText?.slice(0, 500) || '';
        this.reconcileTerminalArtifact(record);
      }
    } catch (err: any) {
      record.endTime = Date.now();
      record.durationMs = record.endTime - startTime;
      record.status = record.status === 'aborted' ? 'aborted' : 'failed';
      record.error = err.message || 'Unknown error';
      record.executionStatus = record.status === 'aborted' ? 'aborted' : classifyExecutionStatus(record.error);
      if (record.status === 'failed') this.reconcileTerminalArtifact(record);
    }

    this.persist();
    await this.notifyPm(record);
  }

  private reconcileTerminalArtifact(record: WorkerRecord): void {
    const artifact = inspectWorkerArtifacts(record.workingDirectory);
    record.artifactStatus = artifact.status;
    if (artifact.path) record.artifactPath = artifact.path;

    if (record.status === 'failed' && artifact.status === 'valid_complete') {
      record.terminalError = record.error;
      delete record.error;
      record.status = 'completed';
      record.resultSummary = appendSummary(
        record.resultSummary,
        `Recovered: valid completed artifact found at ${path.relative(record.workingDirectory, artifact.path!)}.`,
      );
    }
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
      record.executionStatus && record.executionStatus !== record.status ? `Execution status: ${record.executionStatus}` : '',
      record.artifactStatus && record.artifactStatus !== 'unknown' ? `Artifact status: ${record.artifactStatus}${record.artifactPath ? ` (${record.artifactPath})` : ''}` : '',
      record.resultSummary ? `Result summary: ${record.resultSummary.slice(0, 300)}` : '',
      record.error ? `Error: ${record.error}` : '',
      record.terminalError ? `Terminal warning: ${record.terminalError}` : '',
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
