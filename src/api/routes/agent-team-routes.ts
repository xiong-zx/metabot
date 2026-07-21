import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import { hasTeamCapability } from '../../agent-teams/team-store.js';
import { listCardLifecycleRecords } from '../../bridge/card-lifecycle-store.js';
import type {
  AgentStatus,
  RunStatus,
  TaskStatus,
  TeamInstanceScope,
  TeamActorRole,
  TeamCapabilityAction,
  TeamPromotionProposalKind,
  TeamPromotionProposalStatus,
  TeamRule,
  TeamRuleScope,
} from '../../agent-teams/team-store.js';

export async function handleAgentTeamRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rawUrl: string,
): Promise<boolean> {
  if (!rawUrl.startsWith('/api/agent-teams')) return false;
  const store = ctx.agentTeamStore;
  if (!store) {
    jsonResponse(res, 503, { error: 'Agent teams not available' });
    return true;
  }

  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const team = parts[2] ? decodeURIComponent(parts[2]) : undefined;
  const resource = parts[3];
  const id = parts[4] ? decodeURIComponent(parts[4]) : undefined;
  const action = parts[5];

  if (method === 'GET' && parts.length === 2) {
    jsonResponse(res, 200, { teams: store.listTeams() });
    return true;
  }

  if (method === 'POST' && parts.length === 2) {
    const body = await parseJsonBody(req);
    const name = stringField(body.name);
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing required field: name' });
      return true;
    }
    try {
      jsonResponse(res, 201, store.createTeam(name, stringField(body.description)));
    } catch (err: any) {
      jsonResponse(res, 409, { error: err.message });
    }
    return true;
  }

  if (parts[2] === 'templates') {
    if (method === 'GET' && parts.length === 3) {
      jsonResponse(res, 200, { templates: store.listTemplates() });
      return true;
    }
    if (method === 'GET' && parts.length === 5 && resource && id === 'export') {
      const template = store.exportTemplate(resource, numberField(parsed.searchParams.get('version')));
      jsonResponse(res, template ? 200 : 404, template ?? { error: 'Agent Team template not found' });
      return true;
    }
    if (method === 'GET' && parts.length === 5 && resource && id === 'diff') {
      const fromVersion = numberField(parsed.searchParams.get('from'));
      if (!fromVersion) {
        jsonResponse(res, 400, { error: 'Missing required query: from' });
        return true;
      }
      jsonResponse(res, 200, store.diffTemplateVersions(resource, fromVersion, numberField(parsed.searchParams.get('to'))));
      return true;
    }
    if (method === 'GET' && parts.length === 4 && resource) {
      jsonResponse(res, 200, { templates: store.listTemplates(resource) });
      return true;
    }
    if (method === 'POST' && parts.length === 3) {
      const body = await parseJsonBody(req);
      if (!requireActorCapability(res, body, 'promote_template')) return true;
      const templateBody = objectField(body.template) ?? body;
      const name = stringField(templateBody.name);
      if (!name) {
        jsonResponse(res, 400, { error: 'Missing required field: name' });
        return true;
      }
      jsonResponse(res, 201, store.upsertTemplateFromConfig(templateBody as any, stringField(body.source) ?? 'api'));
      return true;
    }
    return false;
  }

  if (parts[2] === 'instances') {
    if (method === 'GET' && parts.length === 3) {
      jsonResponse(res, 200, { instances: store.listTeamInstances(parsed.searchParams.get('template') || undefined) });
      return true;
    }
    if (method === 'POST' && parts.length === 4 && resource === 'resolve') {
      const body = await parseJsonBody(req);
      if (!requireActorCapability(res, body, 'create_agent')) return true;
      const templateName = stringField(body.templateName ?? body.template);
      if (!templateName) {
        jsonResponse(res, 400, { error: 'Missing required field: templateName' });
        return true;
      }
      try {
        const team = store.resolveTeamInstance({
          templateName,
          templateVersion: numberField(body.templateVersion),
          scopeType: teamScopeField(body.scopeType ?? body.scope),
          scopeKey: stringField(body.scopeKey),
          chatId: stringField(body.chatId),
          projectId: stringField(body.projectId),
          pmBot: stringField(body.pmBot),
          createIfMissing: body.createIfMissing !== false,
          allowGlobal: body.allowGlobal === true,
          quotas: objectField(body.quotas) as any,
          ruleSetRefs: ruleSetRefArrayField(body.ruleSetRefs),
        });
        jsonResponse(res, team ? 200 : 404, team ?? { error: 'Agent Team instance not found' });
      } catch (err: any) {
        jsonResponse(res, err.statusCode || 400, { error: err.message });
      }
      return true;
    }
    return false;
  }

  if (parts[2] === 'proposals') {
    if (method === 'GET' && parts.length === 3) {
      jsonResponse(res, 200, {
        proposals: store.listPromotionProposals(proposalStatusField(parsed.searchParams.get('status'))),
      });
      return true;
    }
    if (method === 'POST' && parts.length === 3) {
      const body = await parseJsonBody(req);
      const kind = proposalKindField(body.kind);
      const proposalBody = kind === 'template'
        ? objectField(body.body) ?? objectField(body.template)
        : kind === 'ruleset'
          ? objectField(body.body) ?? objectField(body.ruleset) ?? objectField(body.ruleSet)
          : undefined;
      if (!kind || !proposalBody) {
        jsonResponse(res, 400, { error: 'Missing required fields: kind/body' });
        return true;
      }
      try {
        jsonResponse(res, 201, store.createPromotionProposal({
          kind,
          body: proposalBody as any,
          summary: stringField(body.summary),
          requestedBy: stringField(body.requestedBy ?? body.by),
          requestedByRole: actorRoleField(body.requestedByRole ?? body.actorRole) ?? 'agent',
        }));
      } catch (err: any) {
        jsonResponse(res, err.statusCode || 400, { error: err.message });
      }
      return true;
    }
    if (method === 'GET' && parts.length === 4 && resource) {
      const proposal = store.getPromotionProposal(decodeURIComponent(resource));
      jsonResponse(res, proposal ? 200 : 404, proposal ?? { error: 'Agent Team promotion proposal not found' });
      return true;
    }
    if (method === 'POST' && parts.length === 5 && resource && (id === 'approve' || id === 'reject')) {
      const body = await parseJsonBody(req);
      try {
        jsonResponse(res, 200, store.decidePromotionProposal(decodeURIComponent(resource), {
          decision: id === 'approve' ? 'approved' : 'rejected',
          actorRole: actorRoleField(body.actorRole ?? body.role) ?? 'agent',
          decidedBy: stringField(body.decidedBy ?? body.by),
          reason: stringField(body.reason),
        }));
      } catch (err: any) {
        jsonResponse(res, err.statusCode || 400, { error: err.message });
      }
      return true;
    }
    return false;
  }

  if (parts[2] === 'rules') {
    if (method === 'GET' && parts.length === 3) {
      jsonResponse(res, 200, { ruleSets: store.listRuleSets() });
      return true;
    }
    if (method === 'GET' && parts.length === 5 && resource && id === 'export') {
      const ruleSet = store.exportRuleSet(resource, numberField(parsed.searchParams.get('version')));
      jsonResponse(res, ruleSet ? 200 : 404, ruleSet ?? { error: 'Agent Team RuleSet not found' });
      return true;
    }
    if (method === 'GET' && parts.length === 5 && resource && id === 'diff') {
      const fromVersion = numberField(parsed.searchParams.get('from'));
      if (!fromVersion) {
        jsonResponse(res, 400, { error: 'Missing required query: from' });
        return true;
      }
      jsonResponse(res, 200, store.diffRuleSetVersions(resource, fromVersion, numberField(parsed.searchParams.get('to'))));
      return true;
    }
    if (method === 'GET' && parts.length === 4 && resource && resource !== 'context') {
      jsonResponse(res, 200, { ruleSets: store.listRuleSets(resource) });
      return true;
    }
    if (method === 'POST' && parts.length === 3) {
      const body = await parseJsonBody(req);
      if (!requireActorCapability(res, body, 'promote_template')) return true;
      const name = stringField(body.name);
      const scope = ruleScopeField(body.scope);
      if (!name || !scope) {
        jsonResponse(res, 400, { error: 'Missing required fields: name/scope' });
        return true;
      }
      jsonResponse(res, 201, store.upsertRuleSet({
        name,
        scope,
        rules: ruleArrayField(body.rules),
        source: stringField(body.source) ?? 'api',
      }));
      return true;
    }
    if (method === 'POST' && parts.length === 4 && resource === 'context') {
      const body = await parseJsonBody(req);
      jsonResponse(res, 200, store.buildRulesContextPack({
        refs: Array.isArray(body.refs)
          ? body.refs.map((ref: any) => ({
            name: stringField(ref?.name) ?? '',
            version: numberField(ref?.version),
          })).filter((ref: { name: string }) => !!ref.name)
          : [],
        inlineRules: ruleArrayField(body.inlineRules),
      }));
      return true;
    }
    return false;
  }

  if (!team) return false;
  const teamName = store.resolveTeamName(team);
  if (!teamName) {
    jsonResponse(res, 404, { error: 'Agent team not found' });
    return true;
  }

  if (method === 'GET' && parts.length === 3) {
    const status = store.status(teamName);
    jsonResponse(res, status ? 200 : 404, status ?? { error: 'Agent team not found' });
    return true;
  }

  if (method === 'GET' && parts.length === 4 && resource === 'activity') {
    const teamRecord = store.getTeam(teamName);
    const activity = listCardLifecycleRecords()
      .filter((record) => isActivityForTeam(record, teamName, teamRecord?.instanceId))
      .filter((record) => matchesStringQuery(record.agentName, parsed.searchParams.get('agent')))
      .filter((record) => matchesStringQuery(record.runId, parsed.searchParams.get('runId') ?? parsed.searchParams.get('run')))
      .filter((record) => matchesStringQuery(record.chatId, parsed.searchParams.get('chatId') ?? parsed.searchParams.get('chat')))
      .filter((record) => matchesStringQuery(record.source, parsed.searchParams.get('source')))
      .filter((record) => matchesTaskQuery(record.taskIds, parsed.searchParams.get('taskId') ?? parsed.searchParams.get('task')))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, boundedLimit(parsed.searchParams.get('limit')));
    jsonResponse(res, 200, { activity });
    return true;
  }

  if (method === 'PATCH' && parts.length === 3) {
    const body = await parseJsonBody(req);
    if (!requireActorCapability(res, body, 'promote_template')) return true;
    const updated = store.updateTeamConfig(teamName, {
      chatIds: stringArrayField(body.chatIds),
      displayChatIds: stringArrayField(body.displayChatIds),
      pmBot: stringField(body.pmBot),
      quotas: teamQuotasField(body.quotas) as any,
      ruleSetRefs: ruleSetRefArrayField(body.ruleSetRefs),
    });
    jsonResponse(res, updated ? 200 : 404, updated ?? { error: 'Agent team not found' });
    return true;
  }

  if (method === 'DELETE' && parts.length === 3) {
    const deleted = store.deleteTeam(teamName);
    jsonResponse(res, deleted ? 200 : 404, { deleted });
    return true;
  }

  if (method === 'POST' && parts.length === 4 && (resource === 'start' || resource === 'stop')) {
    const updated = store.setTeamStatus(teamName, resource === 'start' ? 'active' : 'stopped');
    jsonResponse(res, updated ? 200 : 404, updated ?? { error: 'Agent team not found' });
    return true;
  }

  if (resource === 'agents') {
    if (method === 'GET' && parts.length === 4) {
      jsonResponse(res, 200, { agents: store.listAgents(teamName) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const body = await parseJsonBody(req);
      const name = stringField(body.name);
      if (!name) {
        jsonResponse(res, 400, { error: 'Missing required field: name' });
        return true;
      }
      try {
        jsonResponse(res, 201, store.createAgent(teamName, {
          name,
          role: stringField(body.role),
          engine: engineField(body.engine),
          model: stringField(body.model),
          reasoningEffort: reasoningEffortField(body.reasoningEffort),
          approvalPolicy: approvalPolicyField(body.approvalPolicy),
          sandbox: sandboxField(body.sandbox),
          timeoutMs: numberField(body.timeoutMs),
          idleTimeoutMs: numberField(body.idleTimeoutMs),
          allowedTools: stringArrayField(body.allowedTools),
          prompt: stringField(body.prompt),
          sessionId: stringField(body.sessionId),
          kind: agentKindField(body.kind),
          createdBy: stringField(body.createdBy),
          actorRole: actorRoleField(body.actorRole) ?? 'agent',
          ttlMs: numberField(body.ttlMs),
        }));
      } catch (err: any) {
        jsonResponse(res, err.statusCode || 409, { error: err.message });
      }
      return true;
    }
    if (method === 'POST' && parts.length === 6 && id && action === 'stop') {
      const agent = store.setAgentStatus(teamName, id, 'stopped');
      jsonResponse(res, agent ? 200 : 404, agent ?? { error: 'Agent not found' });
      return true;
    }
    if (method === 'DELETE' && parts.length === 5 && id) {
      const deleted = store.deleteAgent(teamName, id);
      jsonResponse(res, deleted ? 200 : 404, { deleted });
      return true;
    }
    if (method === 'PATCH' && parts.length === 5 && id) {
      const body = await parseJsonBody(req);
      const status = agentStatusField(body.status);
      if (!status) {
        jsonResponse(res, 400, { error: 'Missing or invalid field: status' });
        return true;
      }
      const agent = store.setAgentStatus(teamName, id, status);
      jsonResponse(res, agent ? 200 : 404, agent ?? { error: 'Agent not found' });
      return true;
    }
  }

  if (resource === 'messages') {
    if (method === 'GET' && parts.length === 4) {
      const to = parsed.searchParams.get('to') || undefined;
      const unreadOnly = parsed.searchParams.get('unread') === '1' || parsed.searchParams.get('unread') === 'true';
      jsonResponse(res, 200, { messages: store.listMessages(teamName, to, unreadOnly) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const body = await parseJsonBody(req);
      const toName = stringField(body.toName ?? body.to);
      const messageBody = stringField(body.body ?? body.message);
      if (!toName || !messageBody) {
        jsonResponse(res, 400, { error: 'Missing required fields: toName/body' });
        return true;
      }
      jsonResponse(res, 201, store.sendMessage(teamName, {
        toName,
        body: messageBody,
        fromName: stringField(body.fromName ?? body.from),
        summary: stringField(body.summary),
      }));
      return true;
    }
    if (method === 'POST' && parts.length === 5 && id === 'read') {
      const to = parsed.searchParams.get('to') || stringField((await parseJsonBody(req)).to);
      if (!to) {
        jsonResponse(res, 400, { error: 'Missing required field/query: to' });
        return true;
      }
      jsonResponse(res, 200, { read: store.markMessagesRead(teamName, to) });
      return true;
    }
  }

  if (resource === 'tasks') {
    if (method === 'GET' && parts.length === 4) {
      jsonResponse(res, 200, { tasks: store.listTasks(teamName) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const body = await parseJsonBody(req);
      const subject = stringField(body.subject);
      if (!subject) {
        jsonResponse(res, 400, { error: 'Missing required field: subject' });
        return true;
      }
      jsonResponse(res, 201, store.createTask(teamName, {
        subject,
        description: stringField(body.description),
        owner: stringField(body.owner),
        blockedBy: numberArrayField(body.blockedBy),
      }));
      return true;
    }
    if (method === 'GET' && parts.length === 5 && id) {
      const task = store.getTask(teamName, Number(id));
      jsonResponse(res, task ? 200 : 404, task ?? { error: 'Task not found' });
      return true;
    }
    if (method === 'PATCH' && parts.length === 5 && id) {
      const body = await parseJsonBody(req);
      const task = store.updateTask(teamName, Number(id), {
        subject: stringField(body.subject),
        description: stringField(body.description),
        status: taskStatusField(body.status),
        owner: body.owner === null ? null : stringField(body.owner),
        blockedBy: numberArrayField(body.blockedBy),
        result: stringField(body.result),
      });
      jsonResponse(res, task ? 200 : 404, task ?? { error: 'Task not found' });
      return true;
    }
  }

  if (resource === 'runs') {
    if (method === 'GET' && parts.length === 4) {
      jsonResponse(res, 200, { runs: store.listRuns(teamName) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const body = await parseJsonBody(req);
      jsonResponse(res, 201, store.createRun(teamName, {
        id: stringField(body.id),
        agentName: stringField(body.agentName ?? body.agent),
        taskId: typeof body.taskId === 'number' ? body.taskId : undefined,
        status: runStatusField(body.status),
        output: stringField(body.output),
        error: stringField(body.error),
      }));
      return true;
    }
    if (method === 'GET' && parts.length === 5 && id) {
      const run = store.getRun(teamName, id);
      jsonResponse(res, run ? 200 : 404, run ?? { error: 'Run not found' });
      return true;
    }
    if (method === 'GET' && parts.length === 6 && id && action === 'output') {
      const run = store.getRun(teamName, id);
      jsonResponse(res, run ? 200 : 404, run ? { id: run.id, output: run.output ?? '', error: run.error } : { error: 'Run not found' });
      return true;
    }
    if (method === 'POST' && parts.length === 6 && id && action === 'stop') {
      const run = ctx.agentTeamSupervisor?.stopRun(teamName, id) ?? store.updateRun(teamName, id, { status: 'stopped' });
      jsonResponse(res, run ? 200 : 404, run ?? { error: 'Run not found' });
      return true;
    }
    if (method === 'PATCH' && parts.length === 5 && id) {
      const body = await parseJsonBody(req);
      const run = store.updateRun(teamName, id, {
        status: runStatusField(body.status),
        output: stringField(body.output),
        error: stringField(body.error),
      });
      jsonResponse(res, run ? 200 : 404, run ?? { error: 'Run not found' });
      return true;
    }
  }

  return false;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  const num = typeof value === 'string' && value.trim() ? Number(value) : value;
  return Number.isInteger(num) ? Number(num) : undefined;
}

function boundedLimit(value: unknown): number {
  const limit = numberField(value) ?? 50;
  return Math.max(1, Math.min(200, limit));
}

function matchesStringQuery(value: string | undefined, query: string | null): boolean {
  return !query || value === query;
}

function matchesTaskQuery(taskIds: number[] | undefined, query: string | null): boolean {
  if (!query) return true;
  const taskId = Number(query);
  return Number.isInteger(taskId) && (taskIds || []).includes(taskId);
}

function isActivityForTeam(
  record: ReturnType<typeof listCardLifecycleRecords>[number],
  teamName: string,
  instanceId?: string,
): boolean {
  if (record.teamName === teamName) return true;
  if (instanceId && record.instanceId === instanceId) return true;
  if (record.lifecycleKey.startsWith(`team:${teamName}:`)) return true;
  if (instanceId && record.lifecycleKey.startsWith(`teaminst:${instanceId}:`)) return true;
  return false;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberArrayField(value: unknown): number[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : undefined;
}

function ruleSetRefArrayField(value: unknown): Array<{ name: string; version?: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .map((item): { name: string; version?: number } | undefined => {
      if (typeof item === 'string') {
        const [nameRaw, versionRaw] = item.split('@');
        const name = nameRaw?.trim();
        const version = versionRaw ? Number(versionRaw) : undefined;
        if (!name) return undefined;
        return { name, ...(Number.isInteger(version) && version! > 0 ? { version } : {}) };
      }
      const obj = objectField(item);
      const name = stringField(obj?.name);
      const version = numberField(obj?.version);
      if (!name) return undefined;
      return { name, ...(version ? { version } : {}) };
    })
    .filter((ref): ref is { name: string; version?: number } => !!ref);
  return refs.length > 0 ? refs : [];
}

function teamQuotasField(value: unknown): Record<string, number> | undefined {
  const obj = objectField(value);
  if (!obj) return undefined;
  const quotas: Record<string, number> = {};
  for (const [field, raw] of Object.entries(obj)) {
    const parsed = numberField(raw);
    if (parsed != null) quotas[field] = parsed;
  }
  return Object.keys(quotas).length > 0 ? quotas : {};
}

function engineField(value: unknown): 'claude' | 'codex' | 'kimi' | undefined {
  return value === 'claude' || value === 'codex' || value === 'kimi' ? value : undefined;
}

function reasoningEffortField(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  return value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
    ? value
    : undefined;
}

function approvalPolicyField(value: unknown): 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined {
  return value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never'
    ? value
    : undefined;
}

function sandboxField(value: unknown): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
    ? value
    : undefined;
}

function teamScopeField(value: unknown): Exclude<TeamInstanceScope, 'legacy'> | undefined {
  return value === 'chat' || value === 'project' || value === 'global' ? value : undefined;
}

function ruleScopeField(value: unknown): TeamRuleScope | undefined {
  return value === 'global'
    || value === 'bot'
    || value === 'team-template'
    || value === 'team-instance'
    || value === 'project'
    || value === 'agent-role'
    || value === 'worker'
    || value === 'task'
    ? value
    : undefined;
}

function proposalKindField(value: unknown): TeamPromotionProposalKind | undefined {
  return value === 'template' || value === 'ruleset' ? value : undefined;
}

function proposalStatusField(value: unknown): TeamPromotionProposalStatus | undefined {
  return value === 'pending' || value === 'approved' || value === 'rejected' ? value : undefined;
}

function ruleArrayField(value: unknown): TeamRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((rule): TeamRule | undefined => {
      if (typeof rule === 'string') return { text: rule };
      const obj = objectField(rule);
      if (!obj) return undefined;
      const text = stringField(obj.text);
      if (!text) return undefined;
      return {
        text,
        ...(stringField(obj.id) ? { id: stringField(obj.id) } : {}),
        ...(stringField(obj.target) ? { target: stringField(obj.target) } : {}),
        ...(typeof obj.overridable === 'boolean' ? { overridable: obj.overridable } : {}),
      };
    })
    .filter((rule): rule is TeamRule => !!rule);
}

function agentKindField(value: unknown): 'template' | 'custom' | 'temporary' | undefined {
  return value === 'template' || value === 'custom' || value === 'temporary' ? value : undefined;
}

function actorRoleField(value: unknown): TeamActorRole | undefined {
  return value === 'admin'
    || value === 'user'
    || value === 'pm'
    || value === 'manager'
    || value === 'agent'
    || value === 'worker'
    ? value
    : undefined;
}

function requireActorCapability(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  action: TeamCapabilityAction,
): boolean {
  const role = actorRoleField(body.actorRole ?? body.role) ?? 'agent';
  if (hasTeamCapability(role, action)) return true;
  jsonResponse(res, 403, { error: `actorRole ${role} is not allowed to ${action}` });
  return false;
}

function taskStatusField(value: unknown): TaskStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted' ? value : undefined;
}

function agentStatusField(value: unknown): AgentStatus | undefined {
  return value === 'idle' || value === 'working' || value === 'stopped' ? value : undefined;
}

function runStatusField(value: unknown): RunStatus | undefined {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'stopped' ? value : undefined;
}
