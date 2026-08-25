export const RULE_SCHEMA_VERSION = 1 as const;
export const PACK_SCHEMA_VERSION = 1 as const;
export const COMPILER_VERSION = 'rulespack-compiler/1.2.0';

export type RuleScope = 'global' | 'user' | 'project' | 'chat' | 'task';
export type RuleAuthority =
  | 'platform'
  | 'runtime'
  | 'user-current'
  | 'user-approved'
  | 'project'
  | 'advisory';
export type RuleLifecycleStatus = 'approved' | 'revoked';
export type RulesMode = 'off' | 'shadow' | 'enforce';
export type SourceKind =
  | 'config'
  | 'ruleset'
  | 'file'
  | 'temporary'
  | 'metamemory'
  | 'curated';
export type SourceHealth = 'fresh' | 'stale' | 'unavailable' | 'invalid';
export type DeliveryChannel = 'user';

export interface ExactTargets {
  bots?: readonly string[];
  roles?: readonly string[];
  agents?: readonly string[];
  workers?: readonly string[];
  hosts?: readonly string[];
  tools?: readonly string[];
  dataClasses?: readonly string[];
  outputTypes?: readonly string[];
}

export interface RuleTargets {
  include?: ExactTargets;
  exclude?: ExactTargets;
}

export interface RuleBinding {
  /** Exact envelope target lock, covering every ExecutionSubject dimension. */
  subjectFingerprint?: string;
  userId?: string;
  projectId?: string;
  chatId?: string;
  taskId?: string;
  hostId?: string;
}

export interface RuleSource {
  kind: SourceKind;
  adapterId: string;
  ref: string;
  revision: string;
  trustedAuthority?: boolean;
}

export interface RuleLifecycle {
  status: RuleLifecycleStatus;
  validFrom?: string;
  expiresAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

export interface RuleV1 {
  schemaVersion: typeof RULE_SCHEMA_VERSION;
  id: string;
  version: string;
  digest: string;
  text: string;
  tokenEstimate: number;
  conflictKey?: string;
  dependencies?: readonly string[];
  scope: RuleScope;
  binding?: RuleBinding;
  targets: RuleTargets;
  authority: RuleAuthority;
  priority: number;
  overridable: boolean;
  mandatory?: boolean;
  lifecycle: RuleLifecycle;
  source: RuleSource;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RuleInputV1 extends Omit<RuleV1, 'digest' | 'tokenEstimate'> {
  digest?: string;
  tokenEstimate?: number;
}

export interface ExecutionSubject {
  hostId: string;
  bot: string;
  roles: readonly string[];
  agent?: string;
  worker?: string;
  userId?: string;
  projectId?: string;
  chatId: string;
  taskId?: string;
  tools: readonly string[];
  dataClasses: readonly string[];
  outputTypes: readonly string[];
  engine: 'codex' | 'claude';
  sessionId?: string;
}

export type SelectionDisposition =
  | 'selected'
  | 'scope-mismatch'
  | 'target-not-included'
  | 'target-excluded'
  | 'not-yet-valid'
  | 'expired'
  | 'revoked'
  | 'conflict-overridden'
  | 'duplicate-content'
  | 'dependency-added'
  | 'dependency-missing'
  | 'dependency-inapplicable'
  | 'budget-excluded';

export interface RuleDecision {
  ruleId: string;
  version: string;
  digest: string;
  disposition: SelectionDisposition;
  reason: string;
  relatedRuleId?: string;
}

export interface SelectedRule extends RuleV1 {
  selectionReason: string;
  dependencyOf?: readonly string[];
}

export interface SourceGeneration {
  sourceId: string;
  kind: SourceKind;
  generation: string;
  revision: string;
  snapshotDigest: string;
  observedAt: string;
  freshUntil?: string;
  /** Required sources fail closed once unavailable or past freshness. */
  required: boolean;
  health: SourceHealth;
  error?: string;
  ruleCount: number;
}

export interface SourceSnapshot {
  source: SourceGeneration;
  rules: readonly RuleV1[];
}

export interface CompileBudget {
  maxTokens: number;
  maxCharacters: number;
}

export interface CompileTelemetry {
  compileLatencyMs: number;
  cache: 'hit-memory' | 'hit-persistent' | 'miss' | 'bypass-off';
  candidateCount: number;
  selectedRuleCount: number;
  excludedRuleCount: number;
  tokenCount: number;
  characterCount: number;
  packDigest: string;
  degraded: boolean;
  usedLastKnownGood: boolean;
  sourceFreshness: readonly SourceGeneration[];
}

export interface CompiledRulesPack {
  schemaVersion: typeof PACK_SCHEMA_VERSION;
  compilerVersion: string;
  packId: string;
  packDigest: string;
  compiledAt: string;
  expiresAt?: string;
  target: ExecutionSubject;
  subjectFingerprint: string;
  sourceSnapshotDigest: string;
  sourceGenerations: readonly SourceGeneration[];
  budget: CompileBudget;
  rules: readonly SelectedRule[];
  decisions: readonly RuleDecision[];
  renderedText: string;
  estimatedTokens: number;
  characters: number;
  deliveryChannel: DeliveryChannel;
  mode: RulesMode;
  degraded: boolean;
  degradationReasons: readonly string[];
  lastKnownGood: boolean;
}

export interface CompileRequest {
  subject: ExecutionSubject;
  rules: readonly RuleV1[];
  sourceGenerations: readonly SourceGeneration[];
  budget: CompileBudget;
  mode?: RulesMode;
  now?: string;
  degradationReasons?: readonly string[];
}

export interface CompileExplanation {
  pack: CompiledRulesPack;
  summary: {
    selected: number;
    rejected: number;
    tokens: number;
    characters: number;
    degraded: boolean;
  };
}

export interface DeliveryReceipt {
  receiptId: string;
  packDigest: string;
  subjectFingerprint: string;
  target: ExecutionSubject;
  status: 'compiled' | 'shadowed' | 'injected' | 'consumed' | 'rejected';
  channel: DeliveryChannel;
  occurredAt: string;
  issuer?: string;
  audience?: string;
  replayId?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RulesFeedback {
  feedbackId: string;
  packDigest: string;
  kind: 'wrong' | 'missing' | 'unhelpful' | 'helpful';
  message: string;
  ruleId?: string;
  actor?: string;
  createdAt: string;
}

export interface AuditEvent {
  eventId: string;
  type:
    | 'source-refresh'
    | 'compile'
    | 'cache-hit'
    | 'cache-miss'
    | 'lkg-used'
    | 'rule-upsert'
    | 'rule-revoke'
    | 'receipt'
    | 'feedback';
  occurredAt: string;
  subjectFingerprint?: string;
  packDigest?: string;
  ruleId?: string;
  sourceId?: string;
  data: Readonly<Record<string, unknown>>;
}

export interface RulesPackStatus {
  mode: RulesMode;
  compilerVersion: string;
  inMemoryCacheEntries: number;
  persistentCacheEntries: number;
  currentRules: number;
  revokedRules: number;
  sources: readonly SourceGeneration[];
  lastCompile?: CompileTelemetry;
}
