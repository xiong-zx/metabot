import type {
  ExactTargets,
  ExecutionSubject,
  RuleBinding,
  RuleV1,
  SelectionDisposition,
} from './model.js';
import { digestObject } from './canonical.js';

export interface MatchResult {
  matches: boolean;
  disposition?: SelectionDisposition;
  reason: string;
}

const scalarTargetValue = (
  subject: ExecutionSubject,
  key: keyof ExactTargets,
): readonly string[] => {
  switch (key) {
    case 'bots':
      return [subject.bot];
    case 'roles':
      return subject.roles;
    case 'agents':
      return subject.agent ? [subject.agent] : [];
    case 'workers':
      return subject.worker ? [subject.worker] : [];
    case 'hosts':
      return [subject.hostId];
    case 'tools':
      return subject.tools;
    case 'dataClasses':
      return subject.dataClasses;
    case 'outputTypes':
      return subject.outputTypes;
  }
};

const targetKeys: readonly (keyof ExactTargets)[] = [
  'bots',
  'roles',
  'agents',
  'workers',
  'hosts',
  'tools',
  'dataClasses',
  'outputTypes',
];

function predicateMatches(predicate: ExactTargets, subject: ExecutionSubject): boolean {
  const declared = targetKeys.filter((key) => (predicate[key]?.length ?? 0) > 0);
  if (declared.length === 0) return false;
  return declared.every((key) => {
    const expected = new Set(predicate[key]);
    return scalarTargetValue(subject, key).some((actual) => expected.has(actual));
  });
}

function bindingMatches(binding: RuleBinding | undefined, subject: ExecutionSubject): boolean {
  if (!binding) return true;
  return (
    (binding.subjectFingerprint === undefined || binding.subjectFingerprint === subjectFingerprintValue(subject)) &&
    (binding.userId === undefined || binding.userId === subject.userId) &&
    (binding.projectId === undefined || binding.projectId === subject.projectId) &&
    (binding.chatId === undefined || binding.chatId === subject.chatId) &&
    (binding.taskId === undefined || binding.taskId === subject.taskId) &&
    (binding.hostId === undefined || binding.hostId === subject.hostId)
  );
}

function subjectFingerprintValue(subject: ExecutionSubject): string {
  // Kept local to avoid a matcher/compiler import cycle; canonical JSON hashing
  // is the same primitive used by compiler.subjectFingerprint.
  return digestObject(subject);
}

export function matchRule(rule: RuleV1, subject: ExecutionSubject): MatchResult {
  if (!bindingMatches(rule.binding, subject)) {
    return { matches: false, disposition: 'scope-mismatch', reason: 'exact scope binding mismatch' };
  }
  if (rule.targets.exclude && predicateMatches(rule.targets.exclude, subject)) {
    return {
      matches: false,
      disposition: 'target-excluded',
      reason: 'subject exactly matches the exclusion predicate',
    };
  }
  if (rule.targets.include && !predicateMatches(rule.targets.include, subject)) {
    return {
      matches: false,
      disposition: 'target-not-included',
      reason: 'subject does not satisfy every declared include dimension',
    };
  }
  return { matches: true, reason: 'scope binding and exact target predicates matched' };
}

export function targetSpecificity(rule: RuleV1): number {
  const targetDimensions = targetKeys.filter(
    (key) => (rule.targets.include?.[key]?.length ?? 0) > 0,
  ).length;
  const bindingDimensions = rule.binding ? Object.keys(rule.binding).length : 0;
  return targetDimensions * 10 + bindingDimensions;
}
