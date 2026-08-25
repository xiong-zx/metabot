import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import type { AgentStatus, RunStatus, TaskStatus } from '../../agent-teams/team-store.js';
import type { AgentTeamExecutionPrincipal } from '../../agent-teams/governance-capability.js';
import type { AgentTeamGovernanceExtension } from '../../agent-teams/governance-extension.js';

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
  const hasEngineMarker = !!req.headers['x-metabot-bot-name'] || !!req.headers['x-metabot-chat-id'];
  if (hasEngineMarker) {
    if (!ctx.resolveAgentTeamPrincipal) {
      jsonResponse(res, 503, { error: 'Agent Team execution authentication not available' });
      return true;
    }
    try {
      const principal = ctx.resolveAgentTeamPrincipal(req);
      if ((principal.role === 'manager' || principal.role === 'agent') && (!team || principal.teamName !== team)) {
        jsonResponse(res, 403, { error: `${principal.role} may access only its signed Agent Team scope` });
        return true;
      }
    } catch (error) {
      const value = error as { message?: string; code?: string };
      jsonResponse(res, 401, { error: value.message ?? 'Invalid Agent Team execution capability', code: value.code });
      return true;
    }
  }

  if (method === 'GET' && parts.length === 2) {
    jsonResponse(res, 200, { teams: store.listTeams() });
    return true;
  }

  if (method === 'POST' && parts.length === 2) {
    const trusted = mutationContext(ctx, req, res);
    if (!trusted) return true;
    trusted.governance.authorize(trusted.actor, 'create_team');
    const body = await parseJsonBody(req);
    const name = stringField(body.name);
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing required field: name' });
      return true;
    }
    if (name.startsWith('atg-')) {
      jsonResponse(res, 409, { error: 'The atg- Team name prefix is reserved for governed instances' });
      return true;
    }
    try {
      jsonResponse(res, 201, store.createTeam(name, stringField(body.description)));
    } catch (err: any) {
      jsonResponse(res, 409, { error: err.message });
    }
    return true;
  }

  if (!team) return false;

  if (method === 'GET' && parts.length === 3) {
    const status = store.status(team);
    jsonResponse(res, status ? 200 : 404, status ?? { error: 'Agent team not found' });
    return true;
  }

  if (method === 'PATCH' && parts.length === 3) {
    const trusted = mutationContext(ctx, req, res);
    if (!trusted) return true;
    const governed = trusted.governance.findAnyInstanceByTeamName(team);
    if (governed) {
      jsonResponse(res, 409, { error: 'Governed team bindings are pinned; use the governance instance API' });
      return true;
    }
    trusted.governance.authorize(trusted.actor, 'create_team', { teamName: team });
    const body = await parseJsonBody(req);
    const updated = store.setTeamChatBindings(team, {
      chatIds: stringArrayField(body.chatIds),
      displayChatIds: stringArrayField(body.displayChatIds),
    });
    jsonResponse(res, updated ? 200 : 404, updated ?? { error: 'Agent team not found' });
    return true;
  }

  if (method === 'DELETE' && parts.length === 3) {
    const trusted = mutationContext(ctx, req, res);
    if (!trusted) return true;
    const governed = trusted.governance.findAnyInstanceByTeamName(team);
    if (governed) stopActiveRuns(ctx, store, team);
    const deleted = governed
      ? trusted.governance.deleteInstance(trusted.actor, governed.id)
      : (trusted.governance.authorize(trusted.actor, 'delete_team', { teamName: team }), store.deleteTeam(team));
    jsonResponse(res, deleted ? 200 : 404, { deleted });
    return true;
  }

  if (method === 'POST' && parts.length === 4 && (resource === 'start' || resource === 'stop')) {
    const trusted = mutationContext(ctx, req, res);
    if (!trusted) return true;
    const governed = trusted.governance.findAnyInstanceByTeamName(team);
    if (governed && resource === 'stop') stopActiveRuns(ctx, store, team);
    const updated = governed
      ? resource === 'start'
        ? trusted.governance.reactivateInstance(trusted.actor, governed.id)
        : trusted.governance.stopInstance(trusted.actor, governed.id)
      : (trusted.governance.authorize(trusted.actor, resource === 'start' ? 'start_team' : 'stop_team', {
          teamName: team,
        }),
        store.setTeamStatus(team, resource === 'start' ? 'active' : 'stopped'));
    jsonResponse(res, updated ? 200 : 404, updated ?? { error: 'Agent team not found' });
    return true;
  }

  if (resource === 'agents') {
    if (method === 'GET' && parts.length === 4) {
      jsonResponse(res, 200, { agents: store.listAgents(team) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      const body = await parseJsonBody(req);
      const name = stringField(body.name);
      if (!name) {
        jsonResponse(res, 400, { error: 'Missing required field: name' });
        return true;
      }
      try {
        const governed = trusted.governance.findAnyInstanceByTeamName(team);
        const created = governed
          ? trusted.governance.createAgent({
              actor: trusted.actor,
              instanceId: governed.id,
              name,
              role: stringField(body.role),
              engine: engineField(body.engine),
              prompt: stringField(body.prompt),
              sessionId: stringField(body.sessionId),
              kind: body.kind === 'temporary' ? 'temporary' : 'custom',
              ttlMs: positiveIntegerField(body.ttlMs),
            })
          : (trusted.governance.authorize(trusted.actor, 'create_agent', { teamName: team, subject: name }),
            store.createAgent(team, {
              name,
              role: stringField(body.role),
              engine: engineField(body.engine),
              prompt: stringField(body.prompt),
              sessionId: stringField(body.sessionId),
            }));
        jsonResponse(res, 201, created);
      } catch (err: any) {
        jsonResponse(res, err.statusCode || 409, { error: err.message });
      }
      return true;
    }
    if (method === 'POST' && parts.length === 6 && id && action === 'stop') {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      const governed = trusted.governance.findAnyInstanceByTeamName(team);
      if (governed) stopActiveRuns(ctx, store, team, id);
      const agent = governed
        ? trusted.governance.stopAgent(trusted.actor, governed.id, id)
        : (trusted.governance.authorize(trusted.actor, 'stop_agent', { teamName: team, subject: id }),
          store.setAgentStatus(team, id, 'stopped'));
      jsonResponse(res, agent ? 200 : 404, agent ?? { error: 'Agent not found' });
      return true;
    }
    if (method === 'DELETE' && parts.length === 5 && id) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      const governed = trusted.governance.findAnyInstanceByTeamName(team);
      if (governed) stopActiveRuns(ctx, store, team, id);
      const deleted = governed
        ? trusted.governance.deleteAgent(trusted.actor, governed.id, id)
        : (trusted.governance.authorize(trusted.actor, 'delete_agent', { teamName: team, subject: id }),
          store.deleteAgent(team, id));
      jsonResponse(res, deleted ? 200 : 404, { deleted });
      return true;
    }
    if (method === 'PATCH' && parts.length === 5 && id) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      const body = await parseJsonBody(req);
      const status = agentStatusField(body.status);
      if (!status) {
        jsonResponse(res, 400, { error: 'Missing or invalid field: status' });
        return true;
      }
      const governed = trusted.governance.findAnyInstanceByTeamName(team);
      if (governed && status !== 'stopped') {
        jsonResponse(res, 409, { error: 'Governed agents must be recreated through the governed agent API' });
        return true;
      }
      const agent = governed
        ? trusted.governance.stopAgent(trusted.actor, governed.id, id)
        : (trusted.governance.authorize(trusted.actor, 'stop_agent', { teamName: team, subject: id }),
          store.setAgentStatus(team, id, status));
      jsonResponse(res, agent ? 200 : 404, agent ?? { error: 'Agent not found' });
      return true;
    }
  }

  if (resource === 'messages') {
    if (method === 'GET' && parts.length === 4) {
      const to = parsed.searchParams.get('to') || undefined;
      const unreadOnly = parsed.searchParams.get('unread') === '1' || parsed.searchParams.get('unread') === 'true';
      jsonResponse(res, 200, { messages: store.listMessages(team, to, unreadOnly) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      if (!assertCoordinationScope(trusted.actor, team, res)) return true;
      const body = await parseJsonBody(req);
      const toName = stringField(body.toName ?? body.to);
      const messageBody = stringField(body.body ?? body.message);
      if (!toName || !messageBody) {
        jsonResponse(res, 400, { error: 'Missing required fields: toName/body' });
        return true;
      }
      jsonResponse(
        res,
        201,
        store.sendMessage(team, {
          toName,
          body: messageBody,
          fromName: trusted.actor.agentName ?? stringField(body.fromName ?? body.from),
          summary: stringField(body.summary),
        }),
      );
      return true;
    }
    if (method === 'POST' && parts.length === 5 && id === 'read') {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      if (!assertCoordinationScope(trusted.actor, team, res)) return true;
      const to = parsed.searchParams.get('to') || stringField((await parseJsonBody(req)).to);
      if (!to) {
        jsonResponse(res, 400, { error: 'Missing required field/query: to' });
        return true;
      }
      jsonResponse(res, 200, { read: store.markMessagesRead(team, to) });
      return true;
    }
  }

  if (resource === 'tasks') {
    if (method === 'GET' && parts.length === 4) {
      jsonResponse(res, 200, { tasks: store.listTasks(team) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      if (!assertCoordinationScope(trusted.actor, team, res)) return true;
      const body = await parseJsonBody(req);
      const subject = stringField(body.subject);
      if (!subject) {
        jsonResponse(res, 400, { error: 'Missing required field: subject' });
        return true;
      }
      const governed = trusted.governance.findAnyInstanceByTeamName(team);
      if (governed) trusted.governance.assertCanQueueTask(governed.id, trusted.actor);
      jsonResponse(
        res,
        201,
        store.createTask(team, {
          subject,
          description: stringField(body.description),
          owner: stringField(body.owner),
          blockedBy: numberArrayField(body.blockedBy),
        }),
      );
      return true;
    }
    if (method === 'GET' && parts.length === 5 && id) {
      const task = store.getTask(team, Number(id));
      jsonResponse(res, task ? 200 : 404, task ?? { error: 'Task not found' });
      return true;
    }
    if (method === 'PATCH' && parts.length === 5 && id) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      if (!assertCoordinationScope(trusted.actor, team, res)) return true;
      const body = await parseJsonBody(req);
      const task = store.updateTask(team, Number(id), {
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
      jsonResponse(res, 200, { runs: store.listRuns(team) });
      return true;
    }
    if (method === 'POST' && parts.length === 4) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      const governed = trusted.governance.findAnyInstanceByTeamName(team);
      if (governed) {
        jsonResponse(res, 403, { error: 'Governed runs are created only by the Agent Team supervisor' });
        return true;
      }
      trusted.governance.authorize(trusted.actor, 'start_team', { teamName: team });
      const body = await parseJsonBody(req);
      jsonResponse(
        res,
        201,
        store.createRun(team, {
          id: stringField(body.id),
          agentName: stringField(body.agentName ?? body.agent),
          taskId: typeof body.taskId === 'number' ? body.taskId : undefined,
          status: runStatusField(body.status),
          output: stringField(body.output),
          error: stringField(body.error),
        }),
      );
      return true;
    }
    if (method === 'GET' && parts.length === 5 && id) {
      const run = store.getRun(team, id);
      jsonResponse(res, run ? 200 : 404, run ?? { error: 'Run not found' });
      return true;
    }
    if (method === 'GET' && parts.length === 6 && id && action === 'output') {
      const run = store.getRun(team, id);
      jsonResponse(res, run ? 200 : 404, run ? { id: run.id, output: run.output ?? '', error: run.error } : { error: 'Run not found' });
      return true;
    }
    if (method === 'POST' && parts.length === 6 && id && action === 'stop') {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      trusted.governance.authorize(trusted.actor, 'stop_run', { teamName: team, subject: id });
      const run = ctx.agentTeamSupervisor?.stopRun(team, id) ?? store.updateRun(team, id, { status: 'stopped' });
      jsonResponse(res, run ? 200 : 404, run ?? { error: 'Run not found' });
      return true;
    }
    if (method === 'PATCH' && parts.length === 5 && id) {
      const trusted = mutationContext(ctx, req, res);
      if (!trusted) return true;
      if (trusted.governance.findAnyInstanceByTeamName(team)) {
        jsonResponse(res, 403, { error: 'Governed runs are updated only by the Agent Team supervisor' });
        return true;
      }
      trusted.governance.authorize(trusted.actor, 'start_team', { teamName: team });
      const body = await parseJsonBody(req);
      const run = store.updateRun(team, id, {
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

function numberArrayField(value: unknown): number[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : undefined;
}

function engineField(value: unknown): 'claude' | 'codex' | 'kimi' | undefined {
  return value === 'claude' || value === 'codex' || value === 'kimi' ? value : undefined;
}

function positiveIntegerField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function mutationContext(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): { actor: AgentTeamExecutionPrincipal; governance: AgentTeamGovernanceExtension } | undefined {
  if (!ctx.agentTeamGovernance || !ctx.resolveAgentTeamPrincipal) {
    jsonResponse(res, 503, { error: 'Agent Team governance not available' });
    return undefined;
  }
  try {
    return { actor: ctx.resolveAgentTeamPrincipal(req), governance: ctx.agentTeamGovernance };
  } catch (error) {
    const value = error as { message?: string; code?: string };
    jsonResponse(res, 401, { error: value.message ?? 'Trusted Agent Team principal required', code: value.code });
    return undefined;
  }
}

function assertCoordinationScope(
  actor: AgentTeamExecutionPrincipal,
  teamName: string,
  res: http.ServerResponse,
): boolean {
  if (actor.role === 'admin' || actor.role === 'pm' || actor.role === 'user') return true;
  if ((actor.role === 'manager' || actor.role === 'agent') && actor.teamName === teamName) return true;
  jsonResponse(res, 403, { error: `${actor.role} may coordinate only its signed Agent Team scope` });
  return false;
}

function stopActiveRuns(
  ctx: RouteContext,
  store: NonNullable<RouteContext['agentTeamStore']>,
  teamName: string,
  agentName?: string,
): void {
  for (const run of store.listRuns(teamName)) {
    if (run.status !== 'running' || (agentName && run.agentName !== agentName)) continue;
    if (ctx.agentTeamSupervisor) ctx.agentTeamSupervisor.stopRun(teamName, run.id);
    else store.updateRun(teamName, run.id, { status: 'stopped' });
  }
}

function taskStatusField(value: unknown): TaskStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed' || value === 'deleted'
    ? value
    : undefined;
}

function agentStatusField(value: unknown): AgentStatus | undefined {
  return value === 'idle' || value === 'working' || value === 'stopped' ? value : undefined;
}

function runStatusField(value: unknown): RunStatus | undefined {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'stopped' ? value : undefined;
}
