import type * as http from 'node:http';
import { getPeerRequestClaims } from '../peer-auth.js';
import type { AgentTeamExecutionPrincipal } from '../../agent-teams/governance-capability.js';
import {
  findScheduledTaskInScope,
  isAgentTeamCapabilityScheduleRoute,
  matchesScheduleScope,
  mayManageOwnSchedule,
} from '../../agent-teams/schedule-capability.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import type { RulesPackDispatchEnvelopeV1 } from '@metabot/rulespack';
import type { RulesPackExecutionPrincipal } from '@metabot/rulespack-adapter';
import { forwardAuthenticatedPeerTask } from '../../extensions/rulespack-peer-dispatch.js';

export async function handleTaskRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, scheduler, logger, peerManager, asyncTaskStore, circuitBreaker, budgetManager, ws } = ctx;
  const scheduleAuthorization: { principal?: AgentTeamExecutionPrincipal; rejected: boolean } =
    isAgentTeamCapabilityScheduleRoute(method, url)
      ? resolveScheduleAuthorization(ctx, req, res)
      : { rejected: false };
  if (scheduleAuthorization.rejected) return true;
  const schedulePrincipal = scheduleAuthorization.principal;

  // GET /api/talk/:taskId — async task status
  if (method === 'GET' && url.startsWith('/api/talk/')) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(url.slice('/api/talk/'.length).split('?')[0]);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid taskId' });
      return true;
    }
    if (!taskId) {
      jsonResponse(res, 400, { error: 'Missing taskId' });
      return true;
    }
    const task = asyncTaskStore.get(taskId);
    if (!task) {
      jsonResponse(res, 404, { error: 'Task not found' });
      return true;
    }
    const peerClaims = getPeerRequestClaims(req);
    if (peerClaims
      && (!task.requestIssuer
        || task.requestIssuer !== peerClaims.iss
        || task.requestSourceBot !== peerClaims.sourceBot
        || task.botName !== peerClaims.targetBot
        || task.chatId !== peerClaims.chatId
        || task.id !== peerClaims.taskId)) {
      jsonResponse(res, 403, { error: 'Forbidden', code: 'peer_task_scope_mismatch' });
      return true;
    }
    jsonResponse(res, 200, {
      taskId: task.id,
      status: task.status,
      botName: task.botName,
      chatId: task.chatId,
      createdAt: new Date(task.createdAt).toISOString(),
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
      result: task.result,
    });
    return true;
  }

  // POST /api/talk (primary) + POST /api/tasks (deprecated alias)
  if (method === 'POST' && (url === '/api/talk' || url === '/api/tasks')) {
    const body = await parseJsonBody(req);
    const rawBotName = body.botName as string;
    const chatId = body.chatId as string;
    const prompt = (typeof body.prompt === 'string' && body.prompt.trim())
      ? body.prompt as string
      : (body.content as string);
    const sendCards = body.sendCards as boolean | undefined;
    const asyncMode = body.async === true;
    const callbackChatId = body.callbackChatId as string | undefined;
    const callbackBotName = body.callbackBotName as string | undefined;
    const requestId = body.requestId as string | undefined;
    const peerClaims = getPeerRequestClaims(req);
    const dispatchEnvelope = body.rulesPackDispatch as RulesPackDispatchEnvelopeV1 | undefined;
    const dispatchIssuerHeader = singleHeader(req.headers['x-metabot-rulespack-issuer']);
    const dispatchOrigin = singleHeader(req.headers['x-metabot-origin']);
    const authenticatedDispatchIssuer = ctx.resolveRulesPackTransportIssuer?.(req);

    if (
      dispatchEnvelope &&
      (!dispatchIssuerHeader
        || dispatchOrigin !== 'peer'
        || authenticatedDispatchIssuer !== dispatchIssuerHeader
        || typeof dispatchEnvelope.issuer !== 'string'
        || dispatchEnvelope.issuer !== dispatchIssuerHeader)
    ) {
      jsonResponse(res, 400, { error: 'RulesPack dispatch requires authenticated peer transport headers' });
      return true;
    }
    if (!rawBotName || !chatId || !prompt) {
      jsonResponse(res, 400, { error: 'Missing required fields: botName, chatId, prompt or content' });
      return true;
    }

    // Parse qualified name: "peerName/botName" or just "botName"
    let targetPeerName: string | undefined;
    let botName: string;
    if (rawBotName.includes('/')) {
      const parts = rawBotName.split('/');
      targetPeerName = parts[0];
      botName = parts.slice(1).join('/');
    } else {
      botName = rawBotName;
    }
    let rulesPack: NonNullable<import('../../engines/prompt-context.js').ApiContext['rulesPack']>;
    let rulesPackPrincipal: RulesPackExecutionPrincipal;
    try {
      rulesPackPrincipal = ctx.resolveRulesPackApiPrincipal?.(req, {
        botName,
        chatId,
        ...(dispatchEnvelope ? { dispatch: dispatchEnvelope } : {}),
        declarations: {
          ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
          ...(typeof body.agentName === 'string' ? { agentName: body.agentName } : {}),
          ...(typeof body.workerId === 'string' ? { workerId: body.workerId } : {}),
          ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
          ...(Array.isArray(body.roles) ? { roles: body.roles as string[] } : {}),
          ...(Array.isArray(body.tools) ? { tools: body.tools as string[] } : {}),
          ...(Array.isArray(body.dataClasses) ? { dataClasses: body.dataClasses as string[] } : {}),
          ...(Array.isArray(body.outputTypes) ? { outputTypes: body.outputTypes as string[] } : {}),
        },
      }) ?? { kind: 'generic', source: 'core-bearer' as const };
      rulesPack = {
        principal: rulesPackPrincipal,
        ...(dispatchEnvelope
          ? { dispatch: { envelope: dispatchEnvelope, authenticatedIssuer: authenticatedDispatchIssuer! } }
          : {}),
      };
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }

    // If targeting a specific peer, skip local lookup
    if (targetPeerName) {
      if (!peerManager) {
        jsonResponse(res, 404, { error: `No peers configured, cannot resolve: ${rawBotName}` });
        return true;
      }
      const peerMatch = peerManager.findBotOnPeer(targetPeerName, botName);
      if (!peerMatch) {
        jsonResponse(res, 404, { error: `Bot not found on peer "${targetPeerName}": ${botName}` });
        return true;
      }
      logger.info({ botName, peerName: targetPeerName, chatId, promptLength: prompt.length }, 'Forwarding talk to peer (qualified)');
      try {
        const result = await forwardAuthenticatedPeerTask({
          registry,
          peerManager,
          peer: peerMatch.peer,
          peerBot: peerMatch.bot,
          principal: rulesPackPrincipal,
          body: { botName, chatId, prompt, sendCards, ...(dispatchEnvelope ? { rulesPackDispatch: dispatchEnvelope } : {}) },
        });
        const statusCode = (result as any).success === false ? 500 : 200;
        jsonResponse(res, statusCode, result);
      } catch (err: any) {
        logger.error({ err, botName, peerName: targetPeerName }, 'Peer forwarding failed');
        jsonResponse(res, 502, { error: `Peer forwarding failed: ${err.message}` });
      }
      return true;
    }

    // Try local registry first
    const bot = registry.get(botName);
    if (bot) {
      if (peerClaims && requestId) {
        const existing = asyncTaskStore.get(requestId);
        if (existing) {
          const sameRequest = existing.botName === botName
            && existing.chatId === chatId
            && existing.prompt === prompt
            && existing.requestIssuer === peerClaims.iss
            && existing.requestSourceBot === peerClaims.sourceBot
            && existing.requestBodySha256 === peerClaims.bodySha256;
          if (!sameRequest) {
            jsonResponse(res, 409, { error: 'Request ID already used', code: 'peer_request_conflict' });
            return true;
          }
          jsonResponse(res, 202, {
            taskId: existing.id,
            requestId: existing.id,
            status: existing.status,
            deduplicated: true,
          });
          return true;
        }
      }

      // Circuit breaker check
      if (!circuitBreaker.isAvailable(botName)) {
        jsonResponse(res, 503, { error: `Bot "${botName}" is temporarily unavailable (circuit open)` });
        return true;
      }

      // Budget check
      const budgetCheck = budgetManager.canAcceptTask(botName);
      if (!budgetCheck.allowed) {
        jsonResponse(res, 429, { error: budgetCheck.reason });
        return true;
      }

      logger.info({
        botName,
        chatId,
        promptLength: prompt.length,
        asyncMode,
        ...(requestId ? { requestId } : {}),
        ...(peerClaims ? { peerIssuer: peerClaims.iss, sourceBot: peerClaims.sourceBot } : {}),
      }, 'API talk request');

      // Async mode: accept immediately, execute in background
      if (asyncMode) {
        const asyncTask = asyncTaskStore.create({
          ...(peerClaims && requestId ? { id: requestId } : {}),
          botName, chatId, prompt, callbackChatId, callbackBotName,
          ...(peerClaims ? {
            requestIssuer: peerClaims.iss,
            requestSourceBot: peerClaims.sourceBot,
            requestBodySha256: peerClaims.bodySha256,
          } : {}),
        });

        (async () => {
          asyncTaskStore.update(asyncTask.id, { status: 'running' });
          try {
            const result = await bot.bridge.executeApiTask({
              prompt,
              chatId,
              userId: peerClaims ? `peer:${peerClaims.iss}/${peerClaims.sourceBot}` : 'api',
              sendCards: sendCards ?? true,
              ...(rulesPack ? { rulesPack } : {}),
            });
            asyncTaskStore.update(asyncTask.id, {
              status: result.success ? 'completed' : 'failed',
              completedAt: Date.now(),
              result: {
                success: result.success,
                responseText: result.responseText,
                costUsd: result.costUsd,
                durationMs: result.durationMs,
                error: result.error,
                ...(result.rulesPackDelivery ? { rulesPackDelivery: result.rulesPackDelivery } : {}),
              },
            });

            if (result.success) {
              circuitBreaker.recordSuccess(botName);
            } else {
              circuitBreaker.recordFailure(botName);
            }
            if (result.costUsd) {
              budgetManager.recordCost(botName, result.costUsd);
            }

            // Send callback if configured
            if (callbackChatId && callbackBotName) {
              const callbackBot = registry.get(callbackBotName);
              if (callbackBot) {
                const summary = result.responseText?.slice(0, 500) || 'Task completed';
                await callbackBot.bridge.executeApiTask({
                  prompt: `[Async task callback] Bot "${botName}" finished a task. Result: ${summary}`,
                  chatId: callbackChatId,
                  userId: 'system',
                  sendCards: true,
                  maxTurns: 1,
                });
              }
            }
          } catch (err: any) {
            circuitBreaker.recordFailure(botName);
            asyncTaskStore.update(asyncTask.id, {
              status: 'failed',
              completedAt: Date.now(),
              result: { success: false, responseText: '', error: err.message },
            });
          }
        })();

        jsonResponse(res, 202, {
          taskId: asyncTask.id,
          requestId: asyncTask.id,
          status: 'accepted',
          message: 'Task accepted for async execution',
        });
        return true;
      }

      // Sync mode with optional WS streaming
      const subs = ws.handle?.subscriptions;
      const hasWsSubscribers = subs && (subs.getSubscribers(chatId)?.size ?? 0) > 0;

      // Detect grouptalk chatId pattern: grouptalk-{groupId}-{botName}
      const grouptalkMatch = chatId.match(/^grouptalk-(.+)-[^-]+$/);
      const grouptalkGroupId = grouptalkMatch ? grouptalkMatch[1] : undefined;

      const result = await bot.bridge.executeApiTask({
        prompt,
        chatId,
        userId: 'api',
        sendCards: sendCards ?? true,
        ...(rulesPack ? { rulesPack } : {}),
        ...(hasWsSubscribers ? {
          onUpdate: (state, bridgeMessageId, final) => {
            const msgType = final ? 'complete' : 'state';
            subs!.broadcast(chatId, {
              type: msgType,
              chatId,
              messageId: bridgeMessageId,
              state,
              botName,
              ...(grouptalkGroupId ? { groupId: grouptalkGroupId } : {}),
            });
          },
        } : {}),
      });

      if (result.success) {
        circuitBreaker.recordSuccess(botName);
      } else {
        circuitBreaker.recordFailure(botName);
      }
      if (result.costUsd) {
        budgetManager.recordCost(botName, result.costUsd);
      }

      jsonResponse(res, result.success ? 200 : 500, result);
      return true;
    }

    // Bot not found locally — check peers
    const origin = req.headers['x-metabot-origin'];
    if (!origin && peerManager) {
      const peerMatch = peerManager.findBotPeer(botName);
      if (peerMatch) {
        logger.info({ botName, peerName: peerMatch.peer.name, peerUrl: peerMatch.peer.url, chatId, promptLength: prompt.length }, 'Forwarding talk to peer');
        try {
          const result = await forwardAuthenticatedPeerTask({
            registry,
            peerManager,
            peer: peerMatch.peer,
            peerBot: peerMatch.bot,
            principal: rulesPackPrincipal,
            body: { botName, chatId, prompt, sendCards, ...(dispatchEnvelope ? { rulesPackDispatch: dispatchEnvelope } : {}) },
          });
          const statusCode = (result as any).success === false ? 500 : 200;
          jsonResponse(res, statusCode, result);
        } catch (err: any) {
          logger.error({ err, botName, peerUrl: peerMatch.peer.url }, 'Peer forwarding failed');
          jsonResponse(res, 502, { error: `Peer forwarding failed: ${err.message}` });
        }
        return true;
      }
    }

    jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
    return true;
  }

  // POST /api/schedule
  if (method === 'POST' && url === '/api/schedule') {
    const body = await parseJsonBody(req);
    const botName = body.botName as string;
    const chatId = body.chatId as string;
    const prompt = body.prompt as string;
    const cronExpr = body.cronExpr as string | undefined;
    const delaySeconds = body.delaySeconds as number | undefined;
    const sendCards = body.sendCards as boolean | undefined;
    const label = body.label as string | undefined;
    const timezone = body.timezone as string | undefined;

    if (!botName || !chatId || !prompt) {
      jsonResponse(res, 400, { error: 'Missing required fields: botName, chatId, prompt' });
      return true;
    }

    if (schedulePrincipal && !matchesScheduleScope(schedulePrincipal, { botName, chatId })) {
      jsonResponse(res, 403, { error: 'A signed engine session may schedule only for its own bot and chat' });
      return true;
    }

    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }

    if (cronExpr) {
      const recurring = scheduler.scheduleRecurring({
        botName, chatId, prompt, cronExpr, timezone, sendCards, label,
      });
      jsonResponse(res, 201, {
        id: recurring.id, type: 'recurring', botName: recurring.botName,
        chatId: recurring.chatId, prompt: recurring.prompt, cronExpr: recurring.cronExpr,
        timezone: recurring.timezone, nextExecuteAt: new Date(recurring.nextExecuteAt).toISOString(),
        sendCards: recurring.sendCards, label: recurring.label, status: recurring.status,
      });
    } else if (typeof delaySeconds === 'number' && delaySeconds > 0) {
      const task = scheduler.scheduleTask({ botName, chatId, prompt, delaySeconds, sendCards, label });
      jsonResponse(res, 201, {
        id: task.id, type: 'one-time', botName: task.botName, chatId: task.chatId,
        prompt: task.prompt, executeAt: new Date(task.executeAt).toISOString(),
        sendCards: task.sendCards, label: task.label, status: task.status,
      });
    } else {
      jsonResponse(res, 400, { error: 'Provide either cronExpr (recurring) or delaySeconds (one-time, positive number)' });
    }
    return true;
  }

  // GET /api/schedule
  if (method === 'GET' && url === '/api/schedule') {
    const tasks = scheduler.listTasks().filter((task) => (
      !schedulePrincipal || matchesScheduleScope(schedulePrincipal, task)
    )).map((t) => ({
      id: t.id, type: 'one-time', botName: t.botName, chatId: t.chatId,
      prompt: t.prompt, executeAt: new Date(t.executeAt).toISOString(),
      sendCards: t.sendCards, label: t.label, status: t.status, createdAt: new Date(t.createdAt).toISOString(),
    }));
    const recurringTasks = scheduler.listRecurringTasks().filter((task) => (
      !schedulePrincipal || matchesScheduleScope(schedulePrincipal, task)
    )).map((r) => ({
      id: r.id, type: 'recurring', botName: r.botName, chatId: r.chatId,
      prompt: r.prompt, cronExpr: r.cronExpr, timezone: r.timezone,
      nextExecuteAt: new Date(r.nextExecuteAt).toISOString(),
      lastExecutedAt: r.lastExecutedAt ? new Date(r.lastExecutedAt).toISOString() : null,
      sendCards: r.sendCards, label: r.label, status: r.status, createdAt: new Date(r.createdAt).toISOString(),
    }));
    jsonResponse(res, 200, { tasks, recurringTasks });
    return true;
  }

  // POST /api/schedule/:id/pause
  if (method === 'POST' && /^\/api\/schedule\/[^/]+\/pause$/.test(url)) {
    const id = url.split('/')[3];
    if (schedulePrincipal && !isScheduledTaskInScope(ctx, id, schedulePrincipal)) {
      jsonResponse(res, 404, { error: `Recurring task not found or not pausable: ${id}` });
      return true;
    }
    const paused = scheduler.pauseRecurring(id);
    jsonResponse(res, paused ? 200 : 404, paused ? { id, status: 'paused' } : { error: `Recurring task not found or not pausable: ${id}` });
    return true;
  }

  // POST /api/schedule/:id/resume
  if (method === 'POST' && /^\/api\/schedule\/[^/]+\/resume$/.test(url)) {
    const id = url.split('/')[3];
    if (schedulePrincipal && !isScheduledTaskInScope(ctx, id, schedulePrincipal)) {
      jsonResponse(res, 404, { error: `Recurring task not found or not resumable: ${id}` });
      return true;
    }
    const resumed = scheduler.resumeRecurring(id);
    if (resumed) {
      const recurring = scheduler.getRecurringTask(id);
      jsonResponse(res, 200, { id, status: 'active', nextExecuteAt: recurring ? new Date(recurring.nextExecuteAt).toISOString() : null });
    } else {
      jsonResponse(res, 404, { error: `Recurring task not found or not resumable: ${id}` });
    }
    return true;
  }

  // PATCH /api/schedule/:id
  if (method === 'PATCH' && url.startsWith('/api/schedule/')) {
    const id = url.slice('/api/schedule/'.length);
    if (!id) {
      jsonResponse(res, 400, { error: 'Missing task ID' });
      return true;
    }

    if (schedulePrincipal && !isScheduledTaskInScope(ctx, id, schedulePrincipal)) {
      jsonResponse(res, 404, { error: `Task not found or not updatable: ${id}` });
      return true;
    }

    const body = await parseJsonBody(req);

    const updated = scheduler.updateTask(id, {
      prompt: body.prompt as string | undefined,
      delaySeconds: body.delaySeconds as number | undefined,
      label: body.label as string | undefined,
      sendCards: body.sendCards as boolean | undefined,
    });

    if (updated) {
      jsonResponse(res, 200, {
        id: updated.id, type: 'one-time', botName: updated.botName, chatId: updated.chatId,
        prompt: updated.prompt, executeAt: new Date(updated.executeAt).toISOString(),
        sendCards: updated.sendCards, label: updated.label, status: updated.status,
      });
      return true;
    }

    const updatedRecurring = scheduler.updateRecurring(id, {
      prompt: body.prompt as string | undefined,
      cronExpr: body.cronExpr as string | undefined,
      timezone: body.timezone as string | undefined,
      label: body.label as string | undefined,
      sendCards: body.sendCards as boolean | undefined,
    });

    if (updatedRecurring) {
      jsonResponse(res, 200, {
        id: updatedRecurring.id, type: 'recurring', botName: updatedRecurring.botName,
        chatId: updatedRecurring.chatId, prompt: updatedRecurring.prompt,
        cronExpr: updatedRecurring.cronExpr, timezone: updatedRecurring.timezone,
        nextExecuteAt: new Date(updatedRecurring.nextExecuteAt).toISOString(),
        sendCards: updatedRecurring.sendCards, label: updatedRecurring.label, status: updatedRecurring.status,
      });
      return true;
    }

    jsonResponse(res, 404, { error: `Task not found or not updatable: ${id}` });
    return true;
  }

  // DELETE /api/schedule/:id
  if (method === 'DELETE' && url.startsWith('/api/schedule/')) {
    const id = url.slice('/api/schedule/'.length);
    if (!id) {
      jsonResponse(res, 400, { error: 'Missing task ID' });
      return true;
    }

    if (schedulePrincipal && !isScheduledTaskInScope(ctx, id, schedulePrincipal)) {
      jsonResponse(res, 404, { error: `Task not found or not cancellable: ${id}` });
      return true;
    }

    const cancelled = scheduler.cancelTask(id);
    if (cancelled) {
      jsonResponse(res, 200, { id, type: 'one-time', status: 'cancelled' });
      return true;
    }

    const cancelledRecurring = scheduler.cancelRecurring(id);
    if (cancelledRecurring) {
      jsonResponse(res, 200, { id, type: 'recurring', status: 'cancelled' });
      return true;
    }

    jsonResponse(res, 404, { error: `Task not found or not cancellable: ${id}` });
    return true;
  }

  return false;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveScheduleAuthorization(
  ctx: RouteContext,
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
    if (!mayManageOwnSchedule(principal)) {
      jsonResponse(res, 403, { error: `${principal.role} may not manage scheduled tasks` });
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

function isScheduledTaskInScope(
  ctx: RouteContext,
  id: string,
  principal: AgentTeamExecutionPrincipal,
): boolean {
  return !!findScheduledTaskInScope(
    id,
    principal,
    ctx.scheduler.listTasks(),
    ctx.scheduler.listRecurringTasks(),
  );
}
