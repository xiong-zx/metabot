import type * as http from 'node:http';
import type { AgentTeamExecutionPrincipal } from '../../agent-teams/governance-capability.js';
import type { RouteHandler } from './types.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import {
  cancelControlledRestart,
  prepareControlledRestart,
  readControlledRestartPlan,
  RestartPreparationError,
} from '../../bridge/restart-coordinator.js';

export const handleRestartRoutes: RouteHandler = async (ctx, req, res, method, url) => {
  if (method === 'POST' && url === '/api/runtime/restart/prepare') {
    const body = await parseJsonBody(req);
    const requestId = stringField(body.requestId);
    if (!requestId) {
      jsonResponse(res, 400, { error: 'requestId is required' });
      return true;
    }
    const authorization = resolveRestartAuthorization(ctx, req, res);
    if (authorization.rejected) return true;
    const requesterBot = stringField(body.requesterBot);
    const requesterChat = stringField(body.requesterChat);
    if (authorization.principal && (
      requesterBot !== authorization.principal.botName
      || requesterChat !== authorization.principal.chatId
    )) {
      jsonResponse(res, 403, { error: 'A signed engine session may prepare a restart only for its own bot and chat' });
      return true;
    }
    try {
      const plan = await prepareControlledRestart({
        registry: ctx.registry,
        logger: ctx.logger,
        request: {
          requestId,
          ...(requesterBot ? { requesterBot } : {}),
          ...(requesterChat ? { requesterChat } : {}),
          ...(stringField(body.source) ? { source: stringField(body.source) } : {}),
          ...(stringField(body.reason) ? { reason: stringField(body.reason) } : {}),
          resume: body.resume !== false,
          force: body.force === true,
        },
      });
      jsonResponse(res, 200, {
        requestId: plan.requestId,
        status: plan.status,
        participantCount: plan.participants.length,
        activeCount: plan.participants.filter((participant) => participant.wasActive).length,
        prepareNoticesDelivered: plan.participants.filter((participant) => participant.prepareNotice === 'delivered').length,
      });
    } catch (error) {
      if (error instanceof RestartPreparationError) {
        jsonResponse(res, error.statusCode, { error: error.message });
      } else {
        throw error;
      }
    }
    return true;
  }

  if (method === 'POST' && url === '/api/runtime/restart/cancel') {
    const body = await parseJsonBody(req);
    const requestId = stringField(body.requestId);
    if (!requestId) {
      jsonResponse(res, 400, { error: 'requestId is required' });
      return true;
    }
    const authorization = resolveRestartAuthorization(ctx, req, res);
    if (authorization.rejected) return true;
    if (authorization.principal) {
      const current = readControlledRestartPlan();
      if (
        current?.requestId !== requestId
        || current.requesterBot !== authorization.principal.botName
        || current.requesterChat !== authorization.principal.chatId
      ) {
        jsonResponse(res, 403, { error: 'A signed engine session may cancel only its own restart request' });
        return true;
      }
    }
    const plan = cancelControlledRestart({ registry: ctx.registry, requestId });
    jsonResponse(res, 200, { requestId, status: plan?.status ?? 'not-found' });
    return true;
  }

  return false;
};

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveRestartAuthorization(
  ctx: Parameters<RouteHandler>[0],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): { principal?: AgentTeamExecutionPrincipal; rejected: boolean } {
  const hasExecutionMarker = !!req.headers['x-metabot-team-capability']
    || !!req.headers['x-metabot-bot-name']
    || !!req.headers['x-metabot-chat-id'];
  if (!hasExecutionMarker) return { rejected: false };
  if (!ctx.resolveAgentTeamPrincipal) {
    jsonResponse(res, 503, { error: 'Execution capability authentication is unavailable' });
    return { rejected: true };
  }
  try {
    const principal = ctx.resolveAgentTeamPrincipal(req);
    if (principal.role !== 'admin' && principal.role !== 'pm' && principal.role !== 'user') {
      jsonResponse(res, 403, { error: `${principal.role} may not restart the shared Bridge` });
      return { rejected: true };
    }
    return { principal, rejected: false };
  } catch (error) {
    const value = error as { message?: string; code?: string };
    jsonResponse(res, 401, {
      error: value.message ?? 'Invalid execution capability',
      ...(value.code ? { code: value.code } : {}),
    });
    return { rejected: true };
  }
}
