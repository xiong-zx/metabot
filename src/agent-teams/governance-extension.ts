import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineName } from '../engines/types.js';
import type { Logger } from '../utils/logger.js';
import type { AgentStatus, AgentTeamStore, TeamAgent, TeamRun, TeamTask } from './team-store.js';

export type TeamGovernanceScope = 'chat' | 'project' | 'global';
export type TeamGovernanceActorRole = 'admin' | 'user' | 'pm' | 'manager' | 'agent' | 'worker';
export type TeamGovernanceAction =
  | 'create_team'
  | 'start_team'
  | 'stop_team'
  | 'delete_team'
  | 'create_agent'
  | 'stop_agent'
  | 'delete_agent'
  | 'stop_run'
  | 'coordinate_existing_agents'
  | 'dispatch_worker'
  | 'restart_service'
  | 'update_service'
  | 'promote_template'
  | 'promote_rules';
export type GovernedAgentKind = 'template' | 'custom' | 'temporary';
export type GovernanceRuleScope = 'global' | 'team-template' | 'team-instance' | 'project';

export interface TeamGovernanceActor {
  role: TeamGovernanceActorRole;
  id?: string;
}

export interface AgentTeamGovernanceQuotas {
  maxAgents: number;
  maxTemporaryAgents: number;
  maxParallelRunsPerAgent: number;
  maxTeamsPerScope: number;
  maxQueuedTasks: number;
  maxActiveRuns: number;
}

export const DEFAULT_AGENT_TEAM_GOVERNANCE_QUOTAS: AgentTeamGovernanceQuotas = {
  maxAgents: 8,
  maxTemporaryAgents: 3,
  maxParallelRunsPerAgent: 4,
  maxTeamsPerScope: 3,
  maxQueuedTasks: 64,
  maxActiveRuns: 16,
};

export interface GovernanceRule {
  id?: string;
  text: string;
  target?: string;
}

export interface GovernanceRuleSetRef {
  name: string;
  version?: number;
}

export interface GovernanceRuleSetVersion {
  name: string;
  version: number;
  digest: string;
  scope: GovernanceRuleScope;
  rules: GovernanceRule[];
  createdBy?: string;
  createdAt: number;
}

export interface GovernanceTemplateAgent {
  name: string;
  role?: string;
  engine?: EngineName;
  prompt?: string;
  sessionId?: string;
}

export interface GovernanceTemplateTask {
  id?: number;
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: number[];
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  result?: string;
}

export interface AgentTeamGovernanceTemplateBody {
  description?: string;
  agents?: GovernanceTemplateAgent[];
  tasks?: GovernanceTemplateTask[];
  quotas?: Partial<AgentTeamGovernanceQuotas>;
  ruleSetRefs?: GovernanceRuleSetRef[];
  temporaryAgentIdleMs?: number;
}

export interface AgentTeamGovernanceTemplateVersion {
  name: string;
  version: number;
  digest: string;
  body: AgentTeamGovernanceTemplateBody;
  createdBy?: string;
  createdAt: number;
}

export interface PinnedGovernanceRuleSet {
  name: string;
  version: number;
  digest: string;
}

export interface GovernedTeamInstance {
  id: string;
  teamName: string;
  templateName: string;
  templateVersion: number;
  templateDigest: string;
  scopeType: TeamGovernanceScope;
  scopeKey: string;
  quotas: AgentTeamGovernanceQuotas;
  ruleSetRefs: PinnedGovernanceRuleSet[];
  pmBot?: string;
  temporaryAgentIdleMs?: number;
  status: 'active' | 'stopped';
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GovernedAgentLease {
  id: number;
  instanceId: string;
  teamName: string;
  agentName: string;
  kind: GovernedAgentKind;
  createdBy?: string;
  expiresAt?: number;
  lastActiveAt: number;
  recycledAt?: number;
  createdAt: number;
}

export interface AgentTeamGovernanceAuditEvent {
  id: number;
  eventType: string;
  actorRole: TeamGovernanceActorRole | 'system' | 'unknown';
  actorId?: string;
  instanceId?: string;
  teamName?: string;
  subject?: string;
  details: Record<string, unknown>;
  createdAt: number;
}

/**
 * The only seam between W01 governance and upstream AgentTeamStore. The
 * extension owns policy metadata; upstream remains the source of truth for
 * Team, Agent, Task, Message, and Run execution state.
 */
export interface AgentTeamGovernanceHost {
  listTeams(): Array<{ name: string; status: 'active' | 'stopped' }>;
  getTeam(name: string): { name: string; status: 'active' | 'stopped' } | undefined;
  createTeam(
    name: string,
    description?: string,
    options?: {
      chatIds?: string[];
      displayChatIds?: string[];
      status?: 'active' | 'stopped';
    },
  ): { name: string; status: 'active' | 'stopped' };
  setTeamStatus(name: string, status: 'active' | 'stopped'): { name: string; status: 'active' | 'stopped' } | undefined;
  deleteTeam(name: string): boolean;
  listAgents(teamName: string): TeamAgent[];
  getAgent(teamName: string, name: string): TeamAgent | undefined;
  upsertAgent(
    teamName: string,
    input: {
      name: string;
      role?: string;
      engine?: EngineName;
      prompt?: string;
      sessionId?: string;
      status?: AgentStatus;
    },
  ): TeamAgent;
  setAgentStatus(teamName: string, name: string, status: AgentStatus): TeamAgent | undefined;
  deleteAgent(teamName: string, name: string): boolean;
  upsertTask(teamName: string, input: GovernanceTemplateTask): TeamTask;
  listTasks(teamName: string): TeamTask[];
  listRuns(teamName: string): TeamRun[];
}

export interface ResolveGovernedTeamInstanceInput {
  actor: TeamGovernanceActor;
  templateName: string;
  templateVersion?: number;
  scopeType?: TeamGovernanceScope;
  scopeKey?: string;
  chatId?: string;
  projectId?: string;
  createIfMissing?: boolean;
  allowGlobal?: boolean;
  quotas?: Partial<AgentTeamGovernanceQuotas>;
  ruleSetRefs?: GovernanceRuleSetRef[];
  pmBot?: string;
  temporaryAgentIdleMs?: number;
}

export interface GovernedAgentReapAction {
  lease: GovernedAgentLease;
  reason: 'ttl_expired' | 'idle_expired';
  runningRuns: Array<{ runId: string; taskId?: number }>;
}

export interface GovernedRunPreparation {
  instanceId: string;
  chatId: string;
  executionBot?: string;
}

export interface GovernedRulesContext {
  text: string;
  provenance: Array<{
    name: string;
    version: number;
    digest: string;
    scope: GovernanceRuleScope;
    ruleCount: number;
    selectedRuleCount: number;
  }>;
}

export interface GovernedRulesSubject {
  agentName: string;
  agentRole?: string;
}

export interface GovernanceReconciliationReport {
  recreatedTeams: string[];
  reactivatedTeams: string[];
  stoppedTeams: string[];
  stoppedOrphans: string[];
}

export class AgentTeamGovernanceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AgentTeamGovernanceError';
  }
}

export class AgentTeamGovernanceExtension {
  private readonly db: Database.Database;

  constructor(
    private readonly host: AgentTeamGovernanceHost,
    logger: Logger,
    dbPath?: string,
  ) {
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    const finalPath = dbPath || path.join(dataDir, 'agent-team-governance.db');
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    logger
      .child({ module: 'agent-team-governance' })
      .info({ dbPath: finalPath }, 'Agent Team governance extension initialized');
  }

  publishTemplate(input: {
    actor: TeamGovernanceActor;
    name: string;
    body: AgentTeamGovernanceTemplateBody;
  }): AgentTeamGovernanceTemplateVersion {
    this.requireAuthority(input.actor, 'promote_template', { subject: input.name });
    const name = requireName(input.name, 'template');
    const body = normalizeTemplateBody(input.body);
    const digest = hashObject(body);
    const existing = this.db
      .prepare(
        `
      SELECT * FROM agent_team_governance_templates WHERE name = ? AND digest = ?
    `,
      )
      .get(name, digest) as any;
    if (existing) return this.rowToTemplate(existing);

    const latest = this.getTemplate(name);
    const version = (latest?.version ?? 0) + 1;
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO agent_team_governance_templates
          (name, version, digest, body_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(name, version, digest, JSON.stringify(body), input.actor.id ?? null, now);
      this.insertAudit({
        eventType: 'template.promoted',
        actor: input.actor,
        subject: `${name}@v${version}`,
        details: { digest },
        createdAt: now,
      });
    })();
    return this.getTemplate(name, version)!;
  }

  listTemplates(name?: string): AgentTeamGovernanceTemplateVersion[] {
    const rows = name
      ? (this.db
          .prepare(
            `
          SELECT * FROM agent_team_governance_templates WHERE name = ? ORDER BY version DESC
        `,
          )
          .all(name) as any[])
      : (this.db
          .prepare(
            `
          SELECT * FROM agent_team_governance_templates ORDER BY name ASC, version DESC
        `,
          )
          .all() as any[]);
    return rows.map((row) => this.rowToTemplate(row));
  }

  getTemplate(name: string, version?: number): AgentTeamGovernanceTemplateVersion | undefined {
    const row =
      version == null
        ? (this.db
            .prepare(
              `
          SELECT * FROM agent_team_governance_templates WHERE name = ? ORDER BY version DESC LIMIT 1
        `,
            )
            .get(name) as any)
        : (this.db
            .prepare(
              `
          SELECT * FROM agent_team_governance_templates WHERE name = ? AND version = ?
        `,
            )
            .get(name, version) as any);
    return row ? this.rowToTemplate(row) : undefined;
  }

  publishRuleSet(input: {
    actor: TeamGovernanceActor;
    name: string;
    scope: GovernanceRuleScope;
    rules: GovernanceRule[];
  }): GovernanceRuleSetVersion {
    this.requireAuthority(input.actor, 'promote_rules', { subject: input.name });
    const name = requireName(input.name, 'RuleSet');
    const rules = normalizeRules(input.rules);
    const digest = hashObject({ scope: input.scope, rules });
    const existing = this.db
      .prepare(
        `
      SELECT * FROM agent_team_governance_rule_sets WHERE name = ? AND digest = ?
    `,
      )
      .get(name, digest) as any;
    if (existing) return this.rowToRuleSet(existing);

    const latest = this.getRuleSet(name);
    const version = (latest?.version ?? 0) + 1;
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO agent_team_governance_rule_sets
          (name, version, digest, scope, rules_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(name, version, digest, input.scope, JSON.stringify(rules), input.actor.id ?? null, now);
      this.insertAudit({
        eventType: 'rules.promoted',
        actor: input.actor,
        subject: `${name}@v${version}`,
        details: { digest, scope: input.scope },
        createdAt: now,
      });
    })();
    return this.getRuleSet(name, version)!;
  }

  getRuleSet(name: string, version?: number): GovernanceRuleSetVersion | undefined {
    const row =
      version == null
        ? (this.db
            .prepare(
              `
          SELECT * FROM agent_team_governance_rule_sets WHERE name = ? ORDER BY version DESC LIMIT 1
        `,
            )
            .get(name) as any)
        : (this.db
            .prepare(
              `
          SELECT * FROM agent_team_governance_rule_sets WHERE name = ? AND version = ?
        `,
            )
            .get(name, version) as any);
    return row ? this.rowToRuleSet(row) : undefined;
  }

  listRuleSets(name?: string): GovernanceRuleSetVersion[] {
    const rows = name
      ? (this.db
          .prepare('SELECT * FROM agent_team_governance_rule_sets WHERE name = ? ORDER BY version DESC')
          .all(name) as any[])
      : (this.db
          .prepare('SELECT * FROM agent_team_governance_rule_sets ORDER BY name ASC, version DESC')
          .all() as any[]);
    return rows.map((row) => this.rowToRuleSet(row));
  }

  resolveInstance(input: ResolveGovernedTeamInstanceInput): GovernedTeamInstance | undefined {
    const scopeType = input.scopeType ?? 'chat';
    if (scopeType === 'global' && input.allowGlobal !== true) {
      throw new AgentTeamGovernanceError(
        'Global Agent Team instances require allowGlobal=true',
        400,
        'GLOBAL_SCOPE_REQUIRES_OPT_IN',
      );
    }
    if (scopeType === 'global' && input.scopeKey && input.scopeKey !== 'global') {
      throw new AgentTeamGovernanceError(
        'Global Agent Team instances use the fixed scope key "global"',
        400,
        'INVALID_GLOBAL_SCOPE_KEY',
      );
    }
    const scopeKey = resolveScopeKey(scopeType, input);
    const existing = this.findInstanceRecord(input.templateName, scopeType, scopeKey);
    if (existing?.status === 'active' || input.createIfMissing === false) {
      return existing?.status === 'active' ? existing : undefined;
    }
    if (existing) {
      if (input.templateVersion != null && input.templateVersion !== existing.templateVersion) {
        throw new AgentTeamGovernanceError(
          `Stopped instance is pinned to ${existing.templateName}@v${existing.templateVersion}`,
          409,
          'PINNED_TEMPLATE_VERSION_CONFLICT',
        );
      }
      return this.reactivateInstance(input.actor, existing.id);
    }

    this.requireAuthority(input.actor, 'create_team', {
      subject: input.templateName,
      details: { scopeType, scopeKey },
    });
    const template = this.getTemplate(input.templateName, input.templateVersion);
    if (!template) {
      throw new AgentTeamGovernanceError(
        `Agent Team governance template not found: ${input.templateName}`,
        404,
        'TEMPLATE_NOT_FOUND',
      );
    }
    const quotas = mergeQuotas(template.body.quotas, input.quotas);
    const temporaryAgentIdleMs = normalizeOptionalDuration(
      input.temporaryAgentIdleMs ?? template.body.temporaryAgentIdleMs,
      'temporaryAgentIdleMs',
    );
    this.requireScopeQuota(scopeType, scopeKey, quotas.maxTeamsPerScope, input.actor);
    const ruleSetRefs = this.pinRuleSetRefs([...(template.body.ruleSetRefs ?? []), ...(input.ruleSetRefs ?? [])]);
    const templateAgents = template.body.agents ?? [];
    if (templateAgents.length > quotas.maxAgents) {
      throw new AgentTeamGovernanceError(
        `Template ${template.name}@v${template.version} has ${templateAgents.length} agents; maxAgents=${quotas.maxAgents}`,
        409,
        'AGENT_QUOTA_EXCEEDED',
      );
    }

    const instanceId = `atg_${hashText(`${template.name}:${scopeType}:${scopeKey}`).slice(0, 20)}`;
    const teamName = `atg-${safeName(template.name)}-${scopeType}-${safeScopeKey(scopeKey)}`;
    if (this.host.getTeam(teamName)) {
      // `atg-` is reserved for this extension. A matching upstream row with no
      // governance record is the recoverable half of a previous two-database
      // crash; remove it before the deterministic clean recreate.
      if (teamName.startsWith('atg-') && !this.findAnyInstanceByTeamName(teamName)) {
        this.host.deleteTeam(teamName);
      } else {
        throw new AgentTeamGovernanceError(
          `Upstream Agent Team name is already in use: ${teamName}`,
          409,
          'TEAM_NAME_COLLISION',
        );
      }
    }

    const displayChatIds = scopeType === 'chat' ? [scopeKey] : [];
    try {
      this.host.createTeam(teamName, template.body.description, { displayChatIds });
      for (const agent of templateAgents) {
        this.host.upsertAgent(teamName, { ...agent, status: 'idle' });
      }
      for (const task of template.body.tasks ?? []) {
        this.host.upsertTask(teamName, task);
      }
    } catch (error) {
      this.host.deleteTeam(teamName);
      throw error;
    }

    const now = Date.now();
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `
          INSERT INTO agent_team_governance_instances
            (id, team_name, template_name, template_version, template_digest, scope_type, scope_key,
             quotas_json, pm_bot, temporary_agent_idle_ms, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `,
          )
          .run(
            instanceId,
            teamName,
            template.name,
            template.version,
            template.digest,
            scopeType,
            scopeKey,
            JSON.stringify(quotas),
            input.pmBot?.trim() || null,
            temporaryAgentIdleMs ?? null,
            input.actor.id ?? null,
            now,
            now,
          );
        const insertRef = this.db.prepare(`
          INSERT INTO agent_team_governance_instance_rules
            (instance_id, rule_set_name, rule_set_version, rule_set_digest)
          VALUES (?, ?, ?, ?)
        `);
        for (const ref of ruleSetRefs) {
          insertRef.run(instanceId, ref.name, ref.version, ref.digest);
        }
        const insertLease = this.db.prepare(`
          INSERT INTO agent_team_governance_agent_leases
            (instance_id, agent_name, kind, created_by, last_active_at, created_at)
          VALUES (?, ?, 'template', ?, ?, ?)
        `);
        for (const agent of templateAgents) {
          insertLease.run(instanceId, agent.name, input.actor.id ?? null, now, now);
        }
        this.insertAudit({
          eventType: 'instance.created',
          actor: input.actor,
          instanceId,
          teamName,
          subject: `${template.name}@v${template.version}`,
          details: {
            scopeType,
            scopeKey,
            templateDigest: template.digest,
            ruleSetRefs,
            pmBot: input.pmBot?.trim() || null,
            temporaryAgentIdleMs: temporaryAgentIdleMs ?? null,
          },
          createdAt: now,
        });
      })();
    } catch (error) {
      this.host.deleteTeam(teamName);
      throw error;
    }
    return this.getInstance(instanceId)!;
  }

  getInstance(instanceId: string): GovernedTeamInstance | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM agent_team_governance_instances WHERE id = ?
    `,
      )
      .get(instanceId) as any;
    return row ? this.rowToInstance(row) : undefined;
  }

  listInstances(includeStopped = true): GovernedTeamInstance[] {
    const rows = includeStopped
      ? (this.db.prepare('SELECT * FROM agent_team_governance_instances ORDER BY created_at ASC').all() as any[])
      : (this.db
          .prepare("SELECT * FROM agent_team_governance_instances WHERE status = 'active' ORDER BY created_at ASC")
          .all() as any[]);
    return rows.map((row) => this.rowToInstance(row));
  }

  findInstance(
    templateName: string,
    scopeType: TeamGovernanceScope,
    scopeKey: string,
  ): GovernedTeamInstance | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM agent_team_governance_instances
      WHERE template_name = ? AND scope_type = ? AND scope_key = ? AND status = 'active'
      LIMIT 1
    `,
      )
      .get(templateName, scopeType, scopeKey) as any;
    return row ? this.rowToInstance(row) : undefined;
  }

  private findInstanceRecord(
    templateName: string,
    scopeType: TeamGovernanceScope,
    scopeKey: string,
  ): GovernedTeamInstance | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_team_governance_instances
         WHERE template_name = ? AND scope_type = ? AND scope_key = ? LIMIT 1`,
      )
      .get(templateName, scopeType, scopeKey) as any;
    return row ? this.rowToInstance(row) : undefined;
  }

  findInstanceByTeamName(teamName: string): GovernedTeamInstance | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM agent_team_governance_instances
      WHERE team_name = ? AND status = 'active'
      LIMIT 1
    `,
      )
      .get(teamName) as any;
    return row ? this.rowToInstance(row) : undefined;
  }

  findAnyInstanceByTeamName(teamName: string): GovernedTeamInstance | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_team_governance_instances WHERE team_name = ? LIMIT 1')
      .get(teamName) as any;
    return row ? this.rowToInstance(row) : undefined;
  }

  stopInstance(actor: TeamGovernanceActor, instanceId: string): GovernedTeamInstance {
    const instance = this.requireAnyInstance(instanceId);
    this.requireAuthority(actor, 'stop_team', { instanceId, teamName: instance.teamName });
    this.host.setTeamStatus(instance.teamName, 'stopped');
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE agent_team_governance_instances SET status = 'stopped', updated_at = ? WHERE id = ?")
        .run(now, instanceId);
      this.insertAudit({
        eventType: 'instance.stopped',
        actor,
        instanceId,
        teamName: instance.teamName,
        createdAt: now,
      });
    })();
    return this.getInstance(instanceId)!;
  }

  reactivateInstance(actor: TeamGovernanceActor, instanceId: string): GovernedTeamInstance {
    const instance = this.requireAnyInstance(instanceId);
    this.requireAuthority(actor, 'start_team', { instanceId, teamName: instance.teamName });
    const template = this.requirePinnedTemplate(instance);
    const upstream = this.host.getTeam(instance.teamName);
    if (!upstream) this.createUpstreamFromTemplate(instance, template);
    else {
      this.host.setTeamStatus(instance.teamName, 'active');
      this.repairTemplateMembers(instance, template);
    }
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE agent_team_governance_instances SET status = 'active', updated_at = ? WHERE id = ?")
        .run(now, instanceId);
      this.insertAudit({
        eventType: upstream ? 'instance.reactivated' : 'instance.recreated',
        actor,
        instanceId,
        teamName: instance.teamName,
        details: { reason: upstream ? 'explicit_reactivation' : 'missing_upstream_team' },
        createdAt: now,
      });
    })();
    return this.getInstance(instanceId)!;
  }

  deleteInstance(actor: TeamGovernanceActor, instanceId: string): boolean {
    const instance = this.requireAnyInstance(instanceId);
    this.requireAuthority(actor, 'delete_team', { instanceId, teamName: instance.teamName });
    const now = Date.now();
    this.db.transaction(() => {
      this.insertAudit({
        eventType: 'instance.deleted',
        actor,
        instanceId,
        teamName: instance.teamName,
        createdAt: now,
      });
      this.db.prepare('DELETE FROM agent_team_governance_instances WHERE id = ?').run(instanceId);
    })();
    // Delete the governance row first. If the process dies before the upstream
    // delete, startup reconciliation sees a reserved-prefix orphan and stops
    // it. The opposite order could recreate a Team whose deletion had already
    // been requested.
    this.host.deleteTeam(instance.teamName);
    return true;
  }

  reconcile(): GovernanceReconciliationReport {
    const report: GovernanceReconciliationReport = {
      recreatedTeams: [],
      reactivatedTeams: [],
      stoppedTeams: [],
      stoppedOrphans: [],
    };
    const knownTeams = new Set<string>();
    for (const instance of this.listInstances(true)) {
      knownTeams.add(instance.teamName);
      const template = this.requirePinnedTemplate(instance);
      const upstream = this.host.getTeam(instance.teamName);
      if (instance.status === 'active') {
        if (!upstream) {
          this.createUpstreamFromTemplate(instance, template);
          report.recreatedTeams.push(instance.teamName);
        } else {
          if (upstream.status !== 'active') {
            this.host.setTeamStatus(instance.teamName, 'active');
            report.reactivatedTeams.push(instance.teamName);
          }
          this.repairTemplateMembers(instance, template);
        }
      } else if (upstream?.status === 'active') {
        this.host.setTeamStatus(instance.teamName, 'stopped');
        report.stoppedTeams.push(instance.teamName);
      }
    }
    for (const team of this.host.listTeams()) {
      // Do not claim an arbitrary pre-existing legacy/config Team merely
      // because its name begins with `atg-`. Only the complete deterministic
      // name shape emitted by this extension is eligible for orphan repair.
      if (!isGovernanceTeamName(team.name) || knownTeams.has(team.name) || team.status === 'stopped') continue;
      this.host.setTeamStatus(team.name, 'stopped');
      report.stoppedOrphans.push(team.name);
      this.insertAudit({
        eventType: 'reconcile.orphan_stopped',
        actor: { role: 'system' },
        teamName: team.name,
        details: { reason: 'governance_row_missing' },
      });
    }
    for (const [eventType, teams] of [
      ['reconcile.team_recreated', report.recreatedTeams],
      ['reconcile.team_reactivated', report.reactivatedTeams],
      ['reconcile.team_stopped', report.stoppedTeams],
    ] as const) {
      for (const teamName of teams) {
        const instance = this.findAnyInstanceByTeamName(teamName);
        this.insertAudit({
          eventType,
          actor: { role: 'system' },
          instanceId: instance?.id,
          teamName,
          details: { reason: 'startup_reconciliation' },
        });
      }
    }
    return report;
  }

  findInstanceForContext(input: {
    templateName: string;
    chatId?: string;
    projectId?: string;
    includeGlobal?: boolean;
  }): GovernedTeamInstance | undefined {
    if (input.chatId) {
      const chat = this.findInstance(input.templateName, 'chat', input.chatId);
      if (chat) return chat;
    }
    if (input.projectId) {
      const project = this.findInstance(input.templateName, 'project', input.projectId);
      if (project) return project;
    }
    return input.includeGlobal ? this.findInstance(input.templateName, 'global', 'global') : undefined;
  }

  createAgent(input: {
    actor: TeamGovernanceActor;
    instanceId: string;
    name: string;
    role?: string;
    engine?: EngineName;
    prompt?: string;
    sessionId?: string;
    kind?: Exclude<GovernedAgentKind, 'template'>;
    ttlMs?: number;
  }): GovernedAgentLease {
    this.requireAuthority(input.actor, 'create_agent', {
      instanceId: input.instanceId,
      subject: input.name,
    });
    const instance = this.requireInstance(input.instanceId);
    const name = requireName(input.name, 'agent');
    const kind = input.kind ?? 'custom';
    if (kind === 'temporary' && (!Number.isSafeInteger(input.ttlMs) || input.ttlMs! <= 0)) {
      throw new AgentTeamGovernanceError(
        'Temporary Agents require a positive integer ttlMs',
        400,
        'TEMPORARY_AGENT_TTL_REQUIRED',
      );
    }
    if (kind === 'custom' && input.ttlMs != null) {
      throw new AgentTeamGovernanceError('ttlMs is only valid for temporary Agents', 400, 'CUSTOM_AGENT_TTL_FORBIDDEN');
    }

    const now = Date.now();
    const activeAgents = this.host.listAgents(instance.teamName).filter((agent) => agent.status !== 'stopped');
    if (activeAgents.length >= instance.quotas.maxAgents) {
      this.quotaDenied(input.actor, instance, 'maxAgents', activeAgents.length);
    }
    if (kind === 'temporary') {
      const activeTemporary = this.countActiveTemporaryAgents(instance.id);
      if (activeTemporary >= instance.quotas.maxTemporaryAgents) {
        this.quotaDenied(input.actor, instance, 'maxTemporaryAgents', activeTemporary);
      }
    }

    const existing = this.host.getAgent(instance.teamName, name);
    if (existing && existing.status !== 'stopped') {
      throw new AgentTeamGovernanceError(
        `Agent already exists in ${instance.teamName}: ${name}`,
        409,
        'AGENT_ALREADY_EXISTS',
      );
    }
    const staleLease = this.getActiveLease(instance.id, name);
    if (staleLease) {
      this.markLeaseRecycled(staleLease.id, now, 'host_agent_already_stopped');
    }

    this.host.upsertAgent(instance.teamName, {
      name,
      role: input.role,
      engine: input.engine,
      prompt: input.prompt,
      sessionId: input.sessionId,
      status: 'idle',
    });
    const expiresAt = kind === 'temporary' ? now + input.ttlMs! : undefined;
    try {
      const result = this.db.transaction(() => {
        const inserted = this.db
          .prepare(
            `
          INSERT INTO agent_team_governance_agent_leases
            (instance_id, agent_name, kind, created_by, expires_at, last_active_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(instance.id, name, kind, input.actor.id ?? null, expiresAt ?? null, now, now);
        this.insertAudit({
          eventType: existing ? 'agent.reused' : 'agent.created',
          actor: input.actor,
          instanceId: instance.id,
          teamName: instance.teamName,
          subject: name,
          details: { kind, expiresAt: expiresAt ?? null },
          createdAt: now,
        });
        return Number(inserted.lastInsertRowid);
      })();
      return this.getLease(result)!;
    } catch (error) {
      this.host.setAgentStatus(instance.teamName, name, 'stopped');
      throw error;
    }
  }

  stopAgent(actor: TeamGovernanceActor, instanceId: string, agentName: string): TeamAgent | undefined {
    const instance = this.requireInstance(instanceId);
    this.requireAuthority(actor, 'stop_agent', { instanceId, teamName: instance.teamName, subject: agentName });
    const agent = this.host.setAgentStatus(instance.teamName, agentName, 'stopped');
    if (!agent) return undefined;
    const lease = this.getActiveLease(instanceId, agentName);
    if (lease) this.markLeaseRecycled(lease.id, Date.now(), 'agent_stopped');
    this.insertAudit({
      eventType: 'agent.stopped',
      actor,
      instanceId,
      teamName: instance.teamName,
      subject: agentName,
    });
    return agent;
  }

  deleteAgent(actor: TeamGovernanceActor, instanceId: string, agentName: string): boolean {
    const instance = this.requireInstance(instanceId);
    this.requireAuthority(actor, 'delete_agent', { instanceId, teamName: instance.teamName, subject: agentName });
    const deleted = this.host.deleteAgent(instance.teamName, agentName);
    const lease = this.getActiveLease(instanceId, agentName);
    if (lease) this.markLeaseRecycled(lease.id, Date.now(), 'agent_deleted');
    if (deleted) {
      this.insertAudit({
        eventType: 'agent.deleted',
        actor,
        instanceId,
        teamName: instance.teamName,
        subject: agentName,
      });
    }
    return deleted;
  }

  reapExpired(now = Date.now()): GovernedAgentReapAction[] {
    const rows = this.db
      .prepare(
        `
      SELECT l.*, i.team_name, i.temporary_agent_idle_ms
      FROM agent_team_governance_agent_leases l
      JOIN agent_team_governance_instances i ON i.id = l.instance_id
      WHERE l.kind = 'temporary' AND l.recycled_at IS NULL
        AND (
          (l.expires_at IS NOT NULL AND l.expires_at <= ?)
          OR (
            i.temporary_agent_idle_ms IS NOT NULL
            AND l.last_active_at <= ? - i.temporary_agent_idle_ms
          )
        )
      ORDER BY l.id ASC
    `,
      )
      .all(now, now) as any[];
    const actions = rows.map((row): GovernedAgentReapAction => {
      const lease = this.rowToLease(row);
      const reason = lease.expiresAt != null && lease.expiresAt <= now ? 'ttl_expired' : 'idle_expired';
      const runningRuns = this.host
        .listRuns(lease.teamName)
        .filter((run) => run.agentName === lease.agentName && run.status === 'running')
        .map((run) => ({ runId: run.id, ...(run.taskId != null ? { taskId: run.taskId } : {}) }));
      return { lease: { ...lease, recycledAt: now }, reason, runningRuns };
    });
    for (const action of actions) {
      this.host.setAgentStatus(action.lease.teamName, action.lease.agentName, 'stopped');
    }
    this.db.transaction(() => {
      for (const action of actions) {
        this.db
          .prepare(
            `
          UPDATE agent_team_governance_agent_leases SET recycled_at = ?
          WHERE id = ? AND recycled_at IS NULL
        `,
          )
          .run(now, action.lease.id);
        this.insertAudit({
          eventType: 'agent.reaped',
          actor: { role: 'system' },
          instanceId: action.lease.instanceId,
          teamName: action.lease.teamName,
          subject: action.lease.agentName,
          details: {
            leaseId: action.lease.id,
            reason: action.reason,
            expiresAt: action.lease.expiresAt ?? null,
            lastActiveAt: action.lease.lastActiveAt,
            runningRuns: action.runningRuns,
          },
          createdAt: now,
        });
      }
    })();
    return actions;
  }

  touchAgent(instanceId: string, agentName: string, at = Date.now()): GovernedAgentLease | undefined {
    const lease = this.getActiveLease(instanceId, agentName);
    if (!lease) return undefined;
    this.db
      .prepare(
        `
      UPDATE agent_team_governance_agent_leases
      SET last_active_at = CASE WHEN last_active_at < ? THEN ? ELSE last_active_at END
      WHERE id = ? AND recycled_at IS NULL
    `,
      )
      .run(at, at, lease.id);
    return this.getLease(lease.id);
  }

  prepareRun(teamName: string, agentName: string, _runId?: string): GovernedRunPreparation | undefined {
    const instance = this.findInstanceByTeamName(teamName);
    if (!instance) return undefined;
    this.touchAgent(instance.id, agentName);
    const base = `teaminst:${instance.id}:${agentName}`;
    return {
      instanceId: instance.id,
      chatId: base,
      ...(instance.pmBot ? { executionBot: instance.pmBot } : {}),
    };
  }

  buildRulesContext(instanceId: string, subject: GovernedRulesSubject): GovernedRulesContext {
    const instance = this.requireInstance(instanceId);
    const sections: string[] = [];
    const provenance: GovernedRulesContext['provenance'] = [];
    for (const ref of instance.ruleSetRefs) {
      const ruleSet = this.getRuleSet(ref.name, ref.version);
      if (!ruleSet || ruleSet.digest !== ref.digest) {
        throw new AgentTeamGovernanceError(
          `Pinned Agent Team RuleSet is unavailable or changed: ${ref.name}@v${ref.version}`,
          500,
          'PINNED_RULE_SET_INVALID',
        );
      }
      const selectedRules = ruleSet.rules.filter((rule) => governanceRuleMatchesSubject(rule, subject));
      if (selectedRules.length > 0) {
        sections.push(
          `## ${ruleSet.scope}:${ruleSet.name}@v${ruleSet.version}`,
          ...selectedRules.map((rule) => `- ${rule.text}`),
        );
      }
      provenance.push({
        name: ruleSet.name,
        version: ruleSet.version,
        digest: ruleSet.digest,
        scope: ruleSet.scope,
        ruleCount: ruleSet.rules.length,
        selectedRuleCount: selectedRules.length,
      });
    }
    return { text: sections.join('\n'), provenance };
  }

  assertCanQueueTask(instanceId: string, actor: TeamGovernanceActor | { role: 'system' } = { role: 'system' }): void {
    const instance = this.requireInstance(instanceId);
    const queued = this.host
      .listTasks(instance.teamName)
      .filter((task) => task.status === 'pending' || task.status === 'in_progress').length;
    if (queued >= instance.quotas.maxQueuedTasks) {
      this.quotaDenied(actor, instance, 'maxQueuedTasks', queued);
    }
  }

  assertCanStartRun(instanceId: string, agentName: string): void {
    const instance = this.requireInstance(instanceId);
    const running = this.host.listRuns(instance.teamName).filter((run) => run.status === 'running');
    if (running.length >= instance.quotas.maxActiveRuns) {
      this.quotaDenied({ role: 'system' }, instance, 'maxActiveRuns', running.length);
    }
    const agentRuns = running.filter((run) => run.agentName === agentName).length;
    if (agentRuns >= instance.quotas.maxParallelRunsPerAgent) {
      this.quotaDenied({ role: 'system' }, instance, 'maxParallelRunsPerAgent', agentRuns);
    }
  }

  authorize(
    actor: TeamGovernanceActor,
    action: TeamGovernanceAction,
    context: { instanceId?: string; teamName?: string; subject?: string } = {},
  ): void {
    this.requireAuthority(actor, action, { ...context, auditAllowed: true });
  }

  listAudit(input: { instanceId?: string; limit?: number } = {}): AgentTeamGovernanceAuditEvent[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows = input.instanceId
      ? (this.db
          .prepare(
            `
          SELECT * FROM agent_team_governance_audit
          WHERE instance_id = ? ORDER BY id DESC LIMIT ?
        `,
          )
          .all(input.instanceId, limit) as any[])
      : (this.db
          .prepare(
            `
          SELECT * FROM agent_team_governance_audit ORDER BY id DESC LIMIT ?
        `,
          )
          .all(limit) as any[]);
    return rows.map((row) => this.rowToAudit(row));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_team_governance_templates (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (name, version),
        UNIQUE (name, digest)
      );

      CREATE TABLE IF NOT EXISTS agent_team_governance_rule_sets (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        scope TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (name, version),
        UNIQUE (name, digest)
      );

      CREATE TABLE IF NOT EXISTS agent_team_governance_instances (
        id TEXT PRIMARY KEY,
        team_name TEXT NOT NULL UNIQUE,
        template_name TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        template_digest TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        quotas_json TEXT NOT NULL,
        pm_bot TEXT,
        temporary_agent_idle_ms INTEGER,
        status TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (template_name, scope_type, scope_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_team_governance_scope
        ON agent_team_governance_instances(scope_type, scope_key, status);

      CREATE TABLE IF NOT EXISTS agent_team_governance_instance_rules (
        instance_id TEXT NOT NULL,
        rule_set_name TEXT NOT NULL,
        rule_set_version INTEGER NOT NULL,
        rule_set_digest TEXT NOT NULL,
        PRIMARY KEY (instance_id, rule_set_name),
        FOREIGN KEY (instance_id) REFERENCES agent_team_governance_instances(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_team_governance_agent_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_by TEXT,
        expires_at INTEGER,
        last_active_at INTEGER NOT NULL,
        recycled_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES agent_team_governance_instances(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_team_governance_active_lease
        ON agent_team_governance_agent_leases(instance_id, agent_name)
        WHERE recycled_at IS NULL;

      CREATE TABLE IF NOT EXISTS agent_team_governance_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        actor_id TEXT,
        instance_id TEXT,
        team_name TEXT,
        subject TEXT,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_team_governance_audit_instance
        ON agent_team_governance_audit(instance_id, id DESC);
    `);
  }

  private pinRuleSetRefs(refs: GovernanceRuleSetRef[]): PinnedGovernanceRuleSet[] {
    const pinned = new Map<string, PinnedGovernanceRuleSet>();
    for (const ref of refs) {
      const ruleSet = this.getRuleSet(ref.name, ref.version);
      if (!ruleSet) {
        const suffix = ref.version == null ? '' : `@v${ref.version}`;
        throw new AgentTeamGovernanceError(
          `Agent Team governance RuleSet not found: ${ref.name}${suffix}`,
          404,
          'RULE_SET_NOT_FOUND',
        );
      }
      const next = { name: ruleSet.name, version: ruleSet.version, digest: ruleSet.digest };
      const current = pinned.get(next.name);
      if (current && current.version !== next.version) {
        throw new AgentTeamGovernanceError(
          `Conflicting RuleSet versions requested: ${next.name}@v${current.version} and v${next.version}`,
          400,
          'RULE_SET_VERSION_CONFLICT',
        );
      }
      pinned.set(next.name, next);
    }
    return [...pinned.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private requireAuthority(
    actor: TeamGovernanceActor | undefined,
    action: TeamGovernanceAction,
    context: {
      instanceId?: string;
      teamName?: string;
      subject?: string;
      details?: Record<string, unknown>;
      auditAllowed?: boolean;
    },
  ): void {
    if (!actor || !isTeamGovernanceActorRole(actor.role)) {
      this.insertAudit({
        eventType: 'authority.denied',
        actor: { role: 'unknown', ...(actor?.id ? { id: actor.id } : {}) },
        instanceId: context.instanceId,
        teamName: context.teamName,
        subject: context.subject,
        details: { action, reason: 'missing_trusted_principal', ...(context.details ?? {}) },
      });
      throw new AgentTeamGovernanceError(
        `A trusted principal is required to ${action}`,
        401,
        'TRUSTED_PRINCIPAL_REQUIRED',
      );
    }
    if (hasTeamGovernanceAuthority(actor.role, action)) {
      if (context.auditAllowed) {
        this.insertAudit({
          eventType: 'authority.allowed',
          actor,
          instanceId: context.instanceId,
          teamName: context.teamName,
          subject: context.subject,
          details: { action, ...(context.details ?? {}) },
        });
      }
      return;
    }
    this.insertAudit({
      eventType: 'authority.denied',
      actor,
      instanceId: context.instanceId,
      teamName: context.teamName,
      subject: context.subject,
      details: { action, ...(context.details ?? {}) },
    });
    throw new AgentTeamGovernanceError(`${actor.role} is not allowed to ${action}`, 403, 'AUTHORITY_DENIED');
  }

  private requireScopeQuota(
    scopeType: TeamGovernanceScope,
    scopeKey: string,
    maxTeamsPerScope: number,
    actor: TeamGovernanceActor,
  ): void {
    const count = Number(
      (
        this.db
          .prepare(
            `
      SELECT COUNT(*) AS count FROM agent_team_governance_instances
      WHERE scope_type = ? AND scope_key = ? AND status = 'active'
    `,
          )
          .get(scopeType, scopeKey) as any
      )?.count ?? 0,
    );
    if (count < maxTeamsPerScope) return;
    this.insertAudit({
      eventType: 'quota.denied',
      actor,
      subject: `${scopeType}:${scopeKey}`,
      details: { quota: 'maxTeamsPerScope', current: count, limit: maxTeamsPerScope },
    });
    throw new AgentTeamGovernanceError(
      `Agent Team scope quota exceeded for ${scopeType}:${scopeKey}: maxTeamsPerScope=${maxTeamsPerScope}`,
      409,
      'SCOPE_TEAM_QUOTA_EXCEEDED',
    );
  }

  private quotaDenied(
    actor: TeamGovernanceActor | { role: 'system' },
    instance: GovernedTeamInstance,
    quota: keyof AgentTeamGovernanceQuotas,
    current: number,
  ): never {
    const limit = instance.quotas[quota];
    this.insertAudit({
      eventType: 'quota.denied',
      actor,
      instanceId: instance.id,
      teamName: instance.teamName,
      details: { quota, current, limit },
    });
    throw new AgentTeamGovernanceError(
      `Agent Team quota exceeded for ${instance.teamName}: ${quota}=${limit}`,
      409,
      'TEAM_QUOTA_EXCEEDED',
    );
  }

  private requireInstance(instanceId: string): GovernedTeamInstance {
    const instance = this.getInstance(instanceId);
    if (!instance || instance.status !== 'active') {
      throw new AgentTeamGovernanceError(
        `Governed Agent Team instance not found: ${instanceId}`,
        404,
        'INSTANCE_NOT_FOUND',
      );
    }
    return instance;
  }

  private requireAnyInstance(instanceId: string): GovernedTeamInstance {
    const instance = this.getInstance(instanceId);
    if (!instance) {
      throw new AgentTeamGovernanceError(
        `Governed Agent Team instance not found: ${instanceId}`,
        404,
        'INSTANCE_NOT_FOUND',
      );
    }
    return instance;
  }

  private requirePinnedTemplate(instance: GovernedTeamInstance): AgentTeamGovernanceTemplateVersion {
    const template = this.getTemplate(instance.templateName, instance.templateVersion);
    if (!template || template.digest !== instance.templateDigest) {
      throw new AgentTeamGovernanceError(
        `Pinned Agent Team template is unavailable or changed: ${instance.templateName}@v${instance.templateVersion}`,
        500,
        'PINNED_TEMPLATE_INVALID',
      );
    }
    return template;
  }

  private createUpstreamFromTemplate(
    instance: GovernedTeamInstance,
    template: AgentTeamGovernanceTemplateVersion,
  ): void {
    const collision = this.host.getTeam(instance.teamName);
    if (collision) this.host.deleteTeam(instance.teamName);
    const displayChatIds = instance.scopeType === 'chat' ? [instance.scopeKey] : [];
    this.host.createTeam(instance.teamName, template.body.description, { displayChatIds, status: 'active' });
    this.repairTemplateMembers(instance, template);
  }

  private repairTemplateMembers(instance: GovernedTeamInstance, template: AgentTeamGovernanceTemplateVersion): void {
    for (const agent of template.body.agents ?? []) {
      if (!this.host.getAgent(instance.teamName, agent.name)) {
        this.host.upsertAgent(instance.teamName, { ...agent, status: 'idle' });
      }
    }
    const existingTaskIds = new Set(this.host.listTasks(instance.teamName).map((task) => task.id));
    for (const task of template.body.tasks ?? []) {
      if (task.id == null || !existingTaskIds.has(task.id)) this.host.upsertTask(instance.teamName, task);
    }
  }

  private countActiveTemporaryAgents(instanceId: string): number {
    return Number(
      (
        this.db
          .prepare(
            `
      SELECT COUNT(*) AS count FROM agent_team_governance_agent_leases
      WHERE instance_id = ? AND kind = 'temporary' AND recycled_at IS NULL
    `,
          )
          .get(instanceId) as any
      )?.count ?? 0,
    );
  }

  private getActiveLease(instanceId: string, name: string): GovernedAgentLease | undefined {
    const row = this.db
      .prepare(
        `
      SELECT l.*, i.team_name
      FROM agent_team_governance_agent_leases l
      JOIN agent_team_governance_instances i ON i.id = l.instance_id
      WHERE l.instance_id = ? AND l.agent_name = ? AND l.recycled_at IS NULL
    `,
      )
      .get(instanceId, name) as any;
    return row ? this.rowToLease(row) : undefined;
  }

  private getLease(id: number): GovernedAgentLease | undefined {
    const row = this.db
      .prepare(
        `
      SELECT l.*, i.team_name
      FROM agent_team_governance_agent_leases l
      JOIN agent_team_governance_instances i ON i.id = l.instance_id
      WHERE l.id = ?
    `,
      )
      .get(id) as any;
    return row ? this.rowToLease(row) : undefined;
  }

  private markLeaseRecycled(id: number, now: number, reason: string): void {
    const lease = this.getLease(id);
    if (!lease || lease.recycledAt) return;
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE agent_team_governance_agent_leases SET recycled_at = ? WHERE id = ?
      `,
        )
        .run(now, id);
      this.insertAudit({
        eventType: 'agent.reconciled_recycled',
        actor: { role: 'system' },
        instanceId: lease.instanceId,
        teamName: lease.teamName,
        subject: lease.agentName,
        details: { leaseId: id, reason },
        createdAt: now,
      });
    })();
  }

  private rowToTemplate(row: any): AgentTeamGovernanceTemplateVersion {
    const body = parseJsonStrict<AgentTeamGovernanceTemplateBody>(row.body_json, 'template body');
    if (hashObject(body) !== row.digest) {
      throw new AgentTeamGovernanceError(
        `Stored Agent Team template digest mismatch: ${row.name}@v${row.version}`,
        500,
        'TEMPLATE_DIGEST_MISMATCH',
      );
    }
    return {
      name: row.name,
      version: Number(row.version),
      digest: row.digest,
      body,
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      createdAt: Number(row.created_at),
    };
  }

  private rowToRuleSet(row: any): GovernanceRuleSetVersion {
    const rules = parseJsonStrict<GovernanceRule[]>(row.rules_json, 'RuleSet rules');
    if (hashObject({ scope: row.scope, rules }) !== row.digest) {
      throw new AgentTeamGovernanceError(
        `Stored Agent Team RuleSet digest mismatch: ${row.name}@v${row.version}`,
        500,
        'RULE_SET_DIGEST_MISMATCH',
      );
    }
    return {
      name: row.name,
      version: Number(row.version),
      digest: row.digest,
      scope: row.scope,
      rules,
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      createdAt: Number(row.created_at),
    };
  }

  private rowToInstance(row: any): GovernedTeamInstance {
    const rules = this.db
      .prepare(
        `
      SELECT rule_set_name, rule_set_version, rule_set_digest
      FROM agent_team_governance_instance_rules WHERE instance_id = ?
      ORDER BY rule_set_name ASC
    `,
      )
      .all(row.id) as any[];
    return {
      id: row.id,
      teamName: row.team_name,
      templateName: row.template_name,
      templateVersion: Number(row.template_version),
      templateDigest: row.template_digest,
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      quotas: mergeQuotas(parseJsonStrict(row.quotas_json, 'instance quotas')),
      ruleSetRefs: rules.map((rule) => ({
        name: rule.rule_set_name,
        version: Number(rule.rule_set_version),
        digest: rule.rule_set_digest,
      })),
      ...(row.pm_bot ? { pmBot: row.pm_bot } : {}),
      ...(row.temporary_agent_idle_ms != null ? { temporaryAgentIdleMs: Number(row.temporary_agent_idle_ms) } : {}),
      status: row.status,
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToLease(row: any): GovernedAgentLease {
    return {
      id: Number(row.id),
      instanceId: row.instance_id,
      teamName: row.team_name,
      agentName: row.agent_name,
      kind: row.kind,
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      ...(row.expires_at != null ? { expiresAt: Number(row.expires_at) } : {}),
      lastActiveAt: Number(row.last_active_at),
      ...(row.recycled_at != null ? { recycledAt: Number(row.recycled_at) } : {}),
      createdAt: Number(row.created_at),
    };
  }

  private rowToAudit(row: any): AgentTeamGovernanceAuditEvent {
    return {
      id: Number(row.id),
      eventType: row.event_type,
      actorRole: row.actor_role,
      ...(row.actor_id ? { actorId: row.actor_id } : {}),
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      ...(row.team_name ? { teamName: row.team_name } : {}),
      ...(row.subject ? { subject: row.subject } : {}),
      details: parseJson(row.details_json, {}),
      createdAt: Number(row.created_at),
    };
  }

  private insertAudit(input: {
    eventType: string;
    actor: TeamGovernanceActor | { role: 'system' | 'unknown'; id?: string };
    instanceId?: string;
    teamName?: string;
    subject?: string;
    details?: Record<string, unknown>;
    createdAt?: number;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO agent_team_governance_audit
        (event_type, actor_role, actor_id, instance_id, team_name, subject, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.eventType,
        input.actor.role,
        input.actor.id ?? null,
        input.instanceId ?? null,
        input.teamName ?? null,
        input.subject ?? null,
        JSON.stringify(input.details ?? {}),
        input.createdAt ?? Date.now(),
      );
  }
}

export function createAgentTeamGovernanceHost(store: AgentTeamStore): AgentTeamGovernanceHost {
  return {
    listTeams: () => store.listTeams(),
    getTeam: (name) => store.getTeam(name),
    createTeam: (name, description, options) => store.createTeam(name, description, options),
    setTeamStatus: (name, status) => store.setTeamStatus(name, status),
    deleteTeam: (name) => store.deleteTeam(name),
    listAgents: (teamName) => store.listAgents(teamName),
    getAgent: (teamName, name) => store.getAgent(teamName, name),
    upsertAgent: (teamName, input) => store.upsertAgent(teamName, input),
    setAgentStatus: (teamName, name, status) => store.setAgentStatus(teamName, name, status),
    deleteAgent: (teamName, name) => store.deleteAgent(teamName, name),
    upsertTask: (teamName, input) => store.upsertTask(teamName, input),
    listTasks: (teamName) => store.listTasks(teamName),
    listRuns: (teamName) => store.listRuns(teamName),
  };
}

export function hasTeamGovernanceAuthority(role: TeamGovernanceActorRole, action: TeamGovernanceAction): boolean {
  if (role === 'admin' || role === 'user' || role === 'pm') return true;
  return (role === 'manager' || role === 'agent') && action === 'coordinate_existing_agents';
}

function isTeamGovernanceActorRole(value: unknown): value is TeamGovernanceActorRole {
  return (
    value === 'admin' ||
    value === 'user' ||
    value === 'pm' ||
    value === 'manager' ||
    value === 'agent' ||
    value === 'worker'
  );
}

function normalizeTemplateBody(input: AgentTeamGovernanceTemplateBody): AgentTeamGovernanceTemplateBody {
  const agents = input.agents?.map((agent) => ({ ...agent, name: requireName(agent.name, 'agent') }));
  if (agents && new Set(agents.map((agent) => agent.name)).size !== agents.length) {
    throw new AgentTeamGovernanceError('Template Agent names must be unique', 400, 'DUPLICATE_AGENT_NAME');
  }
  const tasks = input.tasks?.map((task) => ({
    ...task,
    subject: requireName(task.subject, 'task subject'),
    blockedBy: [...new Set(task.blockedBy ?? [])],
  }));
  return {
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(agents?.length ? { agents } : {}),
    ...(tasks?.length ? { tasks } : {}),
    ...(input.quotas ? { quotas: mergeQuotas(input.quotas) } : {}),
    ...(input.ruleSetRefs?.length
      ? { ruleSetRefs: input.ruleSetRefs.map((ref) => ({ ...ref, name: requireName(ref.name, 'RuleSet') })) }
      : {}),
    ...(input.temporaryAgentIdleMs != null
      ? { temporaryAgentIdleMs: normalizeOptionalDuration(input.temporaryAgentIdleMs, 'temporaryAgentIdleMs') }
      : {}),
  };
}

function normalizeRules(rules: GovernanceRule[]): GovernanceRule[] {
  return rules.map((rule, index) => {
    const text = rule.text?.trim();
    if (!text) {
      throw new AgentTeamGovernanceError(`Rule ${index + 1} requires text`, 400, 'INVALID_RULE');
    }
    const target = rule.target?.trim();
    return {
      ...(rule.id?.trim() ? { id: rule.id.trim() } : {}),
      text,
      ...(target ? { target: normalizeGovernanceRuleTarget(target, index) } : {}),
    };
  });
}

function normalizeGovernanceRuleTarget(target: string, index: number): string {
  const prefixed = target.match(/^(agent|role):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
  if (prefixed) return `${prefixed[1]}:${prefixed[2]}`;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target)) return `agent:${target}`;
  throw new AgentTeamGovernanceError(
    `Rule ${index + 1} has unsupported target: ${target}`,
    400,
    'INVALID_RULE_TARGET',
  );
}

function governanceRuleMatchesSubject(rule: GovernanceRule, subject: GovernedRulesSubject): boolean {
  if (!rule.target) return true;
  const parsed = rule.target.match(/^(agent|role):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
  if (!parsed) {
    throw new AgentTeamGovernanceError(
      `Stored Agent Team rule has unsupported target: ${rule.target}`,
      500,
      'PINNED_RULE_TARGET_INVALID',
    );
  }
  return parsed[1] === 'agent'
    ? parsed[2] === subject.agentName
    : parsed[2] === subject.agentRole;
}

function mergeQuotas(...inputs: Array<Partial<AgentTeamGovernanceQuotas> | undefined>): AgentTeamGovernanceQuotas {
  const quotas = Object.assign({}, DEFAULT_AGENT_TEAM_GOVERNANCE_QUOTAS, ...inputs);
  for (const [key, value] of Object.entries(quotas)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new AgentTeamGovernanceError(`Invalid Agent Team quota ${key}: ${value}`, 400, 'INVALID_QUOTA');
    }
  }
  return quotas;
}

function normalizeOptionalDuration(value: number | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgentTeamGovernanceError(`Invalid ${label}: ${value}`, 400, 'INVALID_DURATION');
  }
  return value;
}

function resolveScopeKey(
  scopeType: TeamGovernanceScope,
  input: Pick<ResolveGovernedTeamInstanceInput, 'scopeKey' | 'chatId' | 'projectId'>,
): string {
  const value =
    input.scopeKey ??
    (scopeType === 'chat' ? input.chatId : undefined) ??
    (scopeType === 'project' ? input.projectId : undefined) ??
    (scopeType === 'global' ? 'global' : undefined);
  if (!value?.trim()) {
    throw new AgentTeamGovernanceError(
      `Missing scope key for ${scopeType} Agent Team instance`,
      400,
      'SCOPE_KEY_REQUIRED',
    );
  }
  return value.trim();
}

function requireName(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new AgentTeamGovernanceError(`${label} name is required`, 400, 'NAME_REQUIRED');
  }
  return normalized;
}

function safeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${normalized.slice(0, 40) || 'team'}-${hashText(value).slice(0, 6)}`;
}

function safeScopeKey(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${normalized.slice(0, 32) || 'scope'}-${hashText(value).slice(0, 8)}`;
}

function isGovernanceTeamName(value: string): boolean {
  return /^atg-[a-z0-9._-]+-[0-9a-f]{6}-(?:chat|project|global)-[a-z0-9._-]+-[0-9a-f]{8}$/.test(value);
}

function hashObject(value: unknown): string {
  return hashText(stableStringify(value));
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseJsonStrict<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new AgentTeamGovernanceError(
      `Stored Agent Team governance ${label} is corrupt`,
      500,
      'GOVERNANCE_DATA_CORRUPT',
    );
  }
}
