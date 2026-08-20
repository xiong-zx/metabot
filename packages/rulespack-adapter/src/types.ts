import type {
  CompileBudget,
  CompileTelemetry,
  DeliveryReceipt,
  ExecutionSubject,
  RuleInputV1,
  RulesFeedback,
  RulesMode,
  RulesPackDispatchEnvelopeV1,
  RulesPackStatus,
  EngineCompileResult,
} from '@metabot/rulespack';

export interface RulesPackLogger {
  debug(bindings: unknown, message?: string): void;
  info(bindings: unknown, message?: string): void;
  warn(bindings: unknown, message?: string): void;
  error(bindings: unknown, message?: string): void;
}

export interface RulesPackStructuredSourceConfig {
  id: string;
  revision: string;
  rules: readonly RuleInputV1[];
  required?: boolean;
  trustedAuthority?: boolean;
  freshForMs?: number;
}

export interface RulesPackNativeFileConfig {
  id: string;
  path: string;
  format?: 'json' | 'agents-json-block';
  required?: boolean;
  trustedAuthority?: boolean;
  nativeLoaded?: boolean;
  maxBytes?: number;
}

export interface RulesPackProjectBindingConfig {
  projectId: string;
  root: string;
  nativeFiles?: readonly RulesPackNativeFileConfig[];
}

export interface RulesPackProjectChatConfig {
  bot: string;
  chatId: string;
}

/** Explicit authenticated chat membership for one configured project. */
export interface RulesPackProjectChatBindingConfig {
  projectId: string;
  chats: readonly RulesPackProjectChatConfig[];
}

export interface RulesPackMetaMemoryConfig {
  id?: string;
  paths: readonly string[];
  /** Every configured path must stay under this host-local namespace. */
  hostRoot: string;
  required?: boolean;
  freshForMs?: number;
  coreUrl?: string;
}

export interface RulesPackDispatchConfig {
  issuer?: string;
  audience?: string;
  allowedIssuers?: readonly string[];
  maxEnvelopeTtlMs?: number;
}

export interface RulesPackConfig {
  /** Safe rollback default is off. */
  mode?: RulesMode;
  hostId?: string;
  dbPath?: string;
  /** Live application databases that this independently owned store must never alias. */
  protectedDbPaths?: readonly string[];
  budget?: Partial<CompileBudget>;
  cacheCapacity?: number;
  cacheTtlMs?: number;
  lastKnownGoodTtlMs?: number;
  refreshDebounceMs?: number;
  refreshIntervalMs?: number;
  configRules?: RulesPackStructuredSourceConfig;
  ruleSets?: readonly RulesPackStructuredSourceConfig[];
  curatedRules?: readonly RulesPackStructuredSourceConfig[];
  projectBindings?: readonly RulesPackProjectBindingConfig[];
  /** Exact (bot, chatId) tuples that inherit Rules bound to the named project. */
  projectChatBindings?: readonly RulesPackProjectChatBindingConfig[];
  metaMemory?: RulesPackMetaMemoryConfig;
  dispatch?: RulesPackDispatchConfig;
}

/**
 * Facts supplied by authenticated runtime code. This object is never accepted
 * from Rule text or the user prompt.
 */
export interface AuthenticatedExecutionFacts {
  botName: string;
  chatId: string;
  roles: readonly string[];
  cwd: string;
  userId?: string;
  agentName?: string;
  workerId?: string;
  /** Authenticated expected project; cwd binding remains the authority and must match it. */
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  tools?: readonly string[];
  dataClasses?: readonly string[];
  outputTypes?: readonly string[];
}

export interface AuthenticatedDispatchContext {
  /** Set only after the existing peer/capability transport gate succeeds. */
  authenticated: true;
  authenticatedIssuer: string;
}

export type RulesPackExecutionPrincipal =
  | {
      kind: 'scoped';
      source: 'chat' | 'local-admin' | 'agent-bus' | 'capability' | 'worker';
      botName: string;
      chatId: string;
      roles: readonly string[];
      userId?: string;
      agentName?: string;
      workerId?: string;
      projectId?: string;
      taskId?: string;
      tools?: readonly string[];
      dataClasses?: readonly string[];
      outputTypes?: readonly string[];
    }
  | {
      kind: 'generic';
      source: 'core-bearer';
      botName?: string;
    };

export interface PreparedRulesPackTurn {
  mode: RulesMode;
  subject: ExecutionSubject;
  packDigest: string;
  injectionText: string;
  telemetry: CompileTelemetry;
  receivedEnvelope?: RulesPackDispatchEnvelopeV1;
  /** Call only after the exact prepared input is accepted by the target child. */
  markInjected(): void;
  /** Call when the prepared input is rejected before target acceptance. */
  markRejected(reason: unknown): void;
}

export interface RulesPackOperatorStatus extends RulesPackStatus {
  dbPath: string;
  hostId: string;
  audience: string;
  operatorModeOverride?: {
    mode: RulesMode;
    updatedAt: string;
  };
  operatorModeVersion: number;
  operatorModeOperationId?: string;
  initialized: boolean;
  refreshing: boolean;
  lastRefreshAt?: string;
  lastRefreshError?: string;
  targetMismatchRejections: number;
  replayRejections: number;
}

export interface RulesPackOperator {
  status(): RulesPackOperatorStatus;
  /** Resolve the exact configured project binding for a trusted working directory. */
  projectIdForCwd(cwd: string): string | undefined;
  setMode(mode: RulesMode): RulesPackOperatorStatus;
  clearModeOverride(): RulesPackOperatorStatus;
  compareAndSetMode(
    mode: RulesMode | null,
    expectedVersion: number,
    operationId: string,
  ): RulesPackOperatorStatus;
  refresh(): Promise<RulesPackOperatorStatus>;
  clearCache(): { cleared: number; status: RulesPackOperatorStatus };
  explain(facts: AuthenticatedExecutionFacts): Promise<EngineCompileResult>;
  receipts(packDigest?: string, limit?: number): readonly DeliveryReceipt[];
  feedback(packDigest?: string, limit?: number): readonly RulesFeedback[];
  addFeedback(input: Omit<RulesFeedback, 'feedbackId' | 'createdAt'>): RulesFeedback;
  replaceTemporaryRules(input: {
    sourceId: string;
    revision: string;
    rules: readonly RuleInputV1[];
    authenticatedFacts: AuthenticatedExecutionFacts;
  }): Promise<RulesPackOperatorStatus>;
  createDispatchEnvelope(input: {
    facts?: AuthenticatedExecutionFacts;
    /** Exact target supplied only by an authenticated downstream dispatcher. */
    targetSubject?: ExecutionSubject;
    audience: string;
    required?: boolean;
    parentDispatchId?: string;
    ttlMs?: number;
    now?: string;
    targetHostId?: string;
    targetProjectId?: string;
  }): Promise<RulesPackDispatchEnvelopeV1>;
  recordDispatchRejected(envelope: RulesPackDispatchEnvelopeV1, reason: unknown): void;
}
