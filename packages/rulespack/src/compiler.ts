import { digestObject, stableId } from './canonical.js';
import { RulesPackError } from './errors.js';
import { matchRule } from './matcher.js';
import {
  COMPILER_VERSION,
  PACK_SCHEMA_VERSION,
  type CompileExplanation,
  type CompileRequest,
  type CompiledRulesPack,
  type RuleDecision,
  type RuleV1,
  type SelectedRule,
} from './model.js';
import { AUTHORITY_RANK, compareRulePrecedence, isMandatory, precedenceDescription } from './precedence.js';
import { renderRules } from './render.js';
import { validateExecutionSubject, validateRule } from './validate.js';

interface Candidate {
  rule: RuleV1;
  dependencyOf: Set<string>;
}

function decision(rule: RuleV1, disposition: RuleDecision['disposition'], reason: string, relatedRuleId?: string): RuleDecision {
  return {
    ruleId: rule.id,
    version: rule.version,
    digest: rule.digest,
    disposition,
    reason,
    ...(relatedRuleId ? { relatedRuleId } : {}),
  };
}

function lifecycleDecision(rule: RuleV1, nowMs: number): RuleDecision | undefined {
  if (rule.lifecycle.status === 'revoked') {
    return decision(rule, 'revoked', `revoked${rule.lifecycle.revokedAt ? ` at ${rule.lifecycle.revokedAt}` : ''}`);
  }
  if (rule.lifecycle.validFrom && Date.parse(rule.lifecycle.validFrom) > nowMs) {
    return decision(rule, 'not-yet-valid', `not valid until ${rule.lifecycle.validFrom}`);
  }
  if (rule.lifecycle.expiresAt && Date.parse(rule.lifecycle.expiresAt) <= nowMs) {
    return decision(rule, 'expired', `expired at ${rule.lifecycle.expiresAt}`);
  }
  return undefined;
}

function selected(rule: RuleV1, reason: string, dependencyOf: Set<string>): SelectedRule {
  return {
    ...rule,
    selectionReason: reason,
    ...(dependencyOf.size ? { dependencyOf: [...dependencyOf].sort() } : {}),
  };
}

function withinBudget(rules: readonly SelectedRule[], maxTokens: number, maxCharacters: number): boolean {
  const rendered = renderRules(rules);
  return rendered.estimatedTokens <= maxTokens && rendered.characters <= maxCharacters;
}

function dependencyClosure(
  root: Candidate,
  available: ReadonlyMap<string, Candidate>,
): readonly Candidate[] | undefined {
  const result = new Map<string, Candidate>();
  const visiting = new Set<string>();
  const visit = (candidate: Candidate): boolean => {
    if (result.has(candidate.rule.id)) return true;
    if (visiting.has(candidate.rule.id)) return false;
    visiting.add(candidate.rule.id);
    for (const dependencyId of candidate.rule.dependencies ?? []) {
      const dependency = available.get(dependencyId);
      if (!dependency || !visit(dependency)) return false;
    }
    visiting.delete(candidate.rule.id);
    result.set(candidate.rule.id, candidate);
    return true;
  };
  return visit(root) ? [...result.values()] : undefined;
}

function packDigestPayload(pack: Pick<
  CompiledRulesPack,
  | 'compilerVersion'
  | 'mode'
  | 'subjectFingerprint'
  | 'sourceSnapshotDigest'
  | 'sourceGenerations'
  | 'budget'
  | 'rules'
  | 'decisions'
  | 'renderedText'
  | 'deliveryChannel'
  | 'degraded'
  | 'degradationReasons'
  | 'expiresAt'
>): unknown {
  return {
    compilerVersion: pack.compilerVersion,
    mode: pack.mode,
    subjectFingerprint: pack.subjectFingerprint,
    sourceSnapshotDigest: pack.sourceSnapshotDigest,
    sourceGenerations: pack.sourceGenerations.map(
      ({ sourceId, kind, generation, revision, snapshotDigest, required, health, ruleCount }) => ({
        sourceId,
        kind,
        generation,
        revision,
        snapshotDigest,
        required,
        health,
        ruleCount,
      }),
    ),
    budget: pack.budget,
    rules: pack.rules.map(({ id, version, digest, selectionReason, dependencyOf }) => ({
      id,
      version,
      digest,
      selectionReason,
      dependencyOf,
    })),
    decisions: pack.decisions,
    renderedText: pack.renderedText,
    deliveryChannel: pack.deliveryChannel,
    degraded: pack.degraded,
    degradationReasons: pack.degradationReasons,
    expiresAt: pack.expiresAt,
  };
}

export function recomputePackDigest(pack: CompiledRulesPack): CompiledRulesPack {
  const packDigest = digestObject(packDigestPayload(pack));
  return { ...pack, packDigest, packId: stableId('pack', packDigest) };
}

export function subjectFingerprint(subjectValue: unknown): string {
  const subject = validateExecutionSubject(subjectValue);
  return digestObject(subject);
}

export function sourceSnapshotDigest(request: Pick<CompileRequest, 'sourceGenerations'>): string {
  return digestObject(
    [...request.sourceGenerations]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map(({ sourceId, generation, snapshotDigest, required, health }) => ({
        sourceId,
        generation,
        snapshotDigest,
        required,
        health,
      })),
  );
}

export function compileRules(request: CompileRequest): CompiledRulesPack {
  const now = request.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new RulesPackError('VALIDATION_ERROR', 'compile now must be an ISO timestamp');
  if (!Number.isSafeInteger(request.budget.maxTokens) || request.budget.maxTokens < 0) {
    throw new RulesPackError('VALIDATION_ERROR', 'budget.maxTokens must be a non-negative integer');
  }
  if (!Number.isSafeInteger(request.budget.maxCharacters) || request.budget.maxCharacters < 0) {
    throw new RulesPackError('VALIDATION_ERROR', 'budget.maxCharacters must be a non-negative integer');
  }
  const subject = validateExecutionSubject(request.subject);
  const mode = request.mode ?? 'enforce';
  const fingerprint = subjectFingerprint(subject);
  const snapshotDigest = sourceSnapshotDigest(request);
  const degradationReasons = [...(request.degradationReasons ?? [])];
  const degraded = degradationReasons.length > 0 || request.sourceGenerations.some((source) => source.health !== 'fresh');
  const decisions: RuleDecision[] = [];

  if (mode === 'off') {
    const offPack = {
      compilerVersion: COMPILER_VERSION,
      mode,
      subjectFingerprint: fingerprint,
      sourceSnapshotDigest: snapshotDigest,
      sourceGenerations: [...request.sourceGenerations],
      budget: request.budget,
      rules: [] as readonly SelectedRule[],
      decisions,
      renderedText: '',
      deliveryChannel: 'user' as const,
      degraded,
      degradationReasons,
    };
    const packDigest = digestObject(packDigestPayload(offPack));
    return {
      schemaVersion: PACK_SCHEMA_VERSION,
      compilerVersion: COMPILER_VERSION,
      packId: stableId('pack', packDigest),
      packDigest,
      compiledAt: now,
      target: subject,
      subjectFingerprint: fingerprint,
      sourceSnapshotDigest: snapshotDigest,
      sourceGenerations: [...request.sourceGenerations],
      budget: request.budget,
      rules: [],
      decisions,
      renderedText: '',
      estimatedTokens: 0,
      characters: 0,
      deliveryChannel: 'user',
      mode,
      degraded,
      degradationReasons,
      lastKnownGood: false,
    };
  }

  const normalized = request.rules.map(validateRule).sort(compareRulePrecedence);
  const uniqueById = new Map<string, RuleV1>();
  for (const rule of normalized) {
    const winner = uniqueById.get(rule.id);
    if (winner) {
      decisions.push(decision(rule, 'conflict-overridden', `duplicate ID lost to ${winner.id}@${winner.version}`, winner.id));
    } else {
      uniqueById.set(rule.id, rule);
    }
  }

  const candidates = new Map<string, Candidate>();
  for (const rule of uniqueById.values()) {
    const inactive = lifecycleDecision(rule, nowMs);
    if (inactive) {
      decisions.push(inactive);
      continue;
    }
    const match = matchRule(rule, subject);
    if (!match.matches) {
      decisions.push(decision(rule, match.disposition ?? 'scope-mismatch', match.reason));
      continue;
    }
    candidates.set(rule.id, { rule, dependencyOf: new Set() });
  }

  for (const candidate of [...candidates.values()]) {
    let applicable = true;
    for (const dependencyId of candidate.rule.dependencies ?? []) {
      const dependency = candidates.get(dependencyId);
      if (!dependency) {
        const sourceRule = uniqueById.get(dependencyId);
        const disposition = sourceRule ? 'dependency-inapplicable' : 'dependency-missing';
        decisions.push(decision(candidate.rule, disposition, `required dependency ${dependencyId} is unavailable`, dependencyId));
        if (isMandatory(candidate.rule)) {
          throw new RulesPackError('DEPENDENCY_ERROR', `Mandatory rule ${candidate.rule.id} has unavailable dependency ${dependencyId}`);
        }
        applicable = false;
        break;
      }
      dependency.dependencyOf.add(candidate.rule.id);
    }
    if (!applicable) candidates.delete(candidate.rule.id);
  }

  const conflictGroups = new Map<string, Candidate[]>();
  for (const candidate of candidates.values()) {
    if (!candidate.rule.conflictKey) continue;
    const group = conflictGroups.get(candidate.rule.conflictKey) ?? [];
    group.push(candidate);
    conflictGroups.set(candidate.rule.conflictKey, group);
  }
  for (const [conflictKey, group] of conflictGroups) {
    const highestAuthority = Math.max(...group.map(({ rule }) => AUTHORITY_RANK[rule.authority]));
    const authorityPeers = group.filter(({ rule }) => AUTHORITY_RANK[rule.authority] === highestAuthority);
    const lockedPeers = authorityPeers.filter(({ rule }) => !rule.overridable);
    const eligible = lockedPeers.length ? lockedPeers : authorityPeers;
    eligible.sort((left, right) => compareRulePrecedence(left.rule, right.rule));
    const winner = eligible[0];
    if (!winner) continue;
    for (const loser of group.filter((candidate) => candidate !== winner)) {
      candidates.delete(loser.rule.id);
      decisions.push(
        decision(
          loser.rule,
          'conflict-overridden',
          `conflictKey=${conflictKey} won by ${winner.rule.id}${!winner.rule.overridable ? ' with same-authority non-overridable protection' : ''}; ${precedenceDescription(winner.rule)}`,
          winner.rule.id,
        ),
      );
    }
  }

  const contentWinners = new Map<string, Candidate>();
  for (const candidate of [...candidates.values()].sort((left, right) => compareRulePrecedence(left.rule, right.rule))) {
    const contentDigest = digestObject(candidate.rule.text.trim().replace(/\s+/gu, ' '));
    const winner = contentWinners.get(contentDigest);
    if (winner) {
      candidates.delete(candidate.rule.id);
      decisions.push(decision(candidate.rule, 'duplicate-content', `same normalized text as ${winner.rule.id}`, winner.rule.id));
    } else {
      contentWinners.set(contentDigest, candidate);
    }
  }

  for (const candidate of [...candidates.values()]) {
    for (const dependencyId of candidate.rule.dependencies ?? []) {
      if (!candidates.has(dependencyId)) {
        if (isMandatory(candidate.rule)) {
          throw new RulesPackError('DEPENDENCY_ERROR', `Mandatory rule ${candidate.rule.id} lost dependency ${dependencyId} during resolution`);
        }
        candidates.delete(candidate.rule.id);
        decisions.push(decision(candidate.rule, 'dependency-inapplicable', `dependency ${dependencyId} was removed during conflict/dedup resolution`, dependencyId));
        break;
      }
    }
  }

  const ordered = [...candidates.values()].sort((left, right) => compareRulePrecedence(left.rule, right.rule));
  const included = new Map<string, Candidate>();
  const mandatoryRoots = ordered.filter(({ rule }) => isMandatory(rule));
  for (const root of mandatoryRoots) {
    const closure = dependencyClosure(root, candidates);
    if (!closure) throw new RulesPackError('DEPENDENCY_ERROR', `Mandatory rule ${root.rule.id} has a dependency cycle`);
    for (const item of closure) included.set(item.rule.id, item);
  }
  let renderedSelected = [...included.values()]
    .sort((left, right) => compareRulePrecedence(left.rule, right.rule))
    .map(({ rule, dependencyOf }) => selected(rule, dependencyOf.size ? `dependency required by ${[...dependencyOf].sort().join(', ')}` : `mandatory; ${precedenceDescription(rule)}`, dependencyOf));
  if (!withinBudget(renderedSelected, request.budget.maxTokens, request.budget.maxCharacters)) {
    const rendered = renderRules(renderedSelected);
    throw new RulesPackError('MANDATORY_BUDGET_EXCEEDED', 'Mandatory Rules exceed the compile budget', {
      tokens: rendered.estimatedTokens,
      characters: rendered.characters,
      budget: request.budget,
      rules: renderedSelected.map((rule) => rule.id),
    });
  }

  for (const root of ordered) {
    if (included.has(root.rule.id)) continue;
    const closure = dependencyClosure(root, candidates);
    if (!closure) {
      decisions.push(decision(root.rule, 'dependency-inapplicable', 'dependency cycle detected'));
      continue;
    }
    const trial = new Map(included);
    for (const item of closure) trial.set(item.rule.id, item);
    const trialSelected = [...trial.values()]
      .sort((left, right) => compareRulePrecedence(left.rule, right.rule))
      .map(({ rule, dependencyOf }) => selected(rule, dependencyOf.size ? `dependency required by ${[...dependencyOf].sort().join(', ')}` : `matched; ${precedenceDescription(rule)}`, dependencyOf));
    if (withinBudget(trialSelected, request.budget.maxTokens, request.budget.maxCharacters)) {
      for (const item of closure) included.set(item.rule.id, item);
    } else {
      decisions.push(decision(root.rule, 'budget-excluded', 'whole Rule and dependency closure would exceed the deterministic budget'));
    }
  }

  renderedSelected = [...included.values()]
    .sort((left, right) => compareRulePrecedence(left.rule, right.rule))
    .map(({ rule, dependencyOf }) => selected(rule, dependencyOf.size ? `dependency required by ${[...dependencyOf].sort().join(', ')}` : `matched; ${precedenceDescription(rule)}`, dependencyOf));
  for (const rule of renderedSelected) {
    decisions.push(decision(rule, rule.dependencyOf?.length ? 'dependency-added' : 'selected', rule.selectionReason));
  }
  decisions.sort((left, right) => left.ruleId.localeCompare(right.ruleId) || left.disposition.localeCompare(right.disposition));
  const rendered = renderRules(renderedSelected);
  const expiryCandidates = renderedSelected
    .map((rule) => rule.lifecycle.expiresAt)
    .filter((value): value is string => value !== undefined)
    .sort();
  const packDigest = digestObject(packDigestPayload({
    compilerVersion: COMPILER_VERSION,
    mode,
    subjectFingerprint: fingerprint,
    sourceSnapshotDigest: snapshotDigest,
    sourceGenerations: [...request.sourceGenerations],
    budget: request.budget,
    rules: renderedSelected,
    decisions,
    renderedText: rendered.text,
    deliveryChannel: 'user',
    degraded,
    degradationReasons,
    ...(expiryCandidates[0] ? { expiresAt: expiryCandidates[0] } : {}),
  }));
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    packId: stableId('pack', packDigest),
    packDigest,
    compiledAt: now,
    ...(expiryCandidates[0] ? { expiresAt: expiryCandidates[0] } : {}),
    target: subject,
    subjectFingerprint: fingerprint,
    sourceSnapshotDigest: snapshotDigest,
    sourceGenerations: [...request.sourceGenerations],
    budget: request.budget,
    rules: renderedSelected,
    decisions,
    renderedText: rendered.text,
    estimatedTokens: rendered.estimatedTokens,
    characters: rendered.characters,
    deliveryChannel: 'user',
    mode,
    degraded,
    degradationReasons,
    lastKnownGood: false,
  };
}

export function verifyCompiledPack(pack: CompiledRulesPack, now = new Date().toISOString()): CompiledRulesPack {
  if (
    pack === null ||
    typeof pack !== 'object' ||
    !Array.isArray(pack.rules) ||
    !Array.isArray(pack.decisions) ||
    !Array.isArray(pack.sourceGenerations) ||
    !Array.isArray(pack.degradationReasons)
  ) {
    throw new RulesPackError('VALIDATION_ERROR', 'CompiledRulesPack structure is malformed');
  }
  if (pack.schemaVersion !== PACK_SCHEMA_VERSION || pack.compilerVersion !== COMPILER_VERSION) {
    throw new RulesPackError('VALIDATION_ERROR', 'Unsupported CompiledRulesPack schema/compiler version');
  }
  if (pack.deliveryChannel !== 'user' || !['off', 'shadow', 'enforce'].includes(pack.mode)) {
    throw new RulesPackError('VALIDATION_ERROR', 'CompiledRulesPack channel or mode is invalid');
  }
  if (
    !pack.budget ||
    !Number.isSafeInteger(pack.budget.maxTokens) ||
    !Number.isSafeInteger(pack.budget.maxCharacters) ||
    pack.budget.maxTokens < 0 ||
    pack.budget.maxCharacters < 0
  ) {
    throw new RulesPackError('VALIDATION_ERROR', 'CompiledRulesPack budget is invalid');
  }
  const fingerprint = subjectFingerprint(pack.target);
  if (fingerprint !== pack.subjectFingerprint) {
    throw new RulesPackError('TARGET_MISMATCH', 'CompiledRulesPack subject fingerprint is invalid');
  }
  for (const rule of pack.rules) {
    const { selectionReason, dependencyOf: _dependencyOf, ...baseRule } = rule;
    validateRule(baseRule);
    if (typeof selectionReason !== 'string' || selectionReason.length === 0) {
      throw new RulesPackError('VALIDATION_ERROR', 'CompiledRulesPack selected Rule lacks a selection reason');
    }
  }
  const rules = pack.rules;
  const rendered = renderRules(rules);
  if (
    rendered.text !== pack.renderedText ||
    rendered.estimatedTokens !== pack.estimatedTokens ||
    rendered.characters !== pack.characters
  ) {
    throw new RulesPackError('VALIDATION_ERROR', 'CompiledRulesPack rendered content/counts are invalid');
  }
  if (pack.estimatedTokens > pack.budget.maxTokens || pack.characters > pack.budget.maxCharacters) {
    throw new RulesPackError('MANDATORY_BUDGET_EXCEEDED', 'CompiledRulesPack exceeds its declared budget');
  }
  const expectedDigest = digestObject(packDigestPayload(pack));
  if (pack.packDigest !== expectedDigest || pack.packId !== stableId('pack', expectedDigest)) {
    throw new RulesPackError('VALIDATION_ERROR', 'CompiledRulesPack digest or ID is invalid');
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new RulesPackError('VALIDATION_ERROR', 'Pack verification time is invalid');
  }
  if (pack.expiresAt && Date.parse(pack.expiresAt) <= nowMs) {
    throw new RulesPackError('TARGET_MISMATCH', 'CompiledRulesPack is expired');
  }
  return pack;
}

export function explainRules(request: CompileRequest): CompileExplanation {
  const pack = compileRules(request);
  return {
    pack,
    summary: {
      selected: pack.rules.length,
      rejected: pack.decisions.filter((item) => item.disposition !== 'selected' && item.disposition !== 'dependency-added').length,
      tokens: pack.estimatedTokens,
      characters: pack.characters,
      degraded: pack.degraded,
    },
  };
}
