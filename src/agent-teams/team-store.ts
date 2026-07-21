import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineName } from '../engines/types.js';
import type { Logger } from '../utils/logger.js';

export type TeamStatus = 'active' | 'stopped';
export type AgentStatus = 'idle' | 'working' | 'stopped';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type TeamAgentReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TeamAgentApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type TeamAgentSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type TeamInstanceScope = 'chat' | 'project' | 'global' | 'legacy';
export type TeamAgentKind = 'template' | 'custom' | 'temporary';
export type TeamAgentPromotionStatus = 'none' | 'proposed' | 'approved' | 'rejected';
export type TeamActorRole = 'admin' | 'user' | 'pm' | 'manager' | 'agent' | 'worker';
export type TeamPromotionProposalKind = 'template' | 'ruleset';
export type TeamPromotionProposalStatus = 'pending' | 'approved' | 'rejected';
export type TeamCapabilityAction =
  | 'create_agent'
  | 'worker_dispatch'
  | 'promote_template'
  | 'restart_service'
  | 'manage_internal_task';
export type TeamRuleScope = 'global' | 'bot' | 'team-template' | 'team-instance' | 'project' | 'agent-role' | 'worker' | 'task';

export interface AgentTeamQuotas {
  maxAgents: number;
  maxTemporaryAgents: number;
  maxParallelRunsPerAgent: number;
  maxTeamsPerScope: number;
  maxQueuedTasks: number;
  maxActiveRuns: number;
}

export interface AgentTeamTemplateVersion {
  name: string;
  version: number;
  digest: string;
  description?: string;
  body: AgentTeamConfig;
  source: string;
  createdAt: number;
}

export interface TeamRule {
  id?: string;
  text: string;
  target?: string;
  overridable?: boolean;
}

export interface TeamRuleSetVersion {
  name: string;
  version: number;
  digest: string;
  scope: TeamRuleScope;
  rules: TeamRule[];
  source?: string;
  createdAt: number;
}

export interface TeamRuleSetRef {
  name: string;
  version?: number;
}

export interface TeamRuleSetConfig {
  name: string;
  scope: TeamRuleScope;
  rules: TeamRule[];
  source?: string;
}

export type TeamPromotionProposalBody = AgentTeamConfig | TeamRuleSetConfig;

export interface TeamPromotionProposal {
  id: string;
  kind: TeamPromotionProposalKind;
  targetName: string;
  summary?: string;
  body: TeamPromotionProposalBody;
  status: TeamPromotionProposalStatus;
  requestedBy?: string;
  requestedByRole: TeamActorRole;
  decidedBy?: string;
  decisionReason?: string;
  appliedVersion?: number;
  appliedDigest?: string;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number;
}

export interface RulesContextPack {
  text: string;
  provenance: Array<{
    name: string;
    version: number;
    digest: string;
    scope: TeamRuleScope;
    ruleCount: number;
  }>;
  inlineRules: TeamRule[];
}

export type RuntimeRulesPurpose = 'bot-turn' | 'agent-run' | 'worker-dispatch';

export interface AgentTeam {
  name: string;
  description?: string;
  status: TeamStatus;
  chatIds: string[];
  displayChatIds: string[];
  managedByConfig: boolean;
  templateName?: string;
  templateVersion?: number;
  templateDigest?: string;
  scopeType: TeamInstanceScope;
  scopeKey?: string;
  instanceId?: string;
  pmBot?: string;
  quotas: AgentTeamQuotas;
  ruleSetRefs: TeamRuleSetRef[];
  createdAt: number;
  updatedAt: number;
}

export interface TeamAgent {
  teamName: string;
  instanceId?: string;
  name: string;
  role?: string;
  engine?: EngineName;
  model?: string;
  reasoningEffort?: TeamAgentReasoningEffort;
  approvalPolicy?: TeamAgentApprovalPolicy;
  sandbox?: TeamAgentSandbox;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  allowedTools?: string[];
  prompt?: string;
  status: AgentStatus;
  sessionId?: string;
  kind: TeamAgentKind;
  createdBy?: string;
  expiresAt?: number;
  lastActiveAt?: number;
  promotionStatus: TeamAgentPromotionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TeamTask {
  teamName: string;
  instanceId?: string;
  id: number;
  subject: string;
  description?: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: number[];
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMessage {
  id: number;
  teamName: string;
  instanceId?: string;
  fromName?: string;
  toName: string;
  summary?: string;
  body: string;
  readAt?: number;
  createdAt: number;
}

export interface TeamRun {
  id: string;
  teamName: string;
  instanceId?: string;
  agentName?: string;
  taskId?: number;
  status: RunStatus;
  output?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface AgentTeamConfig {
  name: string;
  description?: string;
  status?: TeamStatus;
  chatIds?: string[];
  displayChatIds?: string[];
  managedByConfig?: boolean;
  templateName?: string;
  templateVersion?: number;
  templateDigest?: string;
  scopeType?: TeamInstanceScope;
  scopeKey?: string;
  instanceId?: string;
  pmBot?: string;
  quotas?: Partial<AgentTeamQuotas>;
  ruleSetRefs?: Array<TeamRuleSetRef | string>;
  agents?: Array<{
    name: string;
    role?: string;
    engine?: EngineName;
    model?: string;
    reasoningEffort?: TeamAgentReasoningEffort;
    approvalPolicy?: TeamAgentApprovalPolicy;
    sandbox?: TeamAgentSandbox;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    allowedTools?: string[];
    prompt?: string;
    sessionId?: string;
    status?: AgentStatus;
    kind?: TeamAgentKind;
    createdBy?: string;
    ttlMs?: number;
    expiresAt?: number;
    promotionStatus?: TeamAgentPromotionStatus;
  }>;
  tasks?: Array<{
    id?: number;
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: number[];
    status?: TaskStatus;
    result?: string;
  }>;
}

export interface ResolveTeamInstanceInput {
  templateName: string;
  templateVersion?: number;
  scopeType?: Exclude<TeamInstanceScope, 'legacy'>;
  scopeKey?: string;
  chatId?: string;
  projectId?: string;
  pmBot?: string;
  createIfMissing?: boolean;
  allowGlobal?: boolean;
  quotas?: Partial<AgentTeamQuotas>;
  ruleSetRefs?: Array<TeamRuleSetRef | string>;
}

export const DEFAULT_AGENT_TEAM_QUOTAS: AgentTeamQuotas = {
  maxAgents: 8,
  maxTemporaryAgents: 3,
  maxParallelRunsPerAgent: 4,
  maxTeamsPerScope: 3,
  maxQueuedTasks: 64,
  maxActiveRuns: 16,
};

export class AgentTeamStore {
  private readonly db: Database.Database;

  constructor(logger: Logger, dbPath?: string) {
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    const finalPath = dbPath || path.join(dataDir, 'agent-teams.db');
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    logger.child({ module: 'agent-team-store' }).info({ dbPath: finalPath }, 'Agent team store initialized');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_teams (
        name TEXT PRIMARY KEY,
        description TEXT,
        status TEXT NOT NULL,
        chat_ids TEXT NOT NULL DEFAULT '[]',
        display_chat_ids TEXT NOT NULL DEFAULT '[]',
        managed_by_config INTEGER NOT NULL DEFAULT 0,
        template_name TEXT,
        template_version INTEGER,
        template_digest TEXT,
        scope_type TEXT NOT NULL DEFAULT 'legacy',
        scope_key TEXT,
        instance_id TEXT,
        pm_bot TEXT,
        quotas TEXT NOT NULL DEFAULT '{}',
        rule_set_refs TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_team_templates (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        description TEXT,
        body_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (name, version),
        UNIQUE (name, digest)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_team_templates_latest
        ON agent_team_templates(name, version DESC);

      CREATE TABLE IF NOT EXISTS agent_team_rule_sets (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        scope TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (name, version),
        UNIQUE (name, digest)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_team_rule_sets_latest
        ON agent_team_rule_sets(name, version DESC);

      CREATE TABLE IF NOT EXISTS agent_team_promotion_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_name TEXT NOT NULL,
        summary TEXT,
        body_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT,
        requested_by_role TEXT NOT NULL,
        decided_by TEXT,
        decision_reason TEXT,
        applied_version INTEGER,
        applied_digest TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_team_promotion_proposals_status
        ON agent_team_promotion_proposals(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_team_agents (
        team_name TEXT NOT NULL,
        instance_id TEXT,
        name TEXT NOT NULL,
        role TEXT,
        engine TEXT,
        model TEXT,
        reasoning_effort TEXT,
        approval_policy TEXT,
        sandbox TEXT,
        timeout_ms INTEGER,
        idle_timeout_ms INTEGER,
        allowed_tools TEXT,
        prompt TEXT,
        status TEXT NOT NULL,
        session_id TEXT,
        kind TEXT NOT NULL DEFAULT 'custom',
        created_by TEXT,
        expires_at INTEGER,
        last_active_at INTEGER,
        promotion_status TEXT NOT NULL DEFAULT 'none',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (team_name, name),
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_team_tasks (
        team_name TEXT NOT NULL,
        instance_id TEXT,
        id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        owner TEXT,
        blocked_by TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (team_name, id),
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_team_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_name TEXT NOT NULL,
        instance_id TEXT,
        from_name TEXT,
        to_name TEXT NOT NULL,
        summary TEXT,
        body TEXT NOT NULL,
        read_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_team_messages_inbox
        ON agent_team_messages(team_name, to_name, read_at, created_at);

      CREATE TABLE IF NOT EXISTS agent_team_runs (
        id TEXT PRIMARY KEY,
        team_name TEXT NOT NULL,
        instance_id TEXT,
        agent_name TEXT,
        task_id INTEGER,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );
    `);
    this.addColumnIfMissing('agent_teams', 'chat_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('agent_teams', 'display_chat_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('agent_teams', 'managed_by_config', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('agent_teams', 'template_name', 'TEXT');
    this.addColumnIfMissing('agent_teams', 'template_version', 'INTEGER');
    this.addColumnIfMissing('agent_teams', 'template_digest', 'TEXT');
    this.addColumnIfMissing('agent_teams', 'scope_type', "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing('agent_teams', 'scope_key', 'TEXT');
    this.addColumnIfMissing('agent_teams', 'instance_id', 'TEXT');
    this.addColumnIfMissing('agent_teams', 'pm_bot', 'TEXT');
    this.addColumnIfMissing('agent_teams', 'quotas', "TEXT NOT NULL DEFAULT '{}'");
    this.addColumnIfMissing('agent_teams', 'rule_set_refs', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('agent_team_agents', 'instance_id', 'TEXT');
    this.addColumnIfMissing('agent_team_agents', 'model', 'TEXT');
    this.addColumnIfMissing('agent_team_agents', 'reasoning_effort', 'TEXT');
    this.addColumnIfMissing('agent_team_agents', 'approval_policy', 'TEXT');
    this.addColumnIfMissing('agent_team_agents', 'sandbox', 'TEXT');
    this.addColumnIfMissing('agent_team_agents', 'timeout_ms', 'INTEGER');
    this.addColumnIfMissing('agent_team_agents', 'idle_timeout_ms', 'INTEGER');
    this.addColumnIfMissing('agent_team_agents', 'allowed_tools', 'TEXT');
    this.addColumnIfMissing('agent_team_agents', 'kind', "TEXT NOT NULL DEFAULT 'custom'");
    this.addColumnIfMissing('agent_team_agents', 'created_by', 'TEXT');
    this.addColumnIfMissing('agent_team_agents', 'expires_at', 'INTEGER');
    this.addColumnIfMissing('agent_team_agents', 'last_active_at', 'INTEGER');
    this.addColumnIfMissing('agent_team_agents', 'promotion_status', "TEXT NOT NULL DEFAULT 'none'");
    this.addColumnIfMissing('agent_team_tasks', 'instance_id', 'TEXT');
    this.addColumnIfMissing('agent_team_messages', 'instance_id', 'TEXT');
    this.addColumnIfMissing('agent_team_runs', 'instance_id', 'TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_team_agents_instance
        ON agent_team_agents(instance_id, name);
      CREATE INDEX IF NOT EXISTS idx_agent_team_tasks_instance
        ON agent_team_tasks(instance_id, id);
      CREATE INDEX IF NOT EXISTS idx_agent_team_messages_instance_inbox
        ON agent_team_messages(instance_id, to_name, read_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_team_runs_instance
        ON agent_team_runs(instance_id, updated_at);
    `);
    this.backfillChildInstanceIds();
  }

  createTeam(name: string, description?: string, options?: {
    chatIds?: string[];
    displayChatIds?: string[];
    status?: TeamStatus;
    scopeType?: TeamInstanceScope;
    scopeKey?: string;
    instanceId?: string;
    pmBot?: string;
    quotas?: Partial<AgentTeamQuotas>;
    ruleSetRefs?: Array<TeamRuleSetRef | string>;
  }): AgentTeam {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_teams
        (name, description, status, chat_ids, display_chat_ids, managed_by_config,
         scope_type, scope_key, instance_id, pm_bot, quotas, rule_set_refs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      description ?? null,
      options?.status ?? 'active',
      JSON.stringify(normalizeStringArray(options?.chatIds)),
      JSON.stringify(normalizeStringArray(options?.displayChatIds)),
      options?.scopeType ?? 'legacy',
      options?.scopeKey ?? null,
      options?.instanceId ?? null,
      options?.pmBot ?? null,
      JSON.stringify(mergeQuotas(options?.quotas)),
      JSON.stringify(normalizeRuleSetRefs(options?.ruleSetRefs)),
      now,
      now,
    );
    return this.getTeam(name)!;
  }

  upsertTeam(input: AgentTeamConfig): AgentTeam {
    const existing = this.getTeam(input.name);
    const now = Date.now();
    const chatIds = normalizeStringArray(input.chatIds ?? existing?.chatIds);
    const displayChatIds = normalizeStringArray(input.displayChatIds ?? existing?.displayChatIds);
    const quotas = mergeQuotas(input.quotas ?? existing?.quotas);
    const ruleSetRefs = normalizeRuleSetRefs(input.ruleSetRefs ?? existing?.ruleSetRefs);
    const managedByConfig = input.managedByConfig ?? true;
    if (!existing) {
      this.db.prepare(`
        INSERT INTO agent_teams
          (name, description, status, chat_ids, display_chat_ids, managed_by_config,
           template_name, template_version, template_digest, scope_type, scope_key, instance_id, pm_bot, quotas, rule_set_refs,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.name,
        input.description ?? null,
        input.status ?? 'active',
        JSON.stringify(chatIds),
        JSON.stringify(displayChatIds),
        managedByConfig ? 1 : 0,
        input.templateName ?? null,
        input.templateVersion ?? null,
        input.templateDigest ?? null,
        input.scopeType ?? 'legacy',
        input.scopeKey ?? null,
        input.instanceId ?? null,
        input.pmBot ?? null,
        JSON.stringify(quotas),
        JSON.stringify(ruleSetRefs),
        now,
        now,
      );
    } else {
      this.db.prepare(`
        UPDATE agent_teams
        SET description = ?, status = ?, chat_ids = ?, display_chat_ids = ?, managed_by_config = ?,
            template_name = ?, template_version = ?, template_digest = ?, scope_type = ?, scope_key = ?,
            instance_id = ?, pm_bot = ?, quotas = ?, rule_set_refs = ?, updated_at = ?
        WHERE name = ?
      `).run(
        input.description ?? existing.description ?? null,
        input.status ?? existing.status,
        JSON.stringify(chatIds),
        JSON.stringify(displayChatIds),
        managedByConfig ? 1 : 0,
        input.templateName ?? existing.templateName ?? null,
        input.templateVersion ?? existing.templateVersion ?? null,
        input.templateDigest ?? existing.templateDigest ?? null,
        input.scopeType ?? existing.scopeType,
        input.scopeKey ?? existing.scopeKey ?? null,
        input.instanceId ?? existing.instanceId ?? null,
        input.pmBot ?? existing.pmBot ?? null,
        JSON.stringify(quotas),
        JSON.stringify(ruleSetRefs),
        now,
        input.name,
      );
    }
    this.syncChildInstanceIds(input.name);
    return this.getTeam(input.name)!;
  }

  reconcileTeams(configs: AgentTeamConfig[]): void {
    const names = new Set<string>();
    for (const config of configs) {
      if (!config.name) continue;
      names.add(config.name);
      const template = this.upsertTemplateFromConfig(config, 'bots.json');
      this.upsertTeam({
        ...config,
        templateName: template.name,
        templateVersion: template.version,
        templateDigest: template.digest,
        scopeType: config.scopeType ?? 'legacy',
        instanceId: config.instanceId ?? `legacy:${config.name}`,
      });
      for (const agent of config.agents ?? []) {
        this.upsertAgent(config.name, { ...agent, kind: agent.kind ?? 'template' });
      }
      for (const task of config.tasks ?? []) {
        this.upsertTask(config.name, task);
      }
    }
    for (const team of this.listTeams()) {
      if (!names.has(team.name)) {
        if (team.managedByConfig && team.status !== 'stopped') this.setTeamStatus(team.name, 'stopped');
        continue;
      }
      const desiredAgents = new Set((configs.find((cfg) => cfg.name === team.name)?.agents ?? []).map((agent) => agent.name));
      for (const agent of this.listAgents(team.name)) {
        if (desiredAgents.size > 0 && !desiredAgents.has(agent.name) && agent.status !== 'stopped') {
          this.setAgentStatus(team.name, agent.name, 'stopped');
        }
      }
    }
  }

  upsertTemplateFromConfig(input: AgentTeamConfig, source = 'runtime'): AgentTeamTemplateVersion {
    const body = normalizeTemplateConfig(input);
    const digest = hashObject(body);
    const existing = this.db.prepare('SELECT * FROM agent_team_templates WHERE name = ? AND digest = ?')
      .get(body.name, digest) as any;
    if (existing) return this.rowToTemplate(existing);
    const current = this.db.prepare('SELECT MAX(version) AS version FROM agent_team_templates WHERE name = ?')
      .get(body.name) as any;
    const version = Number(current?.version ?? 0) + 1;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_team_templates (name, version, digest, description, body_json, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.name,
      version,
      digest,
      body.description ?? null,
      JSON.stringify(body),
      source,
      now,
    );
    return this.getTemplateVersion(body.name, version)!;
  }

  listTemplates(name?: string): AgentTeamTemplateVersion[] {
    const rows = name
      ? this.db.prepare('SELECT * FROM agent_team_templates WHERE name = ? ORDER BY version DESC').all(name) as any[]
      : this.db.prepare('SELECT * FROM agent_team_templates ORDER BY name ASC, version DESC').all() as any[];
    return rows.map((row) => this.rowToTemplate(row));
  }

  getTemplateVersion(name: string, version?: number): AgentTeamTemplateVersion | undefined {
    const row = version == null
      ? this.db.prepare('SELECT * FROM agent_team_templates WHERE name = ? ORDER BY version DESC LIMIT 1').get(name) as any
      : this.db.prepare('SELECT * FROM agent_team_templates WHERE name = ? AND version = ?').get(name, version) as any;
    return row ? this.rowToTemplate(row) : undefined;
  }

  resolveTeamInstance(input: ResolveTeamInstanceInput): AgentTeam | undefined {
    const scopeType = input.scopeType ?? 'chat';
    if (scopeType === 'global' && !input.allowGlobal) {
      throw Object.assign(new Error('Global Agent Team instances must be requested explicitly with allowGlobal=true'), { statusCode: 400 });
    }
    const scopeKey = resolveScopeKey(scopeType, input);
    const existing = this.findTeamInstance(input.templateName, scopeType, scopeKey);
    if (existing || input.createIfMissing === false) return existing;

    const template = this.getTemplateVersion(input.templateName, input.templateVersion);
    if (!template) {
      throw Object.assign(new Error(`Agent Team template not found: ${input.templateName}`), { statusCode: 404 });
    }
    const quotas = mergeQuotas({ ...(template.body.quotas ?? {}), ...(input.quotas ?? {}) });
    this.requireScopeTeamQuota(scopeType, scopeKey, quotas.maxTeamsPerScope);
    const templateRuleSetRefs = this.pinRuleSetRefs(template.body.ruleSetRefs);
    const requestedRuleSetRefs = this.pinRuleSetRefs(input.ruleSetRefs);
    const ruleSetRefs = uniqueRuleSetRefs([...templateRuleSetRefs, ...requestedRuleSetRefs]);
    const instanceId = `ati_${hashText(`${template.name}:${template.version}:${scopeType}:${scopeKey}`).slice(0, 16)}`;
    const teamName = `${template.name}@${scopeType}:${safeKey(scopeKey)}`;
    const displayChatIds = scopeType === 'chat' && input.chatId ? [input.chatId] : [];
    const team = this.upsertTeam({
      ...template.body,
      name: teamName,
      description: template.body.description ?? template.description,
      status: 'active',
      chatIds: [],
      displayChatIds,
      managedByConfig: false,
      templateName: template.name,
      templateVersion: template.version,
      templateDigest: template.digest,
      scopeType,
      scopeKey,
      instanceId,
      pmBot: input.pmBot,
      quotas,
      ruleSetRefs,
    } as AgentTeamConfig);
    for (const agent of template.body.agents ?? []) {
      this.upsertAgent(team.name, { ...agent, kind: 'template', createdBy: input.pmBot ?? 'template' });
    }
    for (const task of template.body.tasks ?? []) {
      this.upsertTask(team.name, task);
    }
    return this.getTeam(team.name);
  }

  updateTeamConfig(name: string, input: {
    chatIds?: string[];
    displayChatIds?: string[];
    pmBot?: string;
    quotas?: Partial<AgentTeamQuotas>;
    ruleSetRefs?: Array<TeamRuleSetRef | string>;
  }): AgentTeam | undefined {
    if (!this.getTeam(name)) return undefined;
    const pinnedRuleSetRefs = input.ruleSetRefs === undefined
      ? undefined
      : this.pinRuleSetRefs(input.ruleSetRefs);
    return this.upsertTeam({
      name,
      ...(input.chatIds !== undefined ? { chatIds: input.chatIds } : {}),
      ...(input.displayChatIds !== undefined ? { displayChatIds: input.displayChatIds } : {}),
      ...(input.pmBot !== undefined ? { pmBot: input.pmBot } : {}),
      ...(input.quotas !== undefined ? { quotas: input.quotas } : {}),
      ...(pinnedRuleSetRefs !== undefined ? { ruleSetRefs: pinnedRuleSetRefs } : {}),
    });
  }

  findTeamInstance(templateName: string, scopeType: TeamInstanceScope, scopeKey: string): AgentTeam | undefined {
    const row = this.db.prepare(`
      SELECT * FROM agent_teams
      WHERE template_name = ? AND scope_type = ? AND scope_key = ? AND status != 'stopped'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(templateName, scopeType, scopeKey) as any;
    return row ? this.rowToTeam(row) : undefined;
  }

  listTeamInstances(templateName?: string): AgentTeam[] {
    const rows = templateName
      ? this.db.prepare(`
        SELECT * FROM agent_teams
        WHERE template_name = ? AND instance_id IS NOT NULL
        ORDER BY updated_at DESC
      `).all(templateName) as any[]
      : this.db.prepare(`
        SELECT * FROM agent_teams
        WHERE instance_id IS NOT NULL
        ORDER BY updated_at DESC
      `).all() as any[];
    return rows.map((row) => this.rowToTeam(row));
  }

  upsertRuleSet(input: {
    name: string;
    scope: TeamRuleScope;
    rules: TeamRule[];
    source?: string;
  }): TeamRuleSetVersion {
    const name = input.name.trim();
    if (!name) throw Object.assign(new Error('RuleSet name is required'), { statusCode: 400 });
    const rules = normalizeRules(input.rules);
    const digest = hashObject({ name, scope: input.scope, rules });
    const existing = this.db.prepare('SELECT * FROM agent_team_rule_sets WHERE name = ? AND digest = ?')
      .get(name, digest) as any;
    if (existing) return this.rowToRuleSet(existing);
    const current = this.db.prepare('SELECT MAX(version) AS version FROM agent_team_rule_sets WHERE name = ?')
      .get(name) as any;
    const version = Number(current?.version ?? 0) + 1;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_team_rule_sets (name, version, digest, scope, rules_json, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, version, digest, input.scope, JSON.stringify(rules), input.source ?? null, now);
    return this.getRuleSet(name, version)!;
  }

  listRuleSets(name?: string): TeamRuleSetVersion[] {
    const rows = name
      ? this.db.prepare('SELECT * FROM agent_team_rule_sets WHERE name = ? ORDER BY version DESC').all(name) as any[]
      : this.db.prepare('SELECT * FROM agent_team_rule_sets ORDER BY name ASC, version DESC').all() as any[];
    return rows.map((row) => this.rowToRuleSet(row));
  }

  getRuleSet(name: string, version?: number): TeamRuleSetVersion | undefined {
    const row = version == null
      ? this.db.prepare('SELECT * FROM agent_team_rule_sets WHERE name = ? ORDER BY version DESC LIMIT 1').get(name) as any
      : this.db.prepare('SELECT * FROM agent_team_rule_sets WHERE name = ? AND version = ?').get(name, version) as any;
    return row ? this.rowToRuleSet(row) : undefined;
  }

  exportRuleSet(name: string, version?: number): TeamRuleSetVersion | undefined {
    return this.getRuleSet(name, version);
  }

  diffRuleSetVersions(name: string, fromVersion: number, toVersion?: number): {
    name: string;
    from?: Pick<TeamRuleSetVersion, 'version' | 'digest' | 'createdAt' | 'scope'>;
    to?: Pick<TeamRuleSetVersion, 'version' | 'digest' | 'createdAt' | 'scope'>;
    changed: boolean;
    summary: {
      addedRules: string[];
      removedRules: string[];
      changedRules: string[];
      scopeChanged: boolean;
    };
  } {
    const from = this.getRuleSet(name, fromVersion);
    const to = this.getRuleSet(name, toVersion);
    const fromRules = new Map((from?.rules ?? []).map((rule, index) => [rule.id ?? `${index + 1}:${rule.text}`, hashObject(rule)]));
    const toRules = new Map((to?.rules ?? []).map((rule, index) => [rule.id ?? `${index + 1}:${rule.text}`, hashObject(rule)]));
    const addedRules = [...toRules.keys()].filter((key) => !fromRules.has(key)).sort();
    const removedRules = [...fromRules.keys()].filter((key) => !toRules.has(key)).sort();
    const changedRules = [...toRules.keys()].filter((key) => fromRules.has(key) && fromRules.get(key) !== toRules.get(key)).sort();
    return {
      name,
      ...(from ? { from: { version: from.version, digest: from.digest, createdAt: from.createdAt, scope: from.scope } } : {}),
      ...(to ? { to: { version: to.version, digest: to.digest, createdAt: to.createdAt, scope: to.scope } } : {}),
      changed: from?.digest !== to?.digest,
      summary: {
        addedRules,
        removedRules,
        changedRules,
        scopeChanged: from?.scope !== to?.scope,
      },
    };
  }

  createPromotionProposal(input: {
    kind: TeamPromotionProposalKind;
    body: TeamPromotionProposalBody;
    summary?: string;
    requestedBy?: string;
    requestedByRole?: TeamActorRole;
  }): TeamPromotionProposal {
    const requestedByRole = input.requestedByRole ?? 'agent';
    if (!canCreatePromotionProposal(requestedByRole)) {
      throw Object.assign(new Error(`${requestedByRole} is not allowed to create promotion proposals`), { statusCode: 403 });
    }
    const body = normalizePromotionProposalBody(input.kind, input.body);
    const targetName = body.name;
    const now = Date.now();
    const id = `proposal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO agent_team_promotion_proposals
        (id, kind, target_name, summary, body_json, status, requested_by, requested_by_role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      id,
      input.kind,
      targetName,
      input.summary ?? null,
      JSON.stringify(body),
      input.requestedBy ?? null,
      requestedByRole,
      now,
      now,
    );
    return this.getPromotionProposal(id)!;
  }

  listPromotionProposals(status?: TeamPromotionProposalStatus): TeamPromotionProposal[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM agent_team_promotion_proposals WHERE status = ? ORDER BY updated_at DESC').all(status) as any[]
      : this.db.prepare('SELECT * FROM agent_team_promotion_proposals ORDER BY updated_at DESC').all() as any[];
    return rows.map((row) => this.rowToPromotionProposal(row));
  }

  getPromotionProposal(id: string): TeamPromotionProposal | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_promotion_proposals WHERE id = ?').get(id) as any;
    return row ? this.rowToPromotionProposal(row) : undefined;
  }

  decidePromotionProposal(id: string, input: {
    decision: Exclude<TeamPromotionProposalStatus, 'pending'>;
    actorRole?: TeamActorRole;
    decidedBy?: string;
    reason?: string;
  }): TeamPromotionProposal {
    this.requireCapability(input.actorRole ?? 'pm', 'promote_template');
    const proposal = this.getPromotionProposal(id);
    if (!proposal) throw Object.assign(new Error(`Agent Team promotion proposal not found: ${id}`), { statusCode: 404 });
    if (proposal.status !== 'pending') {
      throw Object.assign(new Error(`Agent Team promotion proposal is already ${proposal.status}: ${id}`), { statusCode: 409 });
    }
    let appliedVersion: number | undefined;
    let appliedDigest: string | undefined;
    if (input.decision === 'approved') {
      if (proposal.kind === 'template') {
        const applied = this.upsertTemplateFromConfig(proposal.body as AgentTeamConfig, `proposal:${id}`);
        appliedVersion = applied.version;
        appliedDigest = applied.digest;
      } else {
        const body = proposal.body as TeamRuleSetConfig;
        const applied = this.upsertRuleSet({
          name: body.name,
          scope: body.scope,
          rules: body.rules,
          source: `proposal:${id}`,
        });
        appliedVersion = applied.version;
        appliedDigest = applied.digest;
      }
    }
    const now = Date.now();
    this.db.prepare(`
      UPDATE agent_team_promotion_proposals
      SET status = ?, decided_by = ?, decision_reason = ?, applied_version = ?,
          applied_digest = ?, updated_at = ?, decided_at = ?
      WHERE id = ?
    `).run(
      input.decision,
      input.decidedBy ?? null,
      input.reason ?? null,
      appliedVersion ?? null,
      appliedDigest ?? null,
      now,
      now,
      id,
    );
    return this.getPromotionProposal(id)!;
  }

  exportTemplate(name: string, version?: number): AgentTeamTemplateVersion | undefined {
    return this.getTemplateVersion(name, version);
  }

  diffTemplateVersions(name: string, fromVersion: number, toVersion?: number): {
    name: string;
    from?: Pick<AgentTeamTemplateVersion, 'version' | 'digest' | 'createdAt'>;
    to?: Pick<AgentTeamTemplateVersion, 'version' | 'digest' | 'createdAt'>;
    changed: boolean;
    summary: {
      addedAgents: string[];
      removedAgents: string[];
      changedAgents: string[];
      addedTasks: number[];
      removedTasks: number[];
      changedTasks: number[];
      ruleSetRefsChanged: boolean;
      descriptionChanged: boolean;
      quotasChanged: boolean;
    };
  } {
    const from = this.getTemplateVersion(name, fromVersion);
    const to = this.getTemplateVersion(name, toVersion);
    const fromAgents = new Map((from?.body.agents ?? []).map((agent) => [agent.name, hashObject(agent)]));
    const toAgents = new Map((to?.body.agents ?? []).map((agent) => [agent.name, hashObject(agent)]));
    const fromTasks = new Map((from?.body.tasks ?? []).map((task, index) => [task.id ?? index + 1, hashObject(task)]));
    const toTasks = new Map((to?.body.tasks ?? []).map((task, index) => [task.id ?? index + 1, hashObject(task)]));
    const addedAgents = [...toAgents.keys()].filter((key) => !fromAgents.has(key)).sort();
    const removedAgents = [...fromAgents.keys()].filter((key) => !toAgents.has(key)).sort();
    const changedAgents = [...toAgents.keys()].filter((key) => fromAgents.has(key) && fromAgents.get(key) !== toAgents.get(key)).sort();
    const addedTasks = [...toTasks.keys()].filter((key) => !fromTasks.has(key)).sort((a, b) => a - b);
    const removedTasks = [...fromTasks.keys()].filter((key) => !toTasks.has(key)).sort((a, b) => a - b);
    const changedTasks = [...toTasks.keys()].filter((key) => fromTasks.has(key) && fromTasks.get(key) !== toTasks.get(key)).sort((a, b) => a - b);
    const summary = {
      addedAgents,
      removedAgents,
      changedAgents,
      addedTasks,
      removedTasks,
      changedTasks,
      ruleSetRefsChanged: hashObject(normalizeRuleSetRefs(from?.body.ruleSetRefs)) !== hashObject(normalizeRuleSetRefs(to?.body.ruleSetRefs)),
      descriptionChanged: (from?.body.description ?? '') !== (to?.body.description ?? ''),
      quotasChanged: hashObject(from?.body.quotas ?? {}) !== hashObject(to?.body.quotas ?? {}),
    };
    return {
      name,
      ...(from ? { from: { version: from.version, digest: from.digest, createdAt: from.createdAt } } : {}),
      ...(to ? { to: { version: to.version, digest: to.digest, createdAt: to.createdAt } } : {}),
      changed: from?.digest !== to?.digest,
      summary,
    };
  }

  buildRulesContextPack(input: {
    refs: Array<{ name: string; version?: number }>;
    inlineRules?: TeamRule[];
  }): RulesContextPack {
    const sets = input.refs
      .map((ref) => this.getRuleSet(ref.name, ref.version))
      .filter((set): set is TeamRuleSetVersion => !!set)
      .sort((a, b) => ruleScopePriority(a.scope) - ruleScopePriority(b.scope));
    const inlineRules = normalizeRules(input.inlineRules ?? []);
    const lines: string[] = [];
    for (const set of sets) {
      lines.push(`## ${set.scope}:${set.name}@v${set.version}`);
      for (const rule of set.rules) {
        const locked = rule.overridable === false ? ' [locked]' : '';
        lines.push(`- ${rule.text}${locked}`);
      }
      lines.push('');
    }
    if (inlineRules.length > 0) {
      lines.push('## inline:task');
      for (const rule of inlineRules) lines.push(`- ${rule.text}`);
    }
    return {
      text: lines.join('\n').trim(),
      provenance: sets.map((set) => ({
        name: set.name,
        version: set.version,
        digest: set.digest,
        scope: set.scope,
        ruleCount: set.rules.length,
      })),
      inlineRules,
    };
  }

  buildRuntimeRulesContextPack(input: {
    purpose: RuntimeRulesPurpose;
    botName?: string;
    chatId?: string;
    teamName?: string;
    agentName?: string;
    agentRole?: string;
    workerLabel?: string;
    inlineRules?: TeamRule[];
  }): RulesContextPack {
    const refs: TeamRuleSetRef[] = [];
    refs.push(...this.latestRuleSetRefsForScope('global'));
    if (input.botName) {
      const botNames = new Set([input.botName, `bot:${input.botName}`]);
      refs.push(...this.latestRuleSetRefsForScope('bot').filter((ref) => botNames.has(ref.name)));
    }
    const team = input.teamName
      ? this.getTeam(input.teamName)
      : (input.chatId ? this.findTeamForChat(input.chatId) : undefined);
    if (team?.ruleSetRefs.length) refs.push(...team.ruleSetRefs);
    if (input.purpose === 'agent-run') {
      const agentRuleNames = ruleNameCandidates([
        input.agentName,
        input.agentName ? `agent:${input.agentName}` : undefined,
        input.agentRole,
        input.agentRole ? `role:${input.agentRole}` : undefined,
      ]);
      refs.push(...this.latestRuleSetRefsForScope('agent-role').filter((ref) => agentRuleNames.has(ref.name)));
    }
    if (input.purpose === 'worker-dispatch') {
      const workerRuleNames = ruleNameCandidates([
        'worker',
        input.botName ? `worker:${input.botName}` : undefined,
        input.workerLabel,
        input.workerLabel ? `worker:${input.workerLabel}` : undefined,
      ]);
      refs.push(...this.latestRuleSetRefsForScope('worker').filter((ref) => workerRuleNames.has(ref.name)));
      refs.push(...this.latestRuleSetRefsForScope('task').filter((ref) => workerRuleNames.has(ref.name)));
    }
    return this.buildRulesContextPack({
      refs: uniqueRuleSetRefs(refs),
      inlineRules: [
        ...runtimeDefaultRules(input.purpose),
        ...(input.inlineRules ?? []),
      ],
    });
  }

  pinRuleSetRefs(refs: Array<TeamRuleSetRef | string> | undefined): TeamRuleSetRef[] {
    return normalizeRuleSetRefs(refs).map((ref) => {
      if (ref.version != null) {
        if (!this.getRuleSet(ref.name, ref.version)) {
          throw Object.assign(new Error(`Agent Team RuleSet not found: ${ref.name}@v${ref.version}`), { statusCode: 404 });
        }
        return ref;
      }
      const current = this.getRuleSet(ref.name);
      if (!current) {
        throw Object.assign(new Error(`Agent Team RuleSet not found: ${ref.name}`), { statusCode: 404 });
      }
      return { name: ref.name, version: current.version };
    });
  }

  stopExpiredTemporaryAgents(now = Date.now()): TeamAgent[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_team_agents
      WHERE kind = 'temporary' AND status != 'stopped' AND expires_at IS NOT NULL AND expires_at <= ?
    `).all(now) as any[];
    if (rows.length === 0) return [];
    const agents = rows.map((row) => this.rowToAgent(row));
    const update = this.db.prepare(`
      UPDATE agent_team_agents
      SET status = 'stopped', updated_at = ?
      WHERE team_name = ? AND name = ? AND status != 'stopped'
    `);
    const tx = this.db.transaction((items: TeamAgent[]) => {
      for (const agent of items) update.run(now, agent.teamName, agent.name);
    });
    tx(agents);
    return agents;
  }

  listTeams(): AgentTeam[] {
    const rows = this.db.prepare('SELECT * FROM agent_teams ORDER BY updated_at DESC').all() as any[];
    return rows.map((row) => this.rowToTeam(row));
  }

  getTeam(name: string): AgentTeam | undefined {
    const row = this.db.prepare('SELECT * FROM agent_teams WHERE name = ?').get(name) as any;
    return row ? this.rowToTeam(row) : undefined;
  }

  getTeamByInstanceId(instanceId: string): AgentTeam | undefined {
    const row = this.db.prepare(`
      SELECT * FROM agent_teams
      WHERE instance_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(instanceId) as any;
    return row ? this.rowToTeam(row) : undefined;
  }

  resolveTeamIdentifier(identifier: string): AgentTeam | undefined {
    return this.getTeam(identifier) ?? this.getTeamByInstanceId(identifier);
  }

  resolveTeamName(identifier: string): string | undefined {
    return this.resolveTeamIdentifier(identifier)?.name;
  }

  deleteTeam(name: string): boolean {
    return this.db.prepare('DELETE FROM agent_teams WHERE name = ?').run(name).changes > 0;
  }

  deleteAgent(teamName: string, name: string): boolean {
    return this.db.prepare('DELETE FROM agent_team_agents WHERE team_name = ? AND name = ?').run(teamName, name).changes > 0;
  }

  setTeamStatus(name: string, status: TeamStatus): AgentTeam | undefined {
    const now = Date.now();
    this.db.prepare('UPDATE agent_teams SET status = ?, updated_at = ? WHERE name = ?').run(status, now, name);
    return this.getTeam(name);
  }

  setTeamChatBindings(name: string, input: {
    chatIds?: string[];
    displayChatIds?: string[];
  }): AgentTeam | undefined {
    const existing = this.getTeam(name);
    if (!existing) return undefined;
    const now = Date.now();
    this.db.prepare(`
      UPDATE agent_teams SET chat_ids = ?, display_chat_ids = ?, updated_at = ?
      WHERE name = ?
    `).run(
      JSON.stringify(input.chatIds === undefined ? existing.chatIds : normalizeStringArray(input.chatIds)),
      JSON.stringify(input.displayChatIds === undefined ? existing.displayChatIds : normalizeStringArray(input.displayChatIds)),
      now,
      name,
    );
    return this.getTeam(name);
  }

  createAgent(teamName: string, input: {
    name: string;
    role?: string;
    engine?: EngineName;
    model?: string;
    reasoningEffort?: TeamAgentReasoningEffort;
    approvalPolicy?: TeamAgentApprovalPolicy;
    sandbox?: TeamAgentSandbox;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    allowedTools?: string[];
    prompt?: string;
    sessionId?: string;
    kind?: TeamAgentKind;
    createdBy?: string;
    actorRole?: TeamActorRole;
    ttlMs?: number;
    expiresAt?: number;
    promotionStatus?: TeamAgentPromotionStatus;
  }): TeamAgent {
    this.requireTeam(teamName);
    this.requireCapability(input.actorRole ?? 'pm', 'create_agent');
    this.requireAgentQuota(teamName, input.kind ?? 'custom');
    const now = Date.now();
    const instanceId = this.instanceIdForTeam(teamName);
    const expiresAt = input.expiresAt ?? (input.ttlMs && input.ttlMs > 0 ? now + input.ttlMs : undefined);
    this.db.prepare(`
      INSERT INTO agent_team_agents
        (team_name, instance_id, name, role, engine, model, reasoning_effort, approval_policy, sandbox,
         timeout_ms, idle_timeout_ms, allowed_tools, prompt, status, session_id,
         kind, created_by, expires_at, last_active_at, promotion_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      teamName,
      instanceId ?? null,
      input.name,
      input.role ?? null,
      input.engine ?? null,
      input.model ?? null,
      input.reasoningEffort ?? null,
      input.approvalPolicy ?? null,
      input.sandbox ?? null,
      input.timeoutMs ?? null,
      input.idleTimeoutMs ?? null,
      input.allowedTools ? JSON.stringify(normalizeStringArray(input.allowedTools)) : null,
      input.prompt ?? null,
      input.sessionId ?? null,
      input.kind ?? 'custom',
      input.createdBy ?? null,
      expiresAt ?? null,
      now,
      input.promotionStatus ?? 'none',
      now,
      now,
    );
    return {
      teamName,
      ...(instanceId ? { instanceId } : {}),
      name: input.name,
      ...(input.role ? { role: input.role } : {}),
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.idleTimeoutMs ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
      ...(input.allowedTools ? { allowedTools: normalizeStringArray(input.allowedTools) } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      status: 'idle',
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      kind: input.kind ?? 'custom',
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      lastActiveAt: now,
      promotionStatus: input.promotionStatus ?? 'none',
      createdAt: now,
      updatedAt: now,
    };
  }

  upsertAgent(teamName: string, input: {
    name: string;
    role?: string;
    engine?: EngineName;
    model?: string;
    reasoningEffort?: TeamAgentReasoningEffort;
    approvalPolicy?: TeamAgentApprovalPolicy;
    sandbox?: TeamAgentSandbox;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    allowedTools?: string[];
    prompt?: string;
    sessionId?: string;
    status?: AgentStatus;
    kind?: TeamAgentKind;
    createdBy?: string;
    ttlMs?: number;
    expiresAt?: number;
    promotionStatus?: TeamAgentPromotionStatus;
  }): TeamAgent {
    this.requireTeam(teamName);
    const existing = this.getAgent(teamName, input.name);
    const now = Date.now();
    const instanceId = this.instanceIdForTeam(teamName);
    const expiresAt = input.expiresAt ?? (input.ttlMs && input.ttlMs > 0 ? now + input.ttlMs : undefined);
    if (!existing) {
      this.requireAgentQuota(teamName, input.kind ?? 'custom');
      this.db.prepare(`
        INSERT INTO agent_team_agents
          (team_name, instance_id, name, role, engine, model, reasoning_effort, approval_policy, sandbox,
           timeout_ms, idle_timeout_ms, allowed_tools, prompt, status, session_id,
           kind, created_by, expires_at, last_active_at, promotion_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        teamName,
        instanceId ?? null,
        input.name,
        input.role ?? null,
        input.engine ?? null,
        input.model ?? null,
        input.reasoningEffort ?? null,
        input.approvalPolicy ?? null,
        input.sandbox ?? null,
        input.timeoutMs ?? null,
        input.idleTimeoutMs ?? null,
        input.allowedTools ? JSON.stringify(normalizeStringArray(input.allowedTools)) : null,
        input.prompt ?? null,
        input.status ?? 'idle',
        input.sessionId ?? null,
        input.kind ?? 'custom',
        input.createdBy ?? null,
        expiresAt ?? null,
        now,
        input.promotionStatus ?? 'none',
        now,
        now,
      );
    } else {
      this.db.prepare(`
        UPDATE agent_team_agents
        SET instance_id = ?, role = ?, engine = ?, model = ?, reasoning_effort = ?, approval_policy = ?, sandbox = ?,
            timeout_ms = ?, idle_timeout_ms = ?, allowed_tools = ?, prompt = ?, status = ?, session_id = ?,
            kind = ?, created_by = ?, expires_at = ?, last_active_at = ?, promotion_status = ?,
            updated_at = ?
        WHERE team_name = ? AND name = ?
      `).run(
        instanceId ?? existing.instanceId ?? null,
        input.role ?? existing.role ?? null,
        input.engine ?? existing.engine ?? null,
        input.model ?? existing.model ?? null,
        input.reasoningEffort ?? existing.reasoningEffort ?? null,
        input.approvalPolicy ?? existing.approvalPolicy ?? null,
        input.sandbox ?? existing.sandbox ?? null,
        input.timeoutMs ?? existing.timeoutMs ?? null,
        input.idleTimeoutMs ?? existing.idleTimeoutMs ?? null,
        input.allowedTools ? JSON.stringify(normalizeStringArray(input.allowedTools)) : JSON.stringify(existing.allowedTools ?? []),
        input.prompt ?? existing.prompt ?? null,
        input.status ?? (existing.status === 'stopped' ? 'idle' : existing.status),
        input.sessionId ?? existing.sessionId ?? null,
        input.kind ?? existing.kind,
        input.createdBy ?? existing.createdBy ?? null,
        expiresAt ?? existing.expiresAt ?? null,
        now,
        input.promotionStatus ?? existing.promotionStatus,
        now,
        teamName,
        input.name,
      );
    }
    return this.getAgent(teamName, input.name)!;
  }

  listAgents(teamName: string): TeamAgent[] {
    this.requireTeam(teamName);
    const rows = this.db.prepare('SELECT * FROM agent_team_agents WHERE team_name = ? ORDER BY created_at ASC').all(teamName) as any[];
    return rows.map((row) => this.rowToAgent(row));
  }

  getAgent(teamName: string, name: string): TeamAgent | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_agents WHERE team_name = ? AND name = ?').get(teamName, name) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  setAgentStatus(teamName: string, name: string, status: AgentStatus): TeamAgent | undefined {
    const now = Date.now();
    this.db.prepare('UPDATE agent_team_agents SET status = ?, updated_at = ? WHERE team_name = ? AND name = ?')
      .run(status, now, teamName, name);
    const row = this.db.prepare('SELECT * FROM agent_team_agents WHERE team_name = ? AND name = ?').get(teamName, name) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  setAgentSessionId(teamName: string, name: string, sessionId: string | undefined, engine?: EngineName): TeamAgent | undefined {
    const existing = this.getAgent(teamName, name);
    if (!existing) return undefined;
    const now = Date.now();
    const instanceId = this.instanceIdForTeam(teamName);
    this.db.prepare(`
      UPDATE agent_team_agents
      SET session_id = ?, engine = ?, instance_id = ?, updated_at = ?
      WHERE team_name = ? AND name = ?
    `).run(sessionId ?? null, engine ?? existing.engine ?? null, instanceId ?? existing.instanceId ?? null, now, teamName, name);
    return this.getAgent(teamName, name);
  }

  createTask(teamName: string, input: {
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: number[];
  }): TeamTask {
    this.requireTeam(teamName);
    this.requireQueuedTaskQuota(teamName);
    const nextId = ((this.db.prepare('SELECT MAX(id) AS max_id FROM agent_team_tasks WHERE team_name = ?').get(teamName) as any)?.max_id ?? 0) + 1;
    const now = Date.now();
    const instanceId = this.instanceIdForTeam(teamName);
    this.db.prepare(`
      INSERT INTO agent_team_tasks
        (team_name, instance_id, id, subject, description, status, owner, blocked_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      teamName,
      instanceId ?? null,
      nextId,
      input.subject,
      input.description ?? null,
      input.owner ?? null,
      JSON.stringify(input.blockedBy ?? []),
      now,
      now,
    );
    return this.getTask(teamName, nextId)!;
  }

  upsertTask(teamName: string, input: {
    id?: number;
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: number[];
    status?: TaskStatus;
    result?: string;
  }): TeamTask {
    if (input.id != null) {
      const existing = this.getTask(teamName, input.id);
      if (existing) {
        return this.updateTask(teamName, input.id, {
          subject: input.subject,
          description: input.description,
          status: input.status ?? existing.status,
          owner: input.owner,
          blockedBy: input.blockedBy,
          result: input.result,
        })!;
      }
      const now = Date.now();
      this.requireTeam(teamName);
      if (isQueuedTaskStatus(input.status ?? 'pending')) this.requireQueuedTaskQuota(teamName);
      const instanceId = this.instanceIdForTeam(teamName);
      this.db.prepare(`
        INSERT INTO agent_team_tasks
          (team_name, instance_id, id, subject, description, status, owner, blocked_by, result, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        teamName,
        instanceId ?? null,
        input.id,
        input.subject,
        input.description ?? null,
        input.status ?? 'pending',
        input.owner ?? null,
        JSON.stringify(input.blockedBy ?? []),
        input.result ?? null,
        now,
        now,
      );
      return this.getTask(teamName, input.id)!;
    }
    return this.createTask(teamName, {
      subject: input.subject,
      description: input.description,
      owner: input.owner,
      blockedBy: input.blockedBy,
    });
  }

  findTeamForChat(chatId: string): AgentTeam | undefined {
    const teams = this.listTeams().filter((team) => team.status === 'active');
    const preferScoped = (candidates: AgentTeam[]): AgentTeam | undefined =>
      candidates.find((team) => team.scopeType === 'chat' && team.scopeKey === chatId)
      ?? candidates.find((team) => team.scopeType !== 'legacy')
      ?? candidates[0];
    return preferScoped(teams.filter((team) => team.displayChatIds.includes(chatId)))
      ?? preferScoped(teams.filter((team) => team.chatIds.includes(chatId)));
  }

  listTasks(teamName: string): TeamTask[] {
    this.requireTeam(teamName);
    const rows = this.db.prepare('SELECT * FROM agent_team_tasks WHERE team_name = ? AND status != ? ORDER BY id ASC')
      .all(teamName, 'deleted') as any[];
    return rows.map((row) => this.rowToTask(row));
  }

  getTask(teamName: string, id: number): TeamTask | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_tasks WHERE team_name = ? AND id = ?').get(teamName, id) as any;
    return row ? this.rowToTask(row) : undefined;
  }

  updateTask(teamName: string, id: number, input: {
    subject?: string;
    description?: string;
    status?: TaskStatus;
    owner?: string | null;
    blockedBy?: number[];
    result?: string;
  }): TeamTask | undefined {
    const existing = this.getTask(teamName, id);
    if (!existing) return undefined;
    const now = Date.now();
    const nextStatus = input.status ?? existing.status;
    if (!isQueuedTaskStatus(existing.status) && isQueuedTaskStatus(nextStatus)) {
      this.requireQueuedTaskQuota(teamName);
    }
    const instanceId = this.instanceIdForTeam(teamName);
    this.db.prepare(`
      UPDATE agent_team_tasks
      SET instance_id = ?, subject = ?, description = ?, status = ?, owner = ?, blocked_by = ?, result = ?, updated_at = ?
      WHERE team_name = ? AND id = ?
    `).run(
      instanceId ?? existing.instanceId ?? null,
      input.subject ?? existing.subject,
      input.description ?? existing.description ?? null,
      nextStatus,
      input.owner === undefined ? existing.owner ?? null : input.owner,
      JSON.stringify(input.blockedBy ?? existing.blockedBy),
      input.result ?? existing.result ?? null,
      now,
      teamName,
      id,
    );
    return this.getTask(teamName, id);
  }

  sendMessage(teamName: string, input: {
    toName: string;
    body: string;
    fromName?: string;
    summary?: string;
  }): TeamMessage {
    this.requireTeam(teamName);
    const now = Date.now();
    const instanceId = this.instanceIdForTeam(teamName);
    const result = this.db.prepare(`
      INSERT INTO agent_team_messages (team_name, instance_id, from_name, to_name, summary, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(teamName, instanceId ?? null, input.fromName ?? null, input.toName, input.summary ?? null, input.body, now);
    return this.getMessage(Number(result.lastInsertRowid))!;
  }

  listMessages(teamName: string, toName?: string, unreadOnly = false): TeamMessage[] {
    this.requireTeam(teamName);
    const clauses = ['team_name = ?'];
    const args: unknown[] = [teamName];
    if (toName) {
      clauses.push('to_name = ?');
      args.push(toName);
    }
    if (unreadOnly) clauses.push('read_at IS NULL');
    const rows = this.db.prepare(`
      SELECT * FROM agent_team_messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC
    `).all(...args) as any[];
    return rows.map((row) => this.rowToMessage(row));
  }

  markMessagesRead(teamName: string, toName: string): number {
    const result = this.db.prepare(`
      UPDATE agent_team_messages SET read_at = ?
      WHERE team_name = ? AND to_name = ? AND read_at IS NULL
    `).run(Date.now(), teamName, toName);
    return result.changes;
  }

  markMessagesReadById(teamName: string, toName: string, ids: number[]): number {
    this.requireTeam(teamName);
    const messageIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => '?').join(', ');
    const result = this.db.prepare(`
      UPDATE agent_team_messages SET read_at = ?
      WHERE team_name = ? AND to_name = ? AND read_at IS NULL AND id IN (${placeholders})
    `).run(Date.now(), teamName, toName, ...messageIds);
    return result.changes;
  }

  createRun(teamName: string, input: {
    id?: string;
    agentName?: string;
    taskId?: number;
    status?: RunStatus;
    output?: string;
    error?: string;
  }): TeamRun {
    this.requireTeam(teamName);
    if ((input.status ?? 'running') === 'running') {
      this.requireActiveRunQuota(teamName);
      if (input.agentName) this.requireParallelRunQuota(teamName, input.agentName);
    }
    const now = Date.now();
    const id = input.id || `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const instanceId = this.instanceIdForTeam(teamName);
    this.db.prepare(`
      INSERT INTO agent_team_runs (id, team_name, instance_id, agent_name, task_id, status, output, error, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      teamName,
      instanceId ?? null,
      input.agentName ?? null,
      input.taskId ?? null,
      input.status ?? 'running',
      input.output ?? null,
      input.error ?? null,
      now,
      now,
    );
    return this.getRun(teamName, id)!;
  }

  listRuns(teamName: string): TeamRun[] {
    this.requireTeam(teamName);
    const rows = this.db.prepare('SELECT * FROM agent_team_runs WHERE team_name = ? ORDER BY started_at DESC').all(teamName) as any[];
    return rows.map((row) => this.rowToRun(row));
  }

  getRunningRun(teamName: string, agentName: string): TeamRun | undefined {
    this.requireTeam(teamName);
    const row = this.db.prepare(`
      SELECT * FROM agent_team_runs
      WHERE team_name = ? AND agent_name = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(teamName, agentName) as any;
    return row ? this.rowToRun(row) : undefined;
  }

  getRun(teamName: string, id: string): TeamRun | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_runs WHERE team_name = ? AND id = ?').get(teamName, id) as any;
    return row ? this.rowToRun(row) : undefined;
  }

  updateRun(teamName: string, id: string, input: {
    status?: RunStatus;
    output?: string;
    error?: string;
  }): TeamRun | undefined {
    const existing = this.getRun(teamName, id);
    if (!existing) return undefined;
    const nextStatus = input.status ?? existing.status;
    if (existing.status !== 'running' && nextStatus === 'running') {
      this.requireActiveRunQuota(teamName);
      if (existing.agentName) this.requireParallelRunQuota(teamName, existing.agentName);
    }
    this.db.prepare(`
      UPDATE agent_team_runs SET instance_id = ?, status = ?, output = ?, error = ?, updated_at = ?
      WHERE team_name = ? AND id = ?
    `).run(
      this.instanceIdForTeam(teamName) ?? existing.instanceId ?? null,
      nextStatus,
      input.output ?? existing.output ?? null,
      input.error ?? existing.error ?? null,
      Date.now(),
      teamName,
      id,
    );
    return this.getRun(teamName, id);
  }

  appendRunOutput(teamName: string, id: string, output: string): TeamRun | undefined {
    const existing = this.getRun(teamName, id);
    if (!existing) return undefined;
    if (existing.status !== 'running') return existing;
    const nextOutput = mergeOutput(existing.output, output);
    return this.updateRun(teamName, id, { output: nextOutput });
  }

  status(teamName: string): {
    team: AgentTeam;
    agents: TeamAgent[];
    tasks: TeamTask[];
    unreadMessages: number;
    runs: TeamRun[];
  } | undefined {
    const team = this.getTeam(teamName);
    if (!team) return undefined;
    return {
      team,
      agents: this.listAgents(teamName),
      tasks: this.listTasks(teamName),
      unreadMessages: this.listMessages(teamName, undefined, true).length,
      runs: this.listRuns(teamName),
    };
  }

  close(): void {
    this.db.close();
  }

  private instanceIdForTeam(teamName: string): string | undefined {
    return this.getTeam(teamName)?.instanceId;
  }

  private syncChildInstanceIds(teamName: string): void {
    const instanceId = this.instanceIdForTeam(teamName);
    if (!instanceId) return;
    for (const table of ['agent_team_agents', 'agent_team_tasks', 'agent_team_messages', 'agent_team_runs']) {
      this.db.prepare(`
        UPDATE ${table}
        SET instance_id = ?
        WHERE team_name = ? AND (instance_id IS NULL OR instance_id != ?)
      `).run(instanceId, teamName, instanceId);
    }
  }

  private backfillChildInstanceIds(): void {
    for (const table of ['agent_team_agents', 'agent_team_tasks', 'agent_team_messages', 'agent_team_runs']) {
      this.db.prepare(`
        UPDATE ${table}
        SET instance_id = (
          SELECT instance_id FROM agent_teams WHERE agent_teams.name = ${table}.team_name
        )
        WHERE instance_id IS NULL
          AND EXISTS (
            SELECT 1 FROM agent_teams
            WHERE agent_teams.name = ${table}.team_name
              AND agent_teams.instance_id IS NOT NULL
          )
      `).run();
    }
  }

  private requireTeam(teamName: string): void {
    if (!this.getTeam(teamName)) {
      throw Object.assign(new Error(`Agent team not found: ${teamName}`), { statusCode: 404 });
    }
  }

  private requireCapability(actorRole: TeamActorRole, action: TeamCapabilityAction): void {
    if (hasTeamCapability(actorRole, action)) return;
    throw Object.assign(new Error(`${actorRole} is not allowed to ${action}`), { statusCode: 403 });
  }

  private requireAgentQuota(teamName: string, kind: TeamAgentKind): void {
    const team = this.getTeam(teamName);
    if (!team) return;
    const activeAgents = this.listAgents(teamName).filter((agent) => agent.status !== 'stopped');
    if (activeAgents.length >= team.quotas.maxAgents) {
      throw Object.assign(new Error(`Agent quota exceeded for ${teamName}: maxAgents=${team.quotas.maxAgents}`), { statusCode: 409 });
    }
    if (kind === 'temporary') {
      const temporaryAgents = activeAgents.filter((agent) => agent.kind === 'temporary');
      if (temporaryAgents.length >= team.quotas.maxTemporaryAgents) {
        throw Object.assign(new Error(`Temporary agent quota exceeded for ${teamName}: maxTemporaryAgents=${team.quotas.maxTemporaryAgents}`), { statusCode: 409 });
      }
    }
  }

  private requireScopeTeamQuota(scopeType: TeamInstanceScope, scopeKey: string, maxTeamsPerScope: number): void {
    if (scopeType === 'legacy') return;
    const activeCount = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_teams
      WHERE scope_type = ? AND scope_key = ? AND status != 'stopped'
    `).get(scopeType, scopeKey) as any)?.count ?? 0);
    if (activeCount >= maxTeamsPerScope) {
      throw Object.assign(
        new Error(`Agent Team scope quota exceeded for ${scopeType}:${scopeKey}: maxTeamsPerScope=${maxTeamsPerScope}`),
        { statusCode: 409 },
      );
    }
  }

  private requireQueuedTaskQuota(teamName: string): void {
    const team = this.getTeam(teamName);
    if (!team) return;
    const queuedCount = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_team_tasks
      WHERE team_name = ? AND status IN ('pending', 'in_progress')
    `).get(teamName) as any)?.count ?? 0);
    if (queuedCount >= team.quotas.maxQueuedTasks) {
      throw Object.assign(
        new Error(`Agent Team queue quota exceeded for ${teamName}: maxQueuedTasks=${team.quotas.maxQueuedTasks}`),
        { statusCode: 409 },
      );
    }
  }

  private requireActiveRunQuota(teamName: string): void {
    const team = this.getTeam(teamName);
    if (!team) return;
    const runningCount = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_team_runs
      WHERE team_name = ? AND status = 'running'
    `).get(teamName) as any)?.count ?? 0);
    if (runningCount >= team.quotas.maxActiveRuns) {
      throw Object.assign(
        new Error(`Agent Team active run quota exceeded for ${teamName}: maxActiveRuns=${team.quotas.maxActiveRuns}`),
        { statusCode: 409 },
      );
    }
  }

  private requireParallelRunQuota(teamName: string, agentName: string): void {
    const team = this.getTeam(teamName);
    if (!team) return;
    const runningCount = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_team_runs
      WHERE team_name = ? AND agent_name = ? AND status = 'running'
    `).get(teamName, agentName) as any)?.count ?? 0);
    if (runningCount >= team.quotas.maxParallelRunsPerAgent) {
      throw Object.assign(
        new Error(`Agent Team per-agent run quota exceeded for ${teamName}/${agentName}: maxParallelRunsPerAgent=${team.quotas.maxParallelRunsPerAgent}`),
        { statusCode: 409 },
      );
    }
  }

  private getMessage(id: number): TeamMessage | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_messages WHERE id = ?').get(id) as any;
    return row ? this.rowToMessage(row) : undefined;
  }

  private rowToTeam(row: any): AgentTeam {
    return {
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      status: row.status,
      chatIds: parseJsonStringArray(row.chat_ids),
      displayChatIds: parseJsonStringArray(row.display_chat_ids),
      managedByConfig: !!row.managed_by_config,
      ...(row.template_name ? { templateName: row.template_name } : {}),
      ...(Number.isFinite(row.template_version) ? { templateVersion: row.template_version } : {}),
      ...(row.template_digest ? { templateDigest: row.template_digest } : {}),
      scopeType: isTeamInstanceScope(row.scope_type) ? row.scope_type : 'legacy',
      ...(row.scope_key ? { scopeKey: row.scope_key } : {}),
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      ...(row.pm_bot ? { pmBot: row.pm_bot } : {}),
      quotas: mergeQuotas(parseJsonObject(row.quotas)),
      ruleSetRefs: normalizeRuleSetRefs(parseJsonArray(row.rule_set_refs)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTemplate(row: any): AgentTeamTemplateVersion {
    return {
      name: row.name,
      version: row.version,
      digest: row.digest,
      ...(row.description ? { description: row.description } : {}),
      body: parseJsonObject(row.body_json) as unknown as AgentTeamConfig,
      source: row.source,
      createdAt: row.created_at,
    };
  }

  private rowToRuleSet(row: any): TeamRuleSetVersion {
    return {
      name: row.name,
      version: row.version,
      digest: row.digest,
      scope: isTeamRuleScope(row.scope) ? row.scope : 'task',
      rules: normalizeRules(parseJsonArray(row.rules_json) as TeamRule[]),
      ...(row.source ? { source: row.source } : {}),
      createdAt: row.created_at,
    };
  }

  private rowToPromotionProposal(row: any): TeamPromotionProposal {
    return {
      id: row.id,
      kind: isTeamPromotionProposalKind(row.kind) ? row.kind : 'template',
      targetName: row.target_name,
      ...(row.summary ? { summary: row.summary } : {}),
      body: parseJsonObject(row.body_json) as unknown as TeamPromotionProposalBody,
      status: isTeamPromotionProposalStatus(row.status) ? row.status : 'pending',
      ...(row.requested_by ? { requestedBy: row.requested_by } : {}),
      requestedByRole: isTeamActorRole(row.requested_by_role) ? row.requested_by_role : 'agent',
      ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
      ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
      ...(Number.isFinite(row.applied_version) ? { appliedVersion: row.applied_version } : {}),
      ...(row.applied_digest ? { appliedDigest: row.applied_digest } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(Number.isFinite(row.decided_at) ? { decidedAt: row.decided_at } : {}),
    };
  }

  private rowToAgent(row: any): TeamAgent {
    return {
      teamName: row.team_name,
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      name: row.name,
      ...(row.role ? { role: row.role } : {}),
      ...(row.engine ? { engine: row.engine } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
      ...(row.approval_policy ? { approvalPolicy: row.approval_policy } : {}),
      ...(row.sandbox ? { sandbox: row.sandbox } : {}),
      ...(Number.isFinite(row.timeout_ms) ? { timeoutMs: row.timeout_ms } : {}),
      ...(Number.isFinite(row.idle_timeout_ms) ? { idleTimeoutMs: row.idle_timeout_ms } : {}),
      ...(parseJsonStringArray(row.allowed_tools).length > 0 ? { allowedTools: parseJsonStringArray(row.allowed_tools) } : {}),
      ...(row.prompt ? { prompt: row.prompt } : {}),
      status: row.status,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      kind: isTeamAgentKind(row.kind) ? row.kind : 'custom',
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      ...(Number.isFinite(row.expires_at) ? { expiresAt: row.expires_at } : {}),
      ...(Number.isFinite(row.last_active_at) ? { lastActiveAt: row.last_active_at } : {}),
      promotionStatus: isTeamAgentPromotionStatus(row.promotion_status) ? row.promotion_status : 'none',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTask(row: any): TeamTask {
    return {
      teamName: row.team_name,
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      id: row.id,
      subject: row.subject,
      ...(row.description ? { description: row.description } : {}),
      status: row.status,
      ...(row.owner ? { owner: row.owner } : {}),
      blockedBy: parseJsonNumberArray(row.blocked_by),
      ...(row.result ? { result: row.result } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToMessage(row: any): TeamMessage {
    return {
      id: row.id,
      teamName: row.team_name,
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      ...(row.from_name ? { fromName: row.from_name } : {}),
      toName: row.to_name,
      ...(row.summary ? { summary: row.summary } : {}),
      body: row.body,
      ...(row.read_at ? { readAt: row.read_at } : {}),
      createdAt: row.created_at,
    };
  }

  private rowToRun(row: any): TeamRun {
    return {
      id: row.id,
      teamName: row.team_name,
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      ...(row.agent_name ? { agentName: row.agent_name } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      status: row.status,
      ...(row.output ? { output: row.output } : {}),
      ...(row.error ? { error: row.error } : {}),
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    };
  }

  private addColumnIfMissing(table: string, name: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  private latestRuleSetRefsForScope(scope: TeamRuleScope): TeamRuleSetRef[] {
    const rows = this.db.prepare(`
      SELECT name, version FROM agent_team_rule_sets
      WHERE scope = ?
      ORDER BY name ASC, version DESC
    `).all(scope) as Array<{ name: string; version: number }>;
    const seen = new Set<string>();
    const refs: TeamRuleSetRef[] = [];
    for (const row of rows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      refs.push({ name: row.name, version: row.version });
    }
    return refs;
  }
}

function parseJsonNumberArray(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return normalizeStringArray(parsed);
  } catch {
    return [];
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())));
}

function isQueuedTaskStatus(status: TaskStatus): boolean {
  return status === 'pending' || status === 'in_progress';
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeQuotas(input?: Partial<AgentTeamQuotas> | Record<string, unknown>): AgentTeamQuotas {
  return {
    maxAgents: positiveInteger((input as Partial<AgentTeamQuotas> | undefined)?.maxAgents, DEFAULT_AGENT_TEAM_QUOTAS.maxAgents),
    maxTemporaryAgents: positiveInteger((input as Partial<AgentTeamQuotas> | undefined)?.maxTemporaryAgents, DEFAULT_AGENT_TEAM_QUOTAS.maxTemporaryAgents),
    maxParallelRunsPerAgent: positiveInteger((input as Partial<AgentTeamQuotas> | undefined)?.maxParallelRunsPerAgent, DEFAULT_AGENT_TEAM_QUOTAS.maxParallelRunsPerAgent),
    maxTeamsPerScope: positiveInteger((input as Partial<AgentTeamQuotas> | undefined)?.maxTeamsPerScope, DEFAULT_AGENT_TEAM_QUOTAS.maxTeamsPerScope),
    maxQueuedTasks: positiveInteger((input as Partial<AgentTeamQuotas> | undefined)?.maxQueuedTasks, DEFAULT_AGENT_TEAM_QUOTAS.maxQueuedTasks),
    maxActiveRuns: positiveInteger((input as Partial<AgentTeamQuotas> | undefined)?.maxActiveRuns, DEFAULT_AGENT_TEAM_QUOTAS.maxActiveRuns),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeTemplateConfig(input: AgentTeamConfig): AgentTeamConfig {
  return {
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
    status: input.status ?? 'active',
    ...(input.chatIds ? { chatIds: normalizeStringArray(input.chatIds) } : {}),
    ...(input.displayChatIds ? { displayChatIds: normalizeStringArray(input.displayChatIds) } : {}),
    ...(input.quotas ? { quotas: mergeQuotas(input.quotas) } : {}),
    ...(input.ruleSetRefs ? { ruleSetRefs: normalizeRuleSetRefs(input.ruleSetRefs) } : {}),
    agents: (input.agents ?? []).map((agent) => ({
      name: agent.name,
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.engine ? { engine: agent.engine } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
      ...(agent.approvalPolicy ? { approvalPolicy: agent.approvalPolicy } : {}),
      ...(agent.sandbox ? { sandbox: agent.sandbox } : {}),
      ...(agent.timeoutMs ? { timeoutMs: agent.timeoutMs } : {}),
      ...(agent.idleTimeoutMs ? { idleTimeoutMs: agent.idleTimeoutMs } : {}),
      ...(agent.allowedTools ? { allowedTools: normalizeStringArray(agent.allowedTools) } : {}),
      ...(agent.prompt ? { prompt: agent.prompt } : {}),
      kind: agent.kind ?? 'template',
      promotionStatus: agent.promotionStatus ?? 'none',
    })),
    tasks: (input.tasks ?? []).map((task) => ({
      ...(task.id != null ? { id: task.id } : {}),
      subject: task.subject,
      ...(task.description ? { description: task.description } : {}),
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.blockedBy ? { blockedBy: task.blockedBy } : {}),
      status: task.status ?? 'pending',
      ...(task.result ? { result: task.result } : {}),
    })),
  };
}

function normalizeRules(rules: TeamRule[]): TeamRule[] {
  return rules
    .filter((rule) => rule && typeof rule.text === 'string' && rule.text.trim())
    .map((rule) => ({
      ...(rule.id ? { id: rule.id.trim() } : {}),
      text: rule.text.trim(),
      ...(rule.target ? { target: rule.target.trim() } : {}),
      overridable: rule.overridable !== false,
    }));
}

function normalizePromotionProposalBody(kind: TeamPromotionProposalKind, body: TeamPromotionProposalBody): TeamPromotionProposalBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Promotion proposal body must be an object'), { statusCode: 400 });
  }
  if (kind === 'template') return normalizePromotionTemplateBody(body as AgentTeamConfig);
  return normalizeRuleSetConfig(body as TeamRuleSetConfig);
}

function normalizePromotionTemplateBody(input: AgentTeamConfig): AgentTeamConfig {
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw Object.assign(new Error('Promotion proposal template body requires name'), { statusCode: 400 });
  }
  return normalizeTemplateConfig(input);
}

function normalizeRuleSetConfig(input: TeamRuleSetConfig): TeamRuleSetConfig {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw Object.assign(new Error('Promotion proposal RuleSet body requires name'), { statusCode: 400 });
  if (!isTeamRuleScope(input.scope)) {
    throw Object.assign(new Error('Promotion proposal RuleSet body requires valid scope'), { statusCode: 400 });
  }
  const rules = normalizeRules(input.rules ?? []);
  if (rules.length === 0) {
    throw Object.assign(new Error('Promotion proposal RuleSet body requires at least one rule'), { statusCode: 400 });
  }
  return {
    name,
    scope: input.scope,
    rules,
    ...(input.source ? { source: input.source } : {}),
  };
}

function normalizeRuleSetRefs(refs: Array<TeamRuleSetRef | string> | unknown): TeamRuleSetRef[] {
  if (!Array.isArray(refs)) return [];
  const result = new Map<string, TeamRuleSetRef>();
  for (const ref of refs) {
    const parsed = typeof ref === 'string'
      ? parseRuleSetRefString(ref)
      : parseRuleSetRefObject(ref);
    if (!parsed) continue;
    result.set(`${parsed.name}@${parsed.version ?? 'latest'}`, parsed);
  }
  return [...result.values()].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return (a.version ?? Number.MAX_SAFE_INTEGER) - (b.version ?? Number.MAX_SAFE_INTEGER);
  });
}

function uniqueRuleSetRefs(refs: TeamRuleSetRef[]): TeamRuleSetRef[] {
  const result = new Map<string, TeamRuleSetRef>();
  for (const ref of refs) {
    result.set(`${ref.name}@${ref.version ?? 'latest'}`, ref);
  }
  return [...result.values()];
}

function ruleNameCandidates(values: Array<string | undefined>): Set<string> {
  return new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value));
}

function runtimeDefaultRules(purpose: RuntimeRulesPurpose): TeamRule[] {
  const rules: TeamRule[] = [
    {
      text: 'Authority boundary: only a PM, user, or admin may create Agents, dispatch Workers, restart/update services, or promote templates/rules. Agents and team managers must request those actions instead of executing them directly.',
      overridable: false,
    },
    {
      text: 'When code or configuration is changed, check whether docs and corresponding MetaMemory need updates, perform those updates when in scope, and report any omitted follow-up explicitly.',
      overridable: false,
    },
  ];
  if (purpose === 'worker-dispatch') {
    rules.push({
      text: 'Worker boundary: complete the assigned task in the requested workdir, write durable project findings to local project memory such as AGENTS.md when stable, and do not promote global/template rules without PM or user approval.',
      overridable: false,
    });
  }
  if (purpose === 'bot-turn') {
    rules.push({
      text: 'Bot turn boundary: use the current chat/project scope when retrieving rules or memory; do not inject unrelated project context into this chat.',
      overridable: false,
    });
  }
  return rules;
}

function parseRuleSetRefString(value: string): TeamRuleSetRef | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const [nameRaw, versionRaw] = trimmed.split('@');
  const name = nameRaw?.trim();
  if (!name) return undefined;
  const version = versionRaw ? Number(versionRaw) : undefined;
  return {
    name,
    ...(Number.isInteger(version) && version! > 0 ? { version } : {}),
  };
}

function parseRuleSetRefObject(value: unknown): TeamRuleSetRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return undefined;
  const version = Number(obj.version);
  return {
    name,
    ...(Number.isInteger(version) && version > 0 ? { version } : {}),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function hashObject(value: unknown): string {
  return hashText(stableStringify(value));
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveScopeKey(scopeType: Exclude<TeamInstanceScope, 'legacy'>, input: ResolveTeamInstanceInput): string {
  const key = input.scopeKey
    ?? (scopeType === 'chat' ? input.chatId : undefined)
    ?? (scopeType === 'project' ? input.projectId : undefined)
    ?? (scopeType === 'global' ? 'global' : undefined);
  if (!key) {
    throw Object.assign(new Error(`Missing scope key for ${scopeType} Agent Team instance`), { statusCode: 400 });
  }
  return key;
}

function safeKey(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${normalized.slice(0, 32) || 'scope'}-${hashText(value).slice(0, 8)}`;
}

function ruleScopePriority(scope: TeamRuleScope): number {
  switch (scope) {
    case 'global': return 10;
    case 'bot': return 20;
    case 'team-template': return 30;
    case 'team-instance': return 40;
    case 'project': return 50;
    case 'agent-role': return 60;
    case 'worker': return 65;
    case 'task': return 70;
  }
}

export function hasTeamCapability(role: TeamActorRole, action: TeamCapabilityAction): boolean {
  if (role === 'admin') return true;
  if (role === 'user' || role === 'pm') {
    return action === 'create_agent'
      || action === 'worker_dispatch'
      || action === 'promote_template'
      || action === 'restart_service'
      || action === 'manage_internal_task';
  }
  if (role === 'manager') return action === 'manage_internal_task';
  return false;
}

function canCreatePromotionProposal(role: TeamActorRole): boolean {
  return role === 'admin' || role === 'user' || role === 'pm' || role === 'manager' || role === 'agent';
}

function isTeamInstanceScope(value: unknown): value is TeamInstanceScope {
  return value === 'chat' || value === 'project' || value === 'global' || value === 'legacy';
}

function isTeamAgentKind(value: unknown): value is TeamAgentKind {
  return value === 'template' || value === 'custom' || value === 'temporary';
}

function isTeamAgentPromotionStatus(value: unknown): value is TeamAgentPromotionStatus {
  return value === 'none' || value === 'proposed' || value === 'approved' || value === 'rejected';
}

function isTeamActorRole(value: unknown): value is TeamActorRole {
  return value === 'admin'
    || value === 'user'
    || value === 'pm'
    || value === 'manager'
    || value === 'agent'
    || value === 'worker';
}

function isTeamPromotionProposalKind(value: unknown): value is TeamPromotionProposalKind {
  return value === 'template' || value === 'ruleset';
}

function isTeamPromotionProposalStatus(value: unknown): value is TeamPromotionProposalStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

function isTeamRuleScope(value: unknown): value is TeamRuleScope {
  return value === 'global'
    || value === 'bot'
    || value === 'team-template'
    || value === 'team-instance'
    || value === 'project'
    || value === 'agent-role'
    || value === 'worker'
    || value === 'task';
}

function mergeOutput(existing: string | undefined, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) return existing ?? '';
  if (!existing) return trimmed;
  if (trimmed.startsWith(existing)) return trimmed;
  if (existing.endsWith(trimmed)) return existing;
  return `${existing}\n${trimmed}`;
}
