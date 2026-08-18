import type { RuleAuthority, RuleScope, RuleV1 } from './model.js';
import { targetSpecificity } from './matcher.js';

export const AUTHORITY_RANK: Readonly<Record<RuleAuthority, number>> = {
  platform: 600,
  runtime: 500,
  'user-current': 450,
  'user-approved': 400,
  project: 300,
  advisory: 100,
};

export const SCOPE_RANK: Readonly<Record<RuleScope, number>> = {
  global: 0,
  user: 1,
  project: 2,
  chat: 3,
  task: 4,
};

const versionCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Negative means left wins and should sort first. */
export function compareRulePrecedence(left: RuleV1, right: RuleV1): number {
  const authority = AUTHORITY_RANK[right.authority] - AUTHORITY_RANK[left.authority];
  if (authority !== 0) return authority;
  const scope = SCOPE_RANK[right.scope] - SCOPE_RANK[left.scope];
  if (scope !== 0) return scope;
  const target = targetSpecificity(right) - targetSpecificity(left);
  if (target !== 0) return target;
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;
  const version = versionCollator.compare(right.version, left.version);
  if (version !== 0) return version;
  return left.id.localeCompare(right.id);
}

export function precedenceDescription(rule: RuleV1): string {
  return [
    `authority=${rule.authority}:${AUTHORITY_RANK[rule.authority]}`,
    `scope=${rule.scope}:${SCOPE_RANK[rule.scope]}`,
    `targetSpecificity=${targetSpecificity(rule)}`,
    `priority=${rule.priority}`,
    `version=${rule.version}`,
    `id=${rule.id}`,
  ].join(', ');
}

export function isMandatory(rule: RuleV1): boolean {
  return rule.mandatory === true || rule.authority === 'platform' || rule.authority === 'runtime';
}
