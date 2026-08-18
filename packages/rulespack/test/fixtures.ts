import type { ExecutionSubject, RuleInputV1, RuleV1 } from '../src/model.js';
import { normalizeRule } from '../src/validate.js';

export const NOW = '2026-08-18T06:00:00.000Z';

export const subject: ExecutionSubject = {
  hostId: 'imac',
  bot: 'admin',
  roles: ['coordinator'],
  agent: 'primary',
  userId: 'xz',
  projectId: 'fix-009',
  chatId: 'chat-fix-009',
  taskId: 'task-implement',
  tools: ['shell', 'git'],
  dataClasses: ['internal'],
  outputTypes: ['code'],
  engine: 'codex',
  sessionId: 'session-1',
};

export function makeRule(overrides: Partial<RuleInputV1> & Pick<RuleInputV1, 'id' | 'text'>): RuleV1 {
  const input: RuleInputV1 = {
    schemaVersion: 1,
    id: overrides.id,
    version: overrides.version ?? '1',
    text: overrides.text,
    scope: overrides.scope ?? 'global',
    targets: overrides.targets ?? {},
    authority: overrides.authority ?? 'user-approved',
    priority: overrides.priority ?? 0,
    overridable: overrides.overridable ?? true,
    lifecycle: overrides.lifecycle ?? { status: 'approved' },
    source: overrides.source ?? {
      kind: 'config',
      adapterId: 'test-config',
      ref: 'test',
      revision: '1',
    },
    ...(overrides.binding ? { binding: overrides.binding } : {}),
    ...(overrides.conflictKey ? { conflictKey: overrides.conflictKey } : {}),
    ...(overrides.dependencies ? { dependencies: overrides.dependencies } : {}),
    ...(overrides.mandatory === undefined ? {} : { mandatory: overrides.mandatory }),
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  };
  return normalizeRule(input);
}

export function sourceGeneration(generation = 'gen-1') {
  return {
    sourceId: 'test-config',
    kind: 'config' as const,
    generation,
    revision: generation,
    snapshotDigest: `snapshot-${generation}`,
    observedAt: NOW,
    health: 'fresh' as const,
    ruleCount: 1,
  };
}
