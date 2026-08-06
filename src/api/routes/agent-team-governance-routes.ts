import type * as http from 'node:http';
import type { GovernanceRuleScope, TeamGovernanceScope } from '../../agent-teams/governance-extension.js';
import { AgentTeamGovernanceError } from '../../agent-teams/governance-extension.js';
import { AgentTeamCapabilityError } from '../../agent-teams/governance-capability.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleAgentTeamGovernanceRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rawUrl: string,
): Promise<boolean> {
  if (!rawUrl.startsWith('/api/agent-team-governance')) return false;
  const governance = ctx.agentTeamGovernance;
  if (!governance || !ctx.resolveAgentTeamPrincipal) {
    jsonResponse(res, 503, { error: 'Agent Team governance not available' });
    return true;
  }
  try {
    const actor = ctx.resolveAgentTeamPrincipal(req);
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const resource = parts[2];
    const id = parts[3] ? decodeURIComponent(parts[3]) : undefined;
    const action = parts[4];

    if (resource === 'templates') {
      if (method === 'GET' && parts.length === 3) {
        governance.authorize(actor, 'promote_template');
        jsonResponse(res, 200, { templates: governance.listTemplates(parsed.searchParams.get('name') || undefined) });
        return true;
      }
      if (method === 'POST' && parts.length === 3) {
        const body = await parseJsonBody(req);
        jsonResponse(
          res,
          201,
          governance.publishTemplate({
            actor,
            name: stringField(body.name) ?? '',
            body: objectField(body.body),
          }),
        );
        return true;
      }
    }

    if (resource === 'rules') {
      if (method === 'GET' && parts.length === 3) {
        governance.authorize(actor, 'promote_rules');
        jsonResponse(res, 200, { ruleSets: governance.listRuleSets(parsed.searchParams.get('name') || undefined) });
        return true;
      }
      if (method === 'POST' && parts.length === 3) {
        const body = await parseJsonBody(req);
        jsonResponse(
          res,
          201,
          governance.publishRuleSet({
            actor,
            name: stringField(body.name) ?? '',
            scope: ruleScopeField(body.scope),
            rules: Array.isArray(body.rules)
              ? (body.rules as Array<{ id?: string; text: string; target?: string }>)
              : [],
          }),
        );
        return true;
      }
    }

    if (resource === 'instances') {
      if (method === 'GET' && parts.length === 3) {
        governance.authorize(actor, 'create_team');
        jsonResponse(res, 200, { instances: governance.listInstances(true) });
        return true;
      }
      if (method === 'POST' && parts.length === 3) {
        const body = await parseJsonBody(req);
        const instance = governance.resolveInstance({
          actor,
          templateName: stringField(body.templateName) ?? '',
          templateVersion: positiveInteger(body.templateVersion),
          scopeType: scopeField(body.scopeType),
          scopeKey: stringField(body.scopeKey),
          chatId: stringField(body.chatId) ?? actor.chatId,
          projectId: stringField(body.projectId),
          createIfMissing: body.createIfMissing !== false,
          allowGlobal: body.allowGlobal === true,
          quotas: objectField(body.quotas),
          ruleSetRefs: Array.isArray(body.ruleSetRefs)
            ? (body.ruleSetRefs as Array<{ name: string; version?: number }>)
            : undefined,
          pmBot: stringField(body.pmBot),
          temporaryAgentIdleMs: positiveInteger(body.temporaryAgentIdleMs),
        });
        jsonResponse(res, instance ? 201 : 404, instance ?? { error: 'Governed Agent Team instance not found' });
        return true;
      }
      if (id && method === 'GET' && parts.length === 4) {
        governance.authorize(actor, 'create_team', { instanceId: id });
        const instance = governance.getInstance(id);
        jsonResponse(res, instance ? 200 : 404, instance ?? { error: 'Governed Agent Team instance not found' });
        return true;
      }
      if (id && method === 'POST' && action === 'start') {
        jsonResponse(res, 200, governance.reactivateInstance(actor, id));
        return true;
      }
      if (id && method === 'POST' && action === 'stop') {
        const instance = governance.getInstance(id);
        if (instance) stopActiveRuns(ctx, instance.teamName);
        jsonResponse(res, 200, governance.stopInstance(actor, id));
        return true;
      }
      if (id && method === 'DELETE' && parts.length === 4) {
        const instance = governance.getInstance(id);
        if (instance) stopActiveRuns(ctx, instance.teamName);
        jsonResponse(res, 200, { deleted: governance.deleteInstance(actor, id) });
        return true;
      }
    }

    if (resource === 'audit' && method === 'GET' && parts.length === 3) {
      governance.authorize(actor, 'promote_rules');
      jsonResponse(res, 200, {
        events: governance.listAudit({
          instanceId: parsed.searchParams.get('instanceId') || undefined,
          limit: positiveInteger(parsed.searchParams.get('limit')),
        }),
      });
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof AgentTeamGovernanceError) {
      jsonResponse(res, error.statusCode, { error: error.message, code: error.code });
      return true;
    }
    if (error instanceof AgentTeamCapabilityError) {
      jsonResponse(res, 401, { error: error.message, code: error.code });
      return true;
    }
    throw error;
  }
}

function stopActiveRuns(ctx: RouteContext, teamName: string): void {
  const store = ctx.agentTeamStore;
  if (!store) return;
  for (const run of store.listRuns(teamName)) {
    if (run.status === 'running') {
      if (ctx.agentTeamSupervisor) ctx.agentTeamSupervisor.stopRun(teamName, run.id);
      else store.updateRun(teamName, run.id, { status: 'stopped' });
    }
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function objectField<T extends object>(value: unknown): T {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : ({} as T);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function scopeField(value: unknown): TeamGovernanceScope {
  return value === 'project' || value === 'global' ? value : 'chat';
}

function ruleScopeField(value: unknown): GovernanceRuleScope {
  if (value === 'global' || value === 'team-template' || value === 'team-instance' || value === 'project') return value;
  throw new AgentTeamGovernanceError('Missing or invalid RuleSet scope', 400, 'INVALID_RULE_SCOPE');
}
