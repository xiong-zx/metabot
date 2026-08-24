import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRule, type RuleInputV1 } from '@metabot/rulespack';
import { MetaBotRulesPackRuntime } from '@metabot/rulespack-adapter';

const temporary: string[] = [];
const logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('FIX-012 canonical MetaBot policy', () => {
  it('is schema-valid, selects only in the authenticated MetaBot project, and retains revocation history', async () => {
    const document = JSON.parse(fs.readFileSync(
      path.resolve('config/rulespack/metabot-development.rules.json'),
      'utf8',
    )) as { schemaVersion: number; revision: string; rules: RuleInputV1[] };
    expect(document.schemaVersion).toBe(1);
    expect(document.rules.map((rule) => normalizeRule(rule))).toHaveLength(5);
    expect(document.rules.filter((rule) => rule.lifecycle.status === 'approved').map((rule) => rule.id)).toEqual([
      'metabot.upstream-first',
      'metabot.one-feature-one-final-commit',
      'metabot.runtime-change-authorization',
      'metabot.credential-safety',
    ]);
    expect(document.rules.find((rule) => rule.id === 'metabot.one-feature-one-final-commit')).toMatchObject({
      version: '1.1.0',
      text: expect.stringContaining('Consolidate temporary checkpoints, tests, documentation, and review repairs'),
    });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fix012-canonical-policy-'));
    temporary.push(directory);
    const project = path.join(directory, 'metabot');
    const worktree = path.join(directory, 'metabot-worktrees', 'feature');
    const unrelated = path.join(directory, 'other-project');
    fs.mkdirSync(project);
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(unrelated);
    const runtime = new MetaBotRulesPackRuntime({
      mode: 'shadow',
      hostId: 'imac',
      dbPath: path.join(directory, 'policy.sqlite'),
      configRules: { id: 'fixture', revision: document.revision, required: true, rules: document.rules },
      projectBindings: [
        { projectId: 'metabot', root: project },
        { projectId: 'metabot', root: path.join(directory, 'metabot-worktrees') },
      ],
    }, logger);
    try {
      const facts = (cwd: string) => ({
        botName: 'admin', chatId: 'chat', roles: ['user'], cwd, tools: [], dataClasses: ['chat'], outputTypes: ['text'],
      });
      const canonical = await runtime.explain(facts(project));
      const featureWorktree = await runtime.explain(facts(worktree));
      const other = await runtime.explain(facts(unrelated));
      expect(canonical.pack.rules.map((rule) => rule.id)).toHaveLength(4);
      expect(featureWorktree.pack.rules.map((rule) => rule.id)).toHaveLength(4);
      expect(other.pack.rules).toHaveLength(0);
      expect(canonical.pack.decisions).toContainEqual(expect.objectContaining({
        ruleId: 'metabot.fix012-rollout-marker', disposition: 'revoked',
      }));
    } finally {
      runtime.close();
    }
  });
});
