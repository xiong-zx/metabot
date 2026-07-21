import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from '../api/bot-registry.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { EngineName } from '../config.js';
import {
  AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
  validateAutoResearchClawOutput,
  type AutoResearchClawLegacyAliasDeprecationTelemetry,
} from '../memory-core/autoresearchclaw-contract.js';
import { MemoryCoreError } from '../memory-core/event-ledger.js';

// --- Types ---

/** Reasoning effort forwarded to the worker's engine (codex `-c
 *  model_reasoning_effort=...`; claude SDK `effort`). */
export type WorkerReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type WorkerExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'idle_timed_out'
  | 'transport_error'
  | 'aborted';
export type WorkerArtifactStatus = 'unknown' | 'missing' | 'invalid' | 'valid_partial' | 'valid_complete';
export type WorkerOutputContractName =
  | 'generic_results_v1'
  | 'autoresearchclaw_output_v2'
  | 'chat_only_result_v1'
  | 'custom_optional';
export type WorkerContractStatus = 'not_declared' | 'satisfied' | 'violated' | 'optional_missing';
export type WorkerDeliveryStatus = 'full' | 'truncated' | 'chat_only' | 'file_only' | 'failed';
export type WorkerRecoveryStatus = 'none' | 'recovered_from_artifact' | 'manual_required';

export interface WorkerArtifactError {
  code: string;
  message: string;
  path?: string;
}

export interface WorkerOutputContract {
  name: WorkerOutputContractName;
  requiredArtifact: boolean;
  idempotent?: boolean;
  expectedArtifacts?: string[];
}

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
  outputContract?: WorkerOutputContract;
  /** Best-effort validation of durable worker output files under the workdir. */
  artifactStatus?: WorkerArtifactStatus;
  contractStatus?: WorkerContractStatus;
  deliveryStatus?: WorkerDeliveryStatus;
  recoveryStatus?: WorkerRecoveryStatus;
  artifactError?: WorkerArtifactError;
  artifactPath?: string;
  detailRoute?: string;
  finalPayloadRef?: string;
  finalTranscriptRef?: string;
  terminalError?: string;
  startTime: number;
  endTime?: number;
  resultSummary?: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  dedupeKey?: string;
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
  dedupeKey?: string;
  outputContract?: WorkerOutputContract;
}

export interface WorkerBackfillChange {
  workerId: string;
  dryRun: boolean;
  changedFields: string[];
}

export interface WorkerBackfillResult {
  updatedRecords: WorkerRecord[];
  changes: WorkerBackfillChange[];
}

export const SUPPORTED_WORKER_OUTPUT_CONTRACT_NAMES = [
  'generic_results_v1',
  'autoresearchclaw_output_v2',
  'chat_only_result_v1',
  'custom_optional',
] as const satisfies readonly WorkerOutputContractName[];

export interface WorkerManagerConfig {
  /** Default worker model (alias-resolved). Default: gpt-5.4 (codex, real 1M ctx). */
  defaultModel: string;
  maxPerPm: number;
  /** Custom path to the worker CLAUDE.md template. */
  claudeMdTemplate?: string;
}

export type WorkerRulesContextProvider = (input: {
  botName: string;
  pmChatId: string;
  workerChatId: string;
  workingDirectory: string;
  label?: string;
}) => string | undefined;

// --- Model alias resolution ---

/**
 * Friendly aliases the PM can pass as `model`. Keep in sync with the
 * worker_dispatch MCP tool description (src/mcp/worker-manager-mcp.ts).
 */
const WORKER_MODEL_ALIASES: Record<string, { model: string; engine: EngineName }> = {
  opus: { model: 'claude-opus-4-8', engine: 'claude' },
  sonnet: { model: 'claude-sonnet-4-6', engine: 'claude' },
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
const WORKER_DEDUPE_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_DURABLE_WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_DURABLE_WORKER_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DURABLE_WORKER_PATTERN =
  /(autoresearchclaw|auto[-_\s]?research|research[-_\s]?worker|dashboard[-_\s]?research|调研)/i;
const AUTORESEARCH_WORKER_PATTERN = /(autoresearchclaw|auto[-_\s]?research|dashboard[-_\s]?research)/i;

function loadRecords(): WorkerRecord[] {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      return JSON.parse(fs.readFileSync(PERSISTENCE_FILE, 'utf-8'));
    }
  } catch {
    /* ignore corrupt file */
  }
  return [];
}

function saveRecords(records: WorkerRecord[]): void {
  fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
  fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(records, null, 2));
}

function normalizeDedupeKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

function isDurableWorkerTask(input: Pick<DispatchInput, 'prompt' | 'label'>): boolean {
  return DURABLE_WORKER_PATTERN.test(`${input.label || ''}\n${input.prompt || ''}`);
}

function isAutoResearchWorkerTask(input: Pick<DispatchInput, 'prompt' | 'label'>): boolean {
  return AUTORESEARCH_WORKER_PATTERN.test(`${input.label || ''}\n${input.prompt || ''}`);
}

function inferOutputContract(input: Pick<DispatchInput, 'prompt' | 'label'>): WorkerOutputContract | undefined {
  if (isAutoResearchWorkerTask(input)) {
    return {
      name: 'autoresearchclaw_output_v2',
      requiredArtifact: true,
      expectedArtifacts: ['.metabot-memory/autoresearchclaw/*.json'],
    };
  }
  if (isDurableWorkerTask(input)) {
    return {
      name: 'generic_results_v1',
      requiredArtifact: true,
      expectedArtifacts: ['results.json'],
    };
  }
  return undefined;
}

export function isWorkerOutputContractName(value: unknown): value is WorkerOutputContractName {
  return typeof value === 'string' && (SUPPORTED_WORKER_OUTPUT_CONTRACT_NAMES as readonly string[]).includes(value);
}

export function normalizeWorkerOutputContract(
  value: WorkerOutputContract | undefined,
): WorkerOutputContract | undefined {
  if (!value) return undefined;
  if (!isWorkerOutputContractName(value.name)) return undefined;
  return {
    name: value.name,
    requiredArtifact: value.requiredArtifact !== false,
    idempotent: value.idempotent,
    expectedArtifacts: Array.isArray(value.expectedArtifacts)
      ? value.expectedArtifacts.filter((item) => typeof item === 'string' && item.trim())
      : undefined,
  };
}

function validateDispatchOutputContract(value: WorkerOutputContract | undefined): WorkerOutputContract | undefined {
  if (!value) return undefined;
  if (!isWorkerOutputContractName(value.name)) {
    throw new Error(`Invalid outputContract.name: unsupported contract "${String(value.name)}"`);
  }
  if (typeof value.requiredArtifact !== 'boolean') {
    throw new Error('Invalid outputContract.requiredArtifact: expected a boolean');
  }
  if (value.expectedArtifacts !== undefined) {
    const validArtifacts =
      Array.isArray(value.expectedArtifacts) &&
      value.expectedArtifacts.length > 0 &&
      value.expectedArtifacts.every((item) => typeof item === 'string' && item.trim().length > 0);
    if (!validArtifacts) {
      throw new Error('Invalid outputContract.expectedArtifacts: expected a non-empty array of non-empty strings');
    }
  }
  return normalizeWorkerOutputContract(value);
}

function normalizeWorkerTimeouts(input: DispatchInput): {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  adjusted: boolean;
} {
  if (!isDurableWorkerTask(input)) {
    return { timeoutMs: input.timeoutMs, idleTimeoutMs: input.idleTimeoutMs, adjusted: false };
  }
  const timeoutMs =
    input.timeoutMs === undefined ? undefined : Math.max(input.timeoutMs, MIN_DURABLE_WORKER_TIMEOUT_MS);
  const idleTimeoutMs =
    input.idleTimeoutMs === undefined ? undefined : Math.max(input.idleTimeoutMs, MIN_DURABLE_WORKER_IDLE_TIMEOUT_MS);
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

function readJsonFile(filePath: string): { value?: unknown; error?: WorkerArtifactError } {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
  } catch (err) {
    return {
      error: {
        code: 'invalid_json_artifact',
        message: err instanceof Error ? err.message : 'Artifact is not valid JSON',
        path: filePath,
      },
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface ArtifactStatusResult {
  status: WorkerArtifactStatus;
  error?: WorkerArtifactError;
}

function artifactStatusFromAutoResearchJson(
  value: unknown,
  options: {
    projectRoot?: string;
    onLegacyAliasDeprecation?: (event: AutoResearchClawLegacyAliasDeprecationTelemetry) => void;
  } = {},
): ArtifactStatusResult {
  if (!isPlainObject(value)) {
    return {
      status: 'invalid',
      error: {
        code: 'invalid_autoresearchclaw_field',
        message: 'AutoResearchClaw output must be an object',
      },
    };
  }
  const contractVersion = value.contract_version;
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (contractVersion !== AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION || !status) {
    return {
      status: 'invalid',
      error: {
        code: 'invalid_autoresearchclaw_contract',
        message: `contract_version must be ${AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION} and status must be present`,
      },
    };
  }
  try {
    const output = validateAutoResearchClawOutput(value, {
      projectRoot: options.projectRoot,
      onLegacyAliasDeprecation: options.onLegacyAliasDeprecation,
    });
    if (output.status === 'completed') return { status: 'valid_complete' };
    if (output.status === 'partial' || output.status === 'failed') return { status: 'valid_partial' };
  } catch (err) {
    return {
      status: 'invalid',
      error: workerArtifactErrorFromUnknown(err),
    };
  }
  return {
    status: 'invalid',
    error: {
      code: 'invalid_autoresearchclaw_field',
      message: `status has unsupported value: ${String(value.status)}`,
    },
  };
}

function artifactStatusFromGenericResultsJson(value: any): ArtifactStatusResult {
  if (!isPlainObject(value)) return { status: 'invalid' };
  const task = typeof value.task === 'string' ? value.task.trim() : '';
  const notes = typeof value.notes === 'string' ? value.notes.trim() : '';
  if (task && notes && isPlainObject(value.metrics)) return { status: 'valid_complete' };
  const legacySummary = typeof value.summary === 'string' ? value.summary.trim() : '';
  const legacyStatus = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (!legacySummary || !legacyStatus) return { status: 'invalid' };
  if (legacyStatus === 'complete' || legacyStatus === 'completed') return { status: 'valid_complete' };
  if (legacyStatus === 'partial') return { status: 'valid_partial' };
  return { status: 'invalid' };
}

function workerArtifactErrorFromUnknown(err: unknown): WorkerArtifactError {
  if (err instanceof MemoryCoreError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: 'invalid_artifact', message: err.message };
  }
  return { code: 'invalid_artifact', message: String(err) };
}

function artifactStatusForContract(
  filePath: string,
  contract: WorkerOutputContract | undefined,
  options: {
    projectRoot?: string;
    onLegacyAliasDeprecation?: (event: AutoResearchClawLegacyAliasDeprecationTelemetry) => void;
  } = {},
): ArtifactStatusResult {
  const read = readJsonFile(filePath);
  if (read.error) return { status: 'invalid', error: read.error };
  const value = read.value;
  if (!contract) return artifactStatusFromAutoResearchJson(value, options);
  switch (contract.name) {
    case 'autoresearchclaw_output_v2':
      return artifactStatusFromAutoResearchJson(value, options);
    case 'generic_results_v1':
      return artifactStatusFromGenericResultsJson(value);
    default:
      return { status: 'unknown' };
  }
}

interface WorkerArtifactInspection {
  status: WorkerArtifactStatus;
  contractStatus: WorkerContractStatus;
  error?: WorkerArtifactError;
  path?: string;
}

function inspectArtifactFile(
  filePath: string,
  contract: WorkerOutputContract | undefined,
  options: {
    projectRoot?: string;
    onLegacyAliasDeprecation?: (event: AutoResearchClawLegacyAliasDeprecationTelemetry) => void;
  } = {},
): WorkerArtifactInspection {
  const result = artifactStatusForContract(filePath, contract, options);
  return {
    status: result.status,
    contractStatus: contractStatusFromArtifact(contract, result.status),
    error: result.error === undefined ? undefined : { ...result.error, path: result.error.path ?? filePath },
    path: filePath,
  };
}

function contractStatusFromArtifact(
  contract: WorkerOutputContract | undefined,
  status: WorkerArtifactStatus,
): WorkerContractStatus {
  if (!contract) return 'not_declared';
  if (status === 'valid_complete' || status === 'valid_partial') return 'satisfied';
  if (status === 'missing') return contract.requiredArtifact ? 'violated' : 'optional_missing';
  if (status === 'invalid') return 'violated';
  return 'not_declared';
}

function inspectWorkerArtifacts(
  workDir: string,
  contract: WorkerOutputContract | undefined,
  options: {
    onLegacyAliasDeprecation?: (event: AutoResearchClawLegacyAliasDeprecationTelemetry) => void;
  } = {},
): WorkerArtifactInspection {
  const resolvedWorkDir = path.resolve(workDir);
  const autoResearchDir = path.join(resolvedWorkDir, '.metabot-memory', 'autoresearchclaw');
  const candidates: string[] = [];
  if (!contract || contract.name === 'generic_results_v1') {
    candidates.push(path.join(resolvedWorkDir, 'results.json'));
  }
  if (!contract || contract.name === 'autoresearchclaw_output_v2') {
    try {
      for (const entry of fs.readdirSync(autoResearchDir)) {
        if (entry.endsWith('.json')) candidates.push(path.join(autoResearchDir, entry));
      }
    } catch {
      // Missing AutoResearchClaw artifact directory is common for non-research workers.
    }
  }

  let sawInvalid = false;
  let invalidPath: string | undefined;
  let invalidError: WorkerArtifactError | undefined;
  let partialPath: string | undefined;
  for (const candidate of candidates) {
    if (!candidate.startsWith(resolvedWorkDir + path.sep) && candidate !== path.join(resolvedWorkDir, 'results.json'))
      continue;
    if (!fs.existsSync(candidate)) continue;
    const inspected = inspectArtifactFile(candidate, contract, {
      projectRoot: resolvedWorkDir,
      onLegacyAliasDeprecation: options.onLegacyAliasDeprecation,
    });
    if (inspected.status === 'valid_complete') return inspected;
    if (inspected.status === 'valid_partial') partialPath = partialPath || inspected.path;
    else if (inspected.status === 'invalid') {
      sawInvalid = true;
      invalidPath = invalidPath || inspected.path;
      invalidError = invalidError || inspected.error;
    }
  }

  if (partialPath)
    return {
      status: 'valid_partial',
      contractStatus: contractStatusFromArtifact(contract, 'valid_partial'),
      path: partialPath,
    };
  const status = sawInvalid ? 'invalid' : 'missing';
  return {
    status,
    contractStatus: contractStatusFromArtifact(contract, status),
    path: invalidPath,
    error: invalidError,
  };
}

function isTerminalWorkerStatus(status: WorkerRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

function syncWorkerDetailRefs(record: WorkerRecord): void {
  record.detailRoute = `/api/workers/${record.id}`;
  if (record.workerChatId) {
    record.finalTranscriptRef = `worker-chat:${record.workerChatId}`;
  }
  if (record.artifactPath) {
    record.finalPayloadRef = `file://${record.artifactPath}`;
    record.deliveryStatus = record.artifactStatus === 'valid_complete' ? 'full' : 'file_only';
    return;
  }
  if (record.status === 'failed' || record.status === 'aborted') {
    record.deliveryStatus = 'failed';
    return;
  }
  record.deliveryStatus = record.resultSummary && record.resultSummary.length >= 500 ? 'truncated' : 'chat_only';
}

function reconcileTerminalWorkerRecord(
  record: WorkerRecord,
  options: {
    onLegacyAliasDeprecation?: (event: AutoResearchClawLegacyAliasDeprecationTelemetry) => void;
  } = {},
): void {
  if (!isTerminalWorkerStatus(record.status)) return;

  const contract = normalizeWorkerOutputContract(record.outputContract) ?? inferOutputContract(record);
  if (contract) {
    record.outputContract = contract;
  }

  const shouldInspectArtifact = !!contract || record.status === 'failed';
  if (shouldInspectArtifact) {
    const artifact = inspectWorkerArtifacts(record.workingDirectory, contract, options);
    record.artifactStatus = artifact.status;
    record.contractStatus = artifact.contractStatus;
    if (artifact.path) record.artifactPath = artifact.path;
    if (artifact.error) record.artifactError = artifact.error;
    else delete record.artifactError;
    if (record.status === 'failed' && artifact.status === 'valid_complete') {
      record.terminalError = record.error;
      delete record.error;
      record.status = 'completed';
      record.recoveryStatus = 'recovered_from_artifact';
      record.resultSummary = appendSummary(
        record.resultSummary,
        `Recovered: valid completed artifact found at ${path.relative(record.workingDirectory, artifact.path!)}.`,
      );
    } else if (!record.recoveryStatus) {
      record.recoveryStatus = 'none';
    }
  } else {
    record.contractStatus = record.contractStatus ?? 'not_declared';
    record.artifactStatus = record.artifactStatus ?? 'unknown';
    delete record.artifactError;
    record.recoveryStatus = record.recoveryStatus ?? 'none';
  }

  syncWorkerDetailRefs(record);
}

function trackedWorkerFields(record: WorkerRecord): Record<string, unknown> {
  return {
    outputContract: record.outputContract,
    artifactStatus: record.artifactStatus,
    contractStatus: record.contractStatus,
    deliveryStatus: record.deliveryStatus,
    recoveryStatus: record.recoveryStatus,
    artifactError: record.artifactError,
    artifactPath: record.artifactPath,
    detailRoute: record.detailRoute,
    finalPayloadRef: record.finalPayloadRef,
    finalTranscriptRef: record.finalTranscriptRef,
    status: record.status,
    error: record.error,
    terminalError: record.terminalError,
    resultSummary: record.resultSummary,
  };
}

export function backfillWorkerRecords(records: WorkerRecord[]): WorkerBackfillResult {
  const updatedRecords = records.map((record) => structuredClone(record));
  const changes: WorkerBackfillChange[] = [];
  for (const record of updatedRecords) {
    if (!isTerminalWorkerStatus(record.status)) continue;
    const before = trackedWorkerFields(record);
    reconcileTerminalWorkerRecord(record);
    const after = trackedWorkerFields(record);
    const changedFields = Object.keys(after).filter(
      (key) => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(after[key as keyof typeof after]),
    );
    if (changedFields.length > 0) {
      changes.push({
        workerId: record.id,
        dryRun: true,
        changedFields,
      });
    }
  }
  return { updatedRecords, changes };
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
  private rulesContextProvider?: WorkerRulesContextProvider;

  constructor(
    private registry: BotRegistry,
    private logger: Logger,
    private config: WorkerManagerConfig,
  ) {
    this.records = loadRecords();
    const recordsToResume: WorkerRecord[] = [];
    for (const r of this.records) {
      if (r.status === 'running') {
        r.error = 'metabot restarted while worker was running; automatically restarting worker';
        r.startTime = Date.now();
        delete r.endTime;
        delete r.durationMs;
        delete r.costUsd;
        delete r.resultSummary;
        recordsToResume.push(r);
      }
    }
    this.persist();
    if (recordsToResume.length > 0) {
      setImmediate(() => this.resumeWorkersAfterRestart(recordsToResume));
    }
  }

  setRulesContextProvider(provider: WorkerRulesContextProvider | undefined): void {
    this.rulesContextProvider = provider;
  }

  dispatch(input: DispatchInput): WorkerRecord {
    const { botName, pmChatId, workingDirectory, label } = input;
    const dedupeKey = normalizeDedupeKey(input.dedupeKey);
    if (dedupeKey) {
      const existing = this.findReusableWorker(pmChatId, dedupeKey);
      if (existing) {
        this.logger.info({ workerId: existing.id, pmChatId, dedupeKey }, 'Worker dispatch deduped to existing record');
        return existing;
      }
    }

    const runningCount = this.records.filter((r) => r.pmChatId === pmChatId && r.status === 'running').length;
    if (runningCount >= this.config.maxPerPm) {
      throw new Error(`Max concurrent workers (${this.config.maxPerPm}) reached for this PM chat`);
    }

    const bot = this.registry.get(botName);
    if (!bot) {
      throw new Error(`Bot not found: ${botName}`);
    }

    const { model, engine } = resolveWorkerModel(input.model, input.engine, this.config.defaultModel);
    const id = crypto.randomUUID().slice(0, 8);
    const workerChatId = `worker-${id}`;
    const runtimePrompt = this.withRulesContext(input.prompt, {
      botName,
      pmChatId,
      workerChatId,
      workingDirectory,
      label,
    });
    const effectiveTimeouts = normalizeWorkerTimeouts(input);

    const record: WorkerRecord = {
      id,
      botName,
      pmChatId,
      workerChatId,
      workingDirectory,
      prompt: runtimePrompt,
      label,
      model,
      engine,
      reasoningEffort: input.reasoningEffort,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
      timeoutMs: effectiveTimeouts.timeoutMs,
      idleTimeoutMs: effectiveTimeouts.idleTimeoutMs,
      dedupeKey,
      outputContract: validateDispatchOutputContract(input.outputContract) ?? inferOutputContract(input),
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

    this.logger.info(
      {
        workerId: id,
        botName,
        pmChatId,
        workerChatId: record.workerChatId,
        workDir: workingDirectory,
        model,
        engine,
        reasoningEffort: input.reasoningEffort,
        label,
        dedupeKey,
        timeoutAdjusted: effectiveTimeouts.adjusted,
        timeoutMs: record.timeoutMs,
        idleTimeoutMs: record.idleTimeoutMs,
      },
      'Worker dispatched',
    );

    return record;
  }

  private findReusableWorker(pmChatId: string, dedupeKey: string): WorkerRecord | undefined {
    const now = Date.now();
    return this.records
      .filter((record) => record.pmChatId === pmChatId && record.dedupeKey === dedupeKey)
      .filter((record) => {
        if (record.status === 'running') return true;
        if (record.status !== 'completed') return false;
        return now - (record.endTime ?? record.startTime) <= WORKER_DEDUPE_COMPLETED_TTL_MS;
      })
      .sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime))[0];
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

  completeWorkerFromExternal(id: string, patch: { resultSummary?: string; error?: string } = {}): boolean {
    const record = this.records.find((r) => r.id === id);
    if (!record || record.status !== 'running') return false;

    record.status = 'completed';
    record.endTime = Date.now();
    record.durationMs = record.endTime - record.startTime;
    record.resultSummary = patch.resultSummary ?? record.resultSummary;
    if (patch.error !== undefined) record.error = patch.error;
    this.persist();

    const bot = this.registry.get(record.botName);
    if (bot) {
      bot.bridge.stopChatTask(record.workerChatId);
    }

    this.logger.info({ workerId: id }, 'Worker marked completed by external lifecycle owner');
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
  finishSyntheticTask(
    id: string,
    patch: {
      status: 'completed' | 'failed' | 'aborted';
      costUsd?: number;
      durationMs?: number;
      resultSummary?: string;
      error?: string;
    },
  ): void {
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

  private withRulesContext(prompt: string, input: Parameters<NonNullable<WorkerRulesContextProvider>>[0]): string {
    const context = this.rulesContextProvider?.(input)?.trim();
    return context ? `${context}\n\n${prompt}` : prompt;
  }

  private resumeWorkersAfterRestart(records: WorkerRecord[]): void {
    for (const record of records) {
      const bot = this.registry.get(record.botName);
      if (!bot) {
        record.status = 'failed';
        record.endTime = Date.now();
        record.durationMs = record.endTime - record.startTime;
        record.error = 'metabot restarted while worker was running; bot not found during worker recovery';
        this.persist();
        this.logger.warn(
          { workerId: record.id, botName: record.botName },
          'Could not restart worker after bridge restart: bot not found',
        );
        continue;
      }
      this.logger.info(
        { workerId: record.id, botName: record.botName, workerChatId: record.workerChatId },
        'Restarting worker after bridge restart',
      );
      this.runWorker(record, bot).catch((err) => {
        this.logger.error({ err, workerId: record.id }, 'Restarted worker execution failed unexpectedly');
      });
    }
  }

  private async runWorker(record: WorkerRecord, bot: { bridge: MessageBridge }): Promise<void> {
    const startTime = Date.now();
    try {
      const result = await bot.bridge.executeApiTask({
        prompt: record.prompt,
        chatId: record.workerChatId,
        userId: 'worker-manager',
        sendCards: false,
        lifecycleKey: `worker:${record.id}`,
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

      if (record.status !== 'running') {
        if (record.resultSummary === undefined && result.responseText) {
          record.resultSummary = result.responseText.slice(0, 500);
        }
      } else if (result.success) {
        record.status = 'completed';
        record.executionStatus = 'completed';
        record.resultSummary = result.responseText?.slice(0, 500) || '';
        this.reconcileTerminalArtifact(record);
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
    reconcileTerminalWorkerRecord(record, {
      onLegacyAliasDeprecation: (event) => {
        this.logger.warn(
          {
            workerId: record.id,
            projectId: event.project_id,
            runId: event.run_id,
            candidateIndex: event.candidate_index,
            aliasNames: event.alias_names,
            aliases: event.aliases,
          },
          'AutoResearchClaw output used deprecated memory_event_candidates aliases',
        );
      },
    });
  }

  private async notifyPm(record: WorkerRecord): Promise<void> {
    const bot = this.registry.get(record.botName);
    if (!bot) return;

    const statusEmoji = record.status === 'completed' ? '✅' : record.status === 'aborted' ? '⏹️' : '❌';
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
      record.executionStatus && record.executionStatus !== record.status
        ? `Execution status: ${record.executionStatus}`
        : '',
      record.outputContract ? `Output contract: ${record.outputContract.name}` : '',
      record.artifactStatus && record.artifactStatus !== 'unknown'
        ? `Artifact status: ${record.artifactStatus}${record.artifactPath ? ` (${record.artifactPath})` : ''}`
        : '',
      record.contractStatus && record.contractStatus !== 'not_declared'
        ? `Contract status: ${record.contractStatus}`
        : '',
      record.artifactError ? `Artifact error: ${record.artifactError.code}: ${record.artifactError.message}` : '',
      record.detailRoute ? `Detail route: ${record.detailRoute}` : '',
      record.finalPayloadRef ? `Final payload ref: ${record.finalPayloadRef}` : '',
      record.finalTranscriptRef ? `Final transcript ref: ${record.finalTranscriptRef}` : '',
      record.resultSummary ? `Result summary: ${record.resultSummary.slice(0, 300)}` : '',
      record.error ? `Error: ${record.error}` : '',
      record.terminalError ? `Terminal warning: ${record.terminalError}` : '',
      '',
      "Please review the worker's output in the working directory and decide next steps.",
      'Check: worker-progress.json, results.json, train.log, and code changes.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await bot.bridge.executeApiTask({
        prompt: notifyPrompt,
        chatId: record.pmChatId,
        userId: 'worker-manager',
        sendCards: true,
        lifecycleKey: `worker-notify:${record.id}`,
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
