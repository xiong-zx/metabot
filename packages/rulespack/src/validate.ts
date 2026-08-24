import { digestObject } from './canonical.js';
import { RulesPackError } from './errors.js';
import {
  RULE_SCHEMA_VERSION,
  type ExactTargets,
  type ExecutionSubject,
  type RuleAuthority,
  type RuleInputV1,
  type RuleScope,
  type RuleV1,
  type DeliveryReceipt,
  type RulesFeedback,
  type SourceGeneration,
  type SourceKind,
} from './model.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SCOPES = new Set<RuleScope>(['global', 'user', 'project', 'chat', 'task']);
const AUTHORITIES = new Set<RuleAuthority>([
  'platform',
  'runtime',
  'user-current',
  'user-approved',
  'project',
  'advisory',
]);
const SOURCE_KINDS = new Set<SourceKind>([
  'config',
  'ruleset',
  'file',
  'temporary',
  'metamemory',
  'curated',
]);
const TARGET_KEYS: readonly (keyof ExactTargets)[] = [
  'bots',
  'roles',
  'agents',
  'workers',
  'hosts',
  'tools',
  'dataClasses',
  'outputTypes',
];
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:sk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/iu,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,}/iu,
];

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new RulesPackError('VALIDATION_ERROR', message, details);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length) fail(`${label} contains unsupported fields`, { fields: unexpected.sort() });
}

function requiredString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`, { value });
  return value;
}

function optionalIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const text = requiredString(value, label, ISO_DATE_PATTERN);
  if (!Number.isFinite(Date.parse(text))) fail(`${label} is not a valid timestamp`);
  return text;
}

function stringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const normalized = [...new Set(value.map((entry, index) => requiredString(entry, `${label}[${index}]`, ID_PATTERN)))];
  return normalized.sort();
}

function exactTargets(value: unknown, label: string): ExactTargets | undefined {
  if (value === undefined) return undefined;
  assertObject(value, label);
  assertOnlyKeys(value, TARGET_KEYS, label);
  const result: Record<string, readonly string[]> = {};
  for (const key of TARGET_KEYS) {
    const parsed = stringArray(value[key], `${label}.${key}`);
    if (parsed?.length) result[key] = parsed;
  }
  return Object.keys(result).length ? (result as ExactTargets) : undefined;
}

export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  return Math.max(1, Math.ceil(Math.max(bytes / 4, words * 1.3)));
}

export function redactDiagnostic(text: string, maxLength = 512): string {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
    ? '[REDACTED CREDENTIAL-LIKE DIAGNOSTIC]'
    : text.slice(0, maxLength);
}

export const RENDER_BEGIN = '--- BEGIN RULESPACK DATA v1 ---';
export const RENDER_END = '--- END RULESPACK DATA v1 ---';
export const RENDER_RULE_BEGIN = '--- BEGIN RULE ---';
export const RENDER_RULE_END = '--- END RULE ---';

export function assertSafeRuleText(text: string): void {
  if (text.length === 0 || text.length > 16_384) {
    throw new RulesPackError('UNSAFE_RULE_TEXT', 'Rule text must contain 1 to 16384 characters');
  }
  if (
    text.includes(RENDER_BEGIN) ||
    text.includes(RENDER_END) ||
    text.includes(RENDER_RULE_BEGIN) ||
    text.includes(RENDER_RULE_END)
  ) {
    throw new RulesPackError('UNSAFE_RULE_TEXT', 'Rule text contains a reserved RulesPack delimiter');
  }
  if (/\p{Cc}/u.test(text.replace(/[\n\r\t]/g, ''))) {
    throw new RulesPackError('UNSAFE_RULE_TEXT', 'Rule text contains control characters');
  }
  if (/[\u202A-\u202E\u2066-\u2069]/u.test(text)) {
    throw new RulesPackError('UNSAFE_RULE_TEXT', 'Rule text contains bidirectional override characters');
  }
  const promotionPatterns = [
    /(?:^|\n)\s*(?:system|developer)\s*:/iu,
    /<\/?(?:system|developer)(?:\s|>)/iu,
    /\b(?:platform|runtime|system)\s+authority\b/iu,
    /\b(?:highest|higher|top)\s+(?:authority|priority)\b/iu,
    /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|other)\s+instructions?\b/iu,
  ];
  if (promotionPatterns.some((pattern) => pattern.test(text))) {
    throw new RulesPackError(
      'UNSAFE_RULE_TEXT',
      'Rule text attempts to promote its own authority or impersonate a privileged channel',
    );
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new RulesPackError('UNSAFE_RULE_TEXT', 'Rule text appears to contain credential material');
  }
}

function expectedRuleDigest(rule: Omit<RuleV1, 'digest'>): string {
  return digestObject(rule);
}

export function normalizeRule(input: RuleInputV1): RuleV1 {
  assertObject(input, 'rule');
  assertOnlyKeys(
    input,
    [
      'schemaVersion', 'id', 'version', 'digest', 'text', 'tokenEstimate', 'conflictKey',
      'dependencies', 'scope', 'binding', 'targets', 'authority', 'priority',
      'overridable', 'mandatory', 'lifecycle', 'source', 'metadata',
    ],
    'rule',
  );
  if (input.schemaVersion !== RULE_SCHEMA_VERSION) fail('rule.schemaVersion must be 1');
  const id = requiredString(input.id, 'rule.id', ID_PATTERN);
  const version = requiredString(input.version, 'rule.version', VERSION_PATTERN);
  const text = requiredString(input.text, 'rule.text');
  assertSafeRuleText(text);
  if (!SCOPES.has(input.scope)) fail('rule.scope is invalid');
  if (!AUTHORITIES.has(input.authority)) fail('rule.authority is invalid');
  if (!Number.isSafeInteger(input.priority) || input.priority < -1_000_000 || input.priority > 1_000_000) {
    fail('rule.priority must be an integer between -1000000 and 1000000');
  }
  if (typeof input.overridable !== 'boolean') fail('rule.overridable must be boolean');
  if (input.mandatory !== undefined && typeof input.mandatory !== 'boolean') fail('rule.mandatory must be boolean');

  assertObject(input.lifecycle, 'rule.lifecycle');
  assertOnlyKeys(input.lifecycle, ['status', 'validFrom', 'expiresAt', 'revokedAt', 'revokeReason'], 'rule.lifecycle');
  if (input.lifecycle.status !== 'approved' && input.lifecycle.status !== 'revoked') {
    fail('rule.lifecycle.status is invalid');
  }
  const validFrom = optionalIsoDate(input.lifecycle.validFrom, 'rule.lifecycle.validFrom');
  const expiresAt = optionalIsoDate(input.lifecycle.expiresAt, 'rule.lifecycle.expiresAt');
  const revokedAt = optionalIsoDate(input.lifecycle.revokedAt, 'rule.lifecycle.revokedAt');
  if (validFrom && expiresAt && Date.parse(validFrom) >= Date.parse(expiresAt)) {
    fail('rule lifecycle validFrom must precede expiresAt');
  }
  if (input.lifecycle.status === 'revoked' && !revokedAt) {
    fail('revoked rules require lifecycle.revokedAt');
  }

  assertObject(input.source, 'rule.source');
  assertOnlyKeys(input.source, ['kind', 'adapterId', 'ref', 'revision', 'trustedAuthority'], 'rule.source');
  if (!SOURCE_KINDS.has(input.source.kind)) fail('rule.source.kind is invalid');
  const source = {
    kind: input.source.kind,
    adapterId: requiredString(input.source.adapterId, 'rule.source.adapterId', ID_PATTERN),
    ref: requiredString(input.source.ref, 'rule.source.ref'),
    revision: requiredString(input.source.revision, 'rule.source.revision'),
    ...(input.source.trustedAuthority === undefined
      ? {}
      : { trustedAuthority: input.source.trustedAuthority }),
  };
  if (
    (input.authority === 'platform' || input.authority === 'runtime') &&
    source.trustedAuthority !== true
  ) {
    fail('platform/runtime authority requires a trusted compiler-owned source');
  }
  if (input.authority === 'user-current' && input.source.kind !== 'temporary') {
    fail('user-current authority is only valid for authenticated structured temporary rules');
  }

  if (input.binding) {
    assertObject(input.binding, 'rule.binding');
    assertOnlyKeys(
      input.binding,
      ['subjectFingerprint', 'userId', 'projectId', 'chatId', 'taskId', 'hostId'],
      'rule.binding',
    );
  }
  const binding = input.binding
    ? Object.fromEntries(
        Object.entries(input.binding).map(([key, value]) => [
          key,
          requiredString(value, `rule.binding.${key}`, ID_PATTERN),
        ]),
      )
    : undefined;
  const requiredBinding: Partial<Record<RuleScope, keyof NonNullable<RuleV1['binding']>>> = {
    user: 'userId',
    project: 'projectId',
    chat: 'chatId',
    task: 'taskId',
  };
  const bindingKey = requiredBinding[input.scope];
  if (bindingKey && !binding?.[bindingKey]) fail(`${input.scope} scope requires binding.${bindingKey}`);

  assertObject(input.targets, 'rule.targets');
  assertOnlyKeys(input.targets, ['include', 'exclude'], 'rule.targets');
  const include = exactTargets(input.targets.include, 'rule.targets.include');
  const exclude = exactTargets(input.targets.exclude, 'rule.targets.exclude');
  const dependencies = stringArray(input.dependencies, 'rule.dependencies');
  if (dependencies?.includes(id)) fail('rule cannot depend on itself');
  const tokenEstimate = estimateTokens(text);
  if (input.tokenEstimate !== undefined && input.tokenEstimate !== tokenEstimate) {
    fail('rule.tokenEstimate does not match the deterministic estimator', {
      supplied: input.tokenEstimate,
      expected: tokenEstimate,
    });
  }

  const withoutDigest: Omit<RuleV1, 'digest'> = {
    schemaVersion: RULE_SCHEMA_VERSION,
    id,
    version,
    text,
    tokenEstimate,
    ...(input.conflictKey
      ? { conflictKey: requiredString(input.conflictKey, 'rule.conflictKey', ID_PATTERN) }
      : {}),
    ...(dependencies?.length ? { dependencies } : {}),
    scope: input.scope,
    ...(binding && Object.keys(binding).length ? { binding } : {}),
    targets: {
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
    },
    authority: input.authority,
    priority: input.priority,
    overridable: input.overridable,
    ...(input.mandatory === undefined ? {} : { mandatory: input.mandatory }),
    lifecycle: {
      status: input.lifecycle.status,
      ...(validFrom ? { validFrom } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(revokedAt ? { revokedAt } : {}),
      ...(input.lifecycle.revokeReason
        ? { revokeReason: requiredString(input.lifecycle.revokeReason, 'rule.lifecycle.revokeReason') }
        : {}),
    },
    source,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const digest = expectedRuleDigest(withoutDigest);
  if (input.digest !== undefined && input.digest !== digest) {
    fail('rule.digest does not match canonical rule content', { supplied: input.digest, expected: digest });
  }
  return { ...withoutDigest, digest };
}

export function validateRule(value: unknown): RuleV1 {
  assertObject(value, 'rule');
  return normalizeRule(value as unknown as RuleInputV1);
}

export function validateExecutionSubject(value: unknown): ExecutionSubject {
  assertObject(value, 'subject');
  assertOnlyKeys(
    value,
    [
      'hostId', 'bot', 'roles', 'agent', 'worker', 'userId', 'projectId', 'chatId',
      'taskId', 'tools', 'dataClasses', 'outputTypes', 'engine', 'sessionId',
    ],
    'subject',
  );
  if (value.engine !== 'codex') fail('subject.engine must be codex');
  const roles = stringArray(value.roles, 'subject.roles') ?? [];
  const tools = stringArray(value.tools, 'subject.tools') ?? [];
  const dataClasses = stringArray(value.dataClasses, 'subject.dataClasses') ?? [];
  const outputTypes = stringArray(value.outputTypes, 'subject.outputTypes') ?? [];
  return {
    hostId: requiredString(value.hostId, 'subject.hostId', ID_PATTERN),
    bot: requiredString(value.bot, 'subject.bot', ID_PATTERN),
    roles,
    ...(value.agent === undefined ? {} : { agent: requiredString(value.agent, 'subject.agent', ID_PATTERN) }),
    ...(value.worker === undefined
      ? {}
      : { worker: requiredString(value.worker, 'subject.worker', ID_PATTERN) }),
    ...(value.userId === undefined
      ? {}
      : { userId: requiredString(value.userId, 'subject.userId', ID_PATTERN) }),
    ...(value.projectId === undefined
      ? {}
      : { projectId: requiredString(value.projectId, 'subject.projectId', ID_PATTERN) }),
    chatId: requiredString(value.chatId, 'subject.chatId', ID_PATTERN),
    ...(value.taskId === undefined
      ? {}
      : { taskId: requiredString(value.taskId, 'subject.taskId', ID_PATTERN) }),
    tools,
    dataClasses,
    outputTypes,
    engine: 'codex',
    ...(value.sessionId === undefined
      ? {}
      : { sessionId: requiredString(value.sessionId, 'subject.sessionId', ID_PATTERN) }),
  };
}

export function parseRuleArray(value: unknown): readonly RuleV1[] {
  if (!Array.isArray(value)) fail('expected an array of rules');
  const rules = value.map(validateRule);
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) fail('a snapshot may contain only one current version per rule ID', { id: rule.id });
    ids.add(rule.id);
  }
  return rules;
}

export function validateSourceGeneration(value: unknown): SourceGeneration {
  assertObject(value, 'source generation');
  assertOnlyKeys(
    value,
    [
      'sourceId', 'kind', 'generation', 'revision', 'snapshotDigest', 'observedAt',
      'freshUntil', 'required', 'health', 'error', 'ruleCount',
    ],
    'source generation',
  );
  const health = value.health;
  if (health !== 'fresh' && health !== 'stale' && health !== 'unavailable' && health !== 'invalid') {
    fail('source generation health is invalid');
  }
  const kind = value.kind;
  if (!SOURCE_KINDS.has(kind as SourceKind)) fail('source generation kind is invalid');
  if (!Number.isSafeInteger(value.ruleCount) || Number(value.ruleCount) < 0) {
    fail('source generation ruleCount must be a non-negative integer');
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    fail('source generation required must be boolean');
  }
  return {
    sourceId: requiredString(value.sourceId, 'source.sourceId', ID_PATTERN),
    kind: kind as SourceKind,
    generation: requiredString(value.generation, 'source.generation'),
    revision: requiredString(value.revision, 'source.revision'),
    snapshotDigest: requiredString(value.snapshotDigest, 'source.snapshotDigest'),
    observedAt: optionalIsoDate(value.observedAt, 'source.observedAt') ?? fail('source.observedAt is required'),
    ...(value.freshUntil === undefined ? {} : { freshUntil: optionalIsoDate(value.freshUntil, 'source.freshUntil') as string }),
    required: value.required === true,
    health,
    ...(value.error === undefined ? {} : { error: requiredString(value.error, 'source.error') }),
    ruleCount: Number(value.ruleCount),
  };
}

export function validateDeliveryReceipt(value: unknown): DeliveryReceipt {
  assertObject(value, 'receipt');
  assertOnlyKeys(
    value,
    [
      'receiptId', 'packDigest', 'subjectFingerprint', 'target', 'status', 'channel',
      'occurredAt', 'issuer', 'audience', 'replayId', 'details',
    ],
    'receipt',
  );
  const status = value.status;
  if (!['compiled', 'shadowed', 'injected', 'consumed', 'rejected'].includes(String(status))) {
    fail('receipt.status is invalid');
  }
  if (value.channel !== 'user') fail('receipt.channel must truthfully be user');
  const target = validateExecutionSubject(value.target);
  const fingerprint = requiredString(value.subjectFingerprint, 'receipt.subjectFingerprint');
  if (fingerprint !== digestObject(target)) {
    throw new RulesPackError('TARGET_MISMATCH', 'Receipt subject fingerprint does not match its target');
  }
  return {
    receiptId: requiredString(value.receiptId, 'receipt.receiptId', ID_PATTERN),
    packDigest: requiredString(value.packDigest, 'receipt.packDigest'),
    subjectFingerprint: fingerprint,
    target,
    status: status as DeliveryReceipt['status'],
    channel: 'user',
    occurredAt: optionalIsoDate(value.occurredAt, 'receipt.occurredAt') ?? fail('receipt.occurredAt is required'),
    ...(value.issuer === undefined ? {} : { issuer: requiredString(value.issuer, 'receipt.issuer') }),
    ...(value.audience === undefined ? {} : { audience: requiredString(value.audience, 'receipt.audience') }),
    ...(value.replayId === undefined ? {} : { replayId: requiredString(value.replayId, 'receipt.replayId', ID_PATTERN) }),
    ...(value.details === undefined
      ? {}
      : { details: value.details as NonNullable<DeliveryReceipt['details']> }),
  };
}

export function validateFeedback(value: unknown): RulesFeedback {
  assertObject(value, 'feedback');
  assertOnlyKeys(value, ['feedbackId', 'packDigest', 'kind', 'message', 'ruleId', 'actor', 'createdAt'], 'feedback');
  const kind = value.kind;
  if (!['wrong', 'missing', 'unhelpful', 'helpful'].includes(String(kind))) fail('feedback.kind is invalid');
  return {
    feedbackId: requiredString(value.feedbackId, 'feedback.feedbackId', ID_PATTERN),
    packDigest: requiredString(value.packDigest, 'feedback.packDigest'),
    kind: kind as RulesFeedback['kind'],
    message: requiredString(value.message, 'feedback.message'),
    ...(value.ruleId === undefined ? {} : { ruleId: requiredString(value.ruleId, 'feedback.ruleId', ID_PATTERN) }),
    ...(value.actor === undefined ? {} : { actor: requiredString(value.actor, 'feedback.actor') }),
    createdAt: optionalIsoDate(value.createdAt, 'feedback.createdAt') ?? fail('feedback.createdAt is required'),
  };
}
