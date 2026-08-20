export const WORKER_ENGINES = ['codex', 'claude', 'kimi'] as const;
export type WorkerEngine = (typeof WORKER_ENGINES)[number];

export const WORKER_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'timed_out',
  'aborted',
  'recovery_required',
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];
export type TerminalWorkerStatus = Exclude<WorkerStatus, 'queued' | 'running'>;

export const TRUSTED_PRINCIPAL_ROLES = ['admin', 'user', 'pm', 'manager', 'agent', 'worker'] as const;
export type TrustedPrincipalRole = (typeof TRUSTED_PRINCIPAL_ROLES)[number];
export const TRUSTED_PRINCIPAL_BOT_NAME_MAX_LENGTH = 200;
export const TRUSTED_PRINCIPAL_CHAT_ID_MAX_LENGTH = 500;

export const WORKER_MUTATING_ROLES = ['user', 'pm'] as const;
export type WorkerMutatingRole = (typeof WORKER_MUTATING_ROLES)[number];

export const LOCAL_LIFECYCLE_ADMIN_PRINCIPAL = {
  role: 'admin',
  botName: 'metabot-local-lifecycle',
  chatId: 'local:daemon-lifecycle',
} as const satisfies TrustedPrincipal;

export const ARC_SERVICE_PRINCIPAL = {
  role: 'pm',
  botName: 'arc-service',
  chatId: 'local:arc-service',
} as const satisfies TrustedPrincipal;

/** Trusted identity pinned by the process that starts this MCP server. */
export interface TrustedPrincipal {
  role: TrustedPrincipalRole;
  botName: string;
  chatId: string;
}

export function isLocalLifecycleAdmin(principal: TrustedPrincipal): boolean {
  return (
    principal.role === LOCAL_LIFECYCLE_ADMIN_PRINCIPAL.role &&
    principal.botName === LOCAL_LIFECYCLE_ADMIN_PRINCIPAL.botName &&
    principal.chatId === LOCAL_LIFECYCLE_ADMIN_PRINCIPAL.chatId
  );
}

export function isArcServicePrincipal(principal: TrustedPrincipal): boolean {
  return (
    principal.role === ARC_SERVICE_PRINCIPAL.role &&
    principal.botName === ARC_SERVICE_PRINCIPAL.botName &&
    principal.chatId === ARC_SERVICE_PRINCIPAL.chatId
  );
}

/**
 * Caller-supplied, engine-neutral final-response instructions. The runner
 * stores and forwards this declaration but never inspects workdir artifacts.
 */
export interface GenericOutputContract {
  format: 'text' | 'json';
  description?: string;
  jsonSchema?: Record<string, unknown>;
}

export interface RestartRecoveryPolicy {
  restart: 'manual' | 'relaunch';
  idempotent: boolean;
}

export interface DedupePolicy {
  completedTtlMs: number;
  retryTerminal: boolean;
}

export interface DispatchWorkerInput {
  workdir: string;
  prompt: string;
  engine: WorkerEngine;
  model?: string;
  label?: string;
  dedupeKey?: string;
  dedupePolicy?: Partial<DedupePolicy>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  recoveryPolicy?: RestartRecoveryPolicy;
  outputContract?: GenericOutputContract;
}

export interface ScopedDispatchWorkerInput extends DispatchWorkerInput {
  botName: string;
  chatId: string;
  principalRole: TrustedPrincipalRole;
  executionKind: 'worker' | 'arc';
  authorizingCapability?: string;
  /** Private signed carrier; omitted from WorkerRecord and all public output. */
  rulesPackChildGrantJson?: string;
  rulesPackChildGrantDigest?: string;
  dedupePolicy: DedupePolicy;
  timeoutMs: number;
  idleTimeoutMs: number;
  recoveryPolicy: RestartRecoveryPolicy;
}

export interface WorkerRecord {
  id: string;
  botName: string;
  chatId: string;
  principalRole: TrustedPrincipalRole | 'unknown';
  executionKind: 'worker' | 'arc' | 'unknown';
  workdir: string;
  prompt: string;
  engine: WorkerEngine;
  model?: string;
  label?: string;
  dedupeKey?: string;
  dedupePolicy: DedupePolicy;
  timeoutMs: number;
  idleTimeoutMs: number;
  recoveryPolicy: RestartRecoveryPolicy;
  outputContract?: GenericOutputContract;
  status: WorkerStatus;
  launchId?: string;
  pid?: number;
  launchCount: number;
  recoveryCount: number;
  createdAt: number;
  startedAt?: number;
  lastActivityAt?: number;
  finishedAt?: number;
  durationMs?: number;
  exitCode?: number;
  signal?: string;
  terminalReason?: string;
  stdout?: string;
  stderr?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
  notificationState: 'pending' | 'sending' | 'delivered' | 'failed';
  notificationAttempts: number;
  notificationNextAttemptAt?: number;
  notificationLastError?: string;
  notificationDeliveredAt?: number;
}

export interface DispatchWorkerResult {
  worker: WorkerRecord;
  deduplicated: boolean;
  retriedTerminal: boolean;
}

/**
 * Strict, bounded wake-up metadata for a Worker terminal callback. Full
 * process results remain available only through worker_status.
 */
export interface WorkerTerminalCallbackMetadata {
  id: string;
  label?: string;
  engine: WorkerEngine;
  status: TerminalWorkerStatus;
  exitCode?: number;
  durationMs?: number;
}

export interface CompletionNotification {
  eventId: string;
  eventType: 'worker.terminal';
  botName: string;
  chatId: string;
  finishedAt: number;
  authorizingCapability?: string;
  worker: WorkerTerminalCallbackMetadata;
}

export interface TerminalCallbackEnvelope<TPayload = unknown> {
  contract_version: 'metabot.terminal-callback.v1';
  purpose: 'worker.terminal' | 'arc.terminal';
  event_id: string;
  bot_name: string;
  chat_id: string;
  status: string;
  finished_at: number;
  iat: number;
  authorizing_capability: string;
  payload: TPayload;
}

export interface CompletionNotifier {
  notify(notification: CompletionNotification): Promise<void>;
}

export interface ProcessLaunchSpec {
  id: string;
  launchId: string;
  engine: WorkerEngine;
  model?: string;
  workdir: string;
  prompt: string;
  outputContract?: GenericOutputContract;
  rulesPack?: PreparedWorkerRulesPack;
}

export interface PreparedWorkerRulesPack {
  injectionText: string;
  packDigest: string;
  markInjected(): void;
  markRejected(reason: unknown): void;
}

export type WorkerRulesPackMode = 'off' | 'shadow' | 'enforce';

export interface WorkerRulesPackControlStatus {
  botName: string;
  state: 'configured' | 'unconfigured' | 'opted-out' | 'unsupported' | 'standalone-shared';
  botScoped: boolean;
  mode: WorkerRulesPackMode;
  configuredMode?: WorkerRulesPackMode;
  operatorModeOverride?: {
    mode: WorkerRulesPackMode;
    updatedAt: string;
  };
  operatorModeVersion: number;
  operatorModeOperationId?: string;
  appliesTo: 'subsequent-codex-policy-preparations';
  inFlight: 'unchanged';
}

export interface WorkerRulesPackProvider {
  prepare(worker: WorkerRecord, childGrant?: import('@metabot/rulespack').RulesPackChildGrantV1): Promise<PreparedWorkerRulesPack | undefined>;
  controlStatus?(botName: string): WorkerRulesPackControlStatus;
  setControlMode?(
    botName: string,
    mode: WorkerRulesPackMode | null,
    expectedVersion: number,
    operationId: string,
  ): WorkerRulesPackControlStatus;
  close?(): void;
}

export interface ProcessLaunchHooks {
  onActivity(): void;
}

export interface ProcessResult {
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export interface RunningProcess {
  pid: number;
  completion: Promise<ProcessResult>;
}

export interface ProcessRunner {
  launch(spec: ProcessLaunchSpec, hooks: ProcessLaunchHooks): Promise<RunningProcess>;
  abort(pid: number): Promise<void>;
}

export interface WorkerServiceConfig {
  maxConcurrentPerScope: number;
  defaultTimeoutMs: number;
  defaultIdleTimeoutMs: number;
  maxTimeoutMs: number;
  maxIdleTimeoutMs: number;
  defaultDedupeTtlMs: number;
  maxDedupeTtlMs: number;
  maxListLimit: number;
  notificationRetryInitialMs: number;
  notificationRetryMaxMs: number;
}

export class WorkerRunnerError extends Error {
  constructor(
    message: string,
    readonly code: 'FORBIDDEN' | 'INVALID_INPUT' | 'NOT_FOUND' | 'CONCURRENCY_LIMIT' | 'CONFLICT' | 'DATA_DIR_LOCKED',
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkerRunnerError';
  }
}
