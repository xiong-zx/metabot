import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleTaskRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, scheduler, logger, peerManager, asyncTaskStore, circuitBreaker, budgetManager, ws } = ctx;
  const requestUrl = new URL(url, 'http://localhost');
  const pathname = requestUrl.pathname;

  // GET /api/talk/:taskId — async task status
  if (method === 'GET' && pathname.startsWith('/api/talk/')) {
    const taskId = pathname.slice('/api/talk/'.length);
    if (!taskId) {
      jsonResponse(res, 400, { error: 'Missing taskId' });
      return true;
    }
    const task = asyncTaskStore.get(taskId);
    if (!task) {
      jsonResponse(res, 404, taskNotFoundResponse(taskId));
      return true;
    }
    jsonResponse(res, 200, taskStatusResponse(task));
    return true;
  }

  // POST /api/talk (primary) + POST /api/tasks (deprecated alias)
  if (method === 'POST' && (pathname === '/api/talk' || pathname === '/api/tasks')) {
    const body = await parseJsonBody(req);
    const rawBotName = body.botName as string;
    const chatId = body.chatId as string;
    const prompt =
      typeof body.prompt === 'string' && body.prompt.trim() ? (body.prompt as string) : (body.content as string);
    const sendCards = body.sendCards as boolean | undefined;
    const asyncMode = body.async === true || requestUrl.searchParams.get('async') === 'true';
    const waitMs = parseWaitMs(body.waitMs, requestUrl.searchParams.get('waitMs'));
    const callbackChatId = body.callbackChatId as string | undefined;
    const callbackBotName = body.callbackBotName as string | undefined;

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
      logger.info(
        { botName, peerName: targetPeerName, chatId, promptLength: prompt.length },
        'Forwarding talk to peer (qualified)',
      );
      try {
        const result = await peerManager.forwardTask(peerMatch.peer, { botName, chatId, prompt, sendCards });
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

      logger.info({ botName, chatId, promptLength: prompt.length, asyncMode }, 'API talk request');

      // Async mode: accept immediately, execute in background. If waitMs is
      // supplied, keep the HTTP request open briefly and return the final
      // result when it finishes fast; otherwise return 202 with a status URL.
      if (asyncMode || waitMs > 0) {
        const asyncTask = asyncTaskStore.create({
          botName,
          chatId,
          prompt,
          callbackChatId,
          callbackBotName,
        });

        const taskPromise = runTalkAsyncTask({
          asyncTaskId: asyncTask.id,
          bot,
          botName,
          chatId,
          prompt,
          sendCards: sendCards ?? true,
          callbackChatId,
          callbackBotName,
          registry,
          asyncTaskStore,
          circuitBreaker,
          budgetManager,
        });

        if (waitMs > 0) {
          const finished = await waitForTalkTask(taskPromise, waitMs);
          const current = asyncTaskStore.get(asyncTask.id);
          if (finished && current?.result) {
            jsonResponse(res, statusForTalkResult(current.result), {
              taskId: asyncTask.id,
              status: current.status,
              ...current.result,
            });
            return true;
          }
        }

        jsonResponse(res, 202, acceptedTalkTaskResponse(asyncTask.id, asyncTask.status, prompt));
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
        ...(hasWsSubscribers
          ? {
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
            }
          : {}),
      });

      if (result.success) {
        circuitBreaker.recordSuccess(botName);
      } else {
        circuitBreaker.recordFailure(botName);
      }
      if (result.costUsd) {
        budgetManager.recordCost(botName, result.costUsd);
      }

      jsonResponse(res, statusForTalkResult(result), result);
      return true;
    }

    // Bot not found locally — check peers
    const origin = req.headers['x-metabot-origin'];
    if (!origin && peerManager) {
      const peerMatch = peerManager.findBotPeer(botName);
      if (peerMatch) {
        logger.info(
          { botName, peerName: peerMatch.peer.name, peerUrl: peerMatch.peer.url, chatId, promptLength: prompt.length },
          'Forwarding talk to peer',
        );
        try {
          const result = await peerManager.forwardTask(peerMatch.peer, { botName, chatId, prompt, sendCards });
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

    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }

    if (cronExpr) {
      const recurring = scheduler.scheduleRecurring({
        botName,
        chatId,
        prompt,
        cronExpr,
        timezone,
        sendCards,
        label,
      });
      jsonResponse(res, 201, {
        id: recurring.id,
        type: 'recurring',
        botName: recurring.botName,
        chatId: recurring.chatId,
        prompt: recurring.prompt,
        cronExpr: recurring.cronExpr,
        timezone: recurring.timezone,
        nextExecuteAt: new Date(recurring.nextExecuteAt).toISOString(),
        sendCards: recurring.sendCards,
        label: recurring.label,
        status: recurring.status,
      });
    } else if (typeof delaySeconds === 'number' && delaySeconds > 0) {
      const task = scheduler.scheduleTask({ botName, chatId, prompt, delaySeconds, sendCards, label });
      jsonResponse(res, 201, {
        id: task.id,
        type: 'one-time',
        botName: task.botName,
        chatId: task.chatId,
        prompt: task.prompt,
        executeAt: new Date(task.executeAt).toISOString(),
        sendCards: task.sendCards,
        label: task.label,
        status: task.status,
      });
    } else {
      jsonResponse(res, 400, {
        error: 'Provide either cronExpr (recurring) or delaySeconds (one-time, positive number)',
      });
    }
    return true;
  }

  // GET /api/schedule
  if (method === 'GET' && url === '/api/schedule') {
    const tasks = scheduler.listTasks().map((t) => ({
      id: t.id,
      type: 'one-time',
      botName: t.botName,
      chatId: t.chatId,
      prompt: t.prompt,
      executeAt: new Date(t.executeAt).toISOString(),
      sendCards: t.sendCards,
      label: t.label,
      status: t.status,
      createdAt: new Date(t.createdAt).toISOString(),
    }));
    const recurringTasks = scheduler.listRecurringTasks().map((r) => ({
      id: r.id,
      type: 'recurring',
      botName: r.botName,
      chatId: r.chatId,
      prompt: r.prompt,
      cronExpr: r.cronExpr,
      timezone: r.timezone,
      nextExecuteAt: new Date(r.nextExecuteAt).toISOString(),
      lastExecutedAt: r.lastExecutedAt ? new Date(r.lastExecutedAt).toISOString() : null,
      sendCards: r.sendCards,
      label: r.label,
      status: r.status,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
    jsonResponse(res, 200, { tasks, recurringTasks });
    return true;
  }

  // POST /api/schedule/:id/pause
  if (method === 'POST' && /^\/api\/schedule\/[^/]+\/pause$/.test(url)) {
    const id = url.split('/')[3];
    const paused = scheduler.pauseRecurring(id);
    jsonResponse(
      res,
      paused ? 200 : 404,
      paused ? { id, status: 'paused' } : { error: `Recurring task not found or not pausable: ${id}` },
    );
    return true;
  }

  // POST /api/schedule/:id/resume
  if (method === 'POST' && /^\/api\/schedule\/[^/]+\/resume$/.test(url)) {
    const id = url.split('/')[3];
    const resumed = scheduler.resumeRecurring(id);
    if (resumed) {
      const recurring = scheduler.getRecurringTask(id);
      jsonResponse(res, 200, {
        id,
        status: 'active',
        nextExecuteAt: recurring ? new Date(recurring.nextExecuteAt).toISOString() : null,
      });
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

    const body = await parseJsonBody(req);

    const updated = scheduler.updateTask(id, {
      prompt: body.prompt as string | undefined,
      delaySeconds: body.delaySeconds as number | undefined,
      label: body.label as string | undefined,
      sendCards: body.sendCards as boolean | undefined,
    });

    if (updated) {
      jsonResponse(res, 200, {
        id: updated.id,
        type: 'one-time',
        botName: updated.botName,
        chatId: updated.chatId,
        prompt: updated.prompt,
        executeAt: new Date(updated.executeAt).toISOString(),
        sendCards: updated.sendCards,
        label: updated.label,
        status: updated.status,
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
        id: updatedRecurring.id,
        type: 'recurring',
        botName: updatedRecurring.botName,
        chatId: updatedRecurring.chatId,
        prompt: updatedRecurring.prompt,
        cronExpr: updatedRecurring.cronExpr,
        timezone: updatedRecurring.timezone,
        nextExecuteAt: new Date(updatedRecurring.nextExecuteAt).toISOString(),
        sendCards: updatedRecurring.sendCards,
        label: updatedRecurring.label,
        status: updatedRecurring.status,
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

function parseWaitMs(bodyValue: unknown, queryValue: string | null): number {
  const raw = bodyValue ?? queryValue;
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 25_000);
}

function acceptedTalkTaskResponse(taskId: string, status: string, prompt?: string): Record<string, unknown> {
  const preflight = prompt === undefined ? undefined : taskPreflightFromPrompt(prompt);
  const phasedProgress = preflight === undefined ? undefined : taskProgress(preflight, 0, 2000);
  return {
    taskId,
    status,
    phase: acceptedPhase(status, preflight),
    progress: phasedProgress ?? {
      kind: 'indeterminate',
      elapsedMs: 0,
      retryAfterMs: 2000,
    },
    ...(preflight?.runId === undefined ? {} : { runId: preflight.runId }),
    message: 'Task accepted for async execution',
    statusUrl: `/api/talk/${encodeURIComponent(taskId)}`,
    statusCommand: `metabot talk-status ${taskId}`,
    retryAfterMs: 2000,
    nextAction:
      preflight === undefined
        ? `Run metabot talk-status ${taskId} after 2s to check progress.`
        : taskNextAction(taskId, preflight, 0),
    ...(preflight === undefined ? {} : { preflight }),
  };
}

function taskStatusResponse(task: {
  id: string;
  status: string;
  botName: string;
  chatId: string;
  prompt: string;
  createdAt: number;
  completedAt?: number;
  result?: unknown;
}): Record<string, unknown> {
  const now = Date.now();
  const finished = task.completedAt ?? now;
  const elapsedMs = Math.max(0, finished - task.createdAt);
  const running = task.status === 'accepted' || task.status === 'running';
  const retryAfterMs = running ? 2000 : undefined;
  const preflight = taskPreflightFromPrompt(task.prompt);
  const terminalProgress = running ? undefined : terminalTaskProgress(task.status, preflight, elapsedMs, task.result);
  return {
    taskId: task.id,
    status: task.status,
    phase: running ? runningPhase(task.status, preflight) : terminalPhase(task.status, preflight),
    progress: running
      ? preflight === undefined
        ? {
            kind: 'indeterminate',
            elapsedMs,
            retryAfterMs,
          }
        : taskProgress(preflight, elapsedMs, retryAfterMs)
      : terminalProgress,
    ...(preflight?.runId === undefined ? {} : { runId: preflight.runId }),
    ...(!running && preflight?.kind === 'autoresearchclaw' ? { finalPhase: task.status } : {}),
    botName: task.botName,
    chatId: task.chatId,
    createdAt: new Date(task.createdAt).toISOString(),
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
    elapsedMs,
    statusUrl: `/api/talk/${encodeURIComponent(task.id)}`,
    statusCommand: `metabot talk-status ${task.id}`,
    retryAfterMs,
    message: running ? runningMessage(preflight, elapsedMs) : terminalMessage(task.status, preflight),
    nextAction: running
      ? preflight === undefined
        ? `Run metabot talk-status ${task.id} again after 2s. For AutoResearchClaw tasks, also ask for the matching Memory Core run status.`
        : taskNextAction(task.id, preflight, elapsedMs)
      : terminalNextAction(preflight),
    ...(preflight === undefined ? {} : { preflight }),
    result: task.result,
  };
}

function taskNotFoundResponse(taskId: string): Record<string, unknown> {
  return {
    taskId,
    status: 'not_found',
    phase: 'not_found',
    progress: {
      kind: 'unavailable',
    },
    statusUrl: `/api/talk/${encodeURIComponent(taskId)}`,
    statusCommand: `metabot talk-status ${taskId}`,
    error: 'Task not found or no longer retained',
    message:
      'Task status is unavailable. The task may never have existed, may have expired after retention, or may have been lost before persistence during service restart.',
    nextAction:
      'If this was a wake/check request, resend it with metabot talk --wait-ms so the response is observed directly. For AutoResearchClaw tasks, inspect the Memory Core run lifecycle if a run id was returned.',
  };
}

function taskStatusPhase(status: string): string {
  if (status === 'accepted') return 'accepted';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return status;
}

function taskPreflightFromPrompt(prompt: string): Record<string, unknown> | undefined {
  return researchLoopPreflightFromPrompt(prompt) ?? memoryOperationPreflightFromPrompt(prompt);
}

function acceptedPhase(status: string, preflight: Record<string, unknown> | undefined): string {
  if (preflight?.kind === 'autoresearchclaw') return 'autoresearchclaw_accepted';
  if (preflight?.kind === 'memory_core') return 'memory_operation_accepted';
  return taskStatusPhase(status);
}

function runningPhase(status: string, preflight: Record<string, unknown> | undefined): string {
  if (preflight?.kind === 'autoresearchclaw') return 'autoresearchclaw_running';
  if (preflight?.kind === 'memory_core') return 'memory_operation_running';
  return taskStatusPhase(status);
}

function terminalPhase(status: string, preflight: Record<string, unknown> | undefined): string {
  if (preflight?.kind === 'autoresearchclaw') return `autoresearchclaw_${status}`;
  if (preflight?.kind === 'memory_core') return `memory_operation_${status}`;
  return taskStatusPhase(status);
}

function terminalTaskProgress(
  status: string,
  preflight: Record<string, unknown> | undefined,
  elapsedMs: number,
  result?: unknown,
): Record<string, unknown> {
  if (preflight?.kind !== 'autoresearchclaw') {
    return {
      kind: 'complete',
      elapsedMs,
    };
  }
  const terminalNext = terminalNextAction(preflight);
  const resultRecord = isRecord(result) ? result : undefined;
  const errorMessage = typeof resultRecord?.error === 'string' ? resultRecord.error : undefined;
  const errorCode = typeof resultRecord?.errorCode === 'string' ? resultRecord.errorCode : undefined;
  return {
    kind: 'phased',
    currentPhase: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status,
    finalPhase: status,
    elapsedMs,
    projectId: preflight.projectId,
    runId: preflight.runId,
    projectRoot: preflight.projectRoot,
    domain: preflight.domain,
    stages: preflight.stages,
    ingestReviewPhase: {
      phase: 'ingest_review',
      status: status === 'completed' ? 'memory_core_system_of_record_required' : 'not_asserted_async_failed',
      systemOfRecord: 'memory_core',
      description:
        'The async talk lifecycle cannot certify ingest/review; inspect the Memory Core research run lifecycle for the authoritative outcome.',
    },
    memoryCoreSystemOfRecord: {
      status: 'inspect_required',
      runId: preflight.runId,
      projectId: preflight.projectId,
      projectRoot: preflight.projectRoot,
      domain: preflight.domain,
    },
    ...(status === 'completed'
      ? {
          finalization: {
            status: 'async_task_completed',
            systemOfRecord: 'memory_core',
          },
        }
      : {
          error: {
            status: 'async_task_failed',
            ...(errorCode === undefined ? {} : { code: errorCode }),
            ...(errorMessage === undefined ? {} : { message: errorMessage }),
          },
        }),
    nextAction: terminalNext,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function terminalMessage(status: string, preflight: Record<string, unknown> | undefined): string {
  if (preflight?.kind === 'autoresearchclaw') {
    return status === 'completed'
      ? 'AutoResearchClaw async execution completed. Memory Core remains the system of record for the research run and ingest/review outcome.'
      : 'AutoResearchClaw async execution failed. Inspect the task error and the Memory Core run lifecycle for any collected artifact or partial ingest evidence.';
  }
  return 'Task finished. See result for the final response or error.';
}

function terminalNextAction(preflight: Record<string, unknown> | undefined): string {
  if (
    preflight?.kind === 'autoresearchclaw' &&
    typeof preflight.projectRoot === 'string' &&
    typeof preflight.projectId === 'string'
  ) {
    const runHint = typeof preflight.runId === 'string' ? ` and locate run ${preflight.runId}` : '';
    return `Inspect the Memory Core system-of-record with metabot research runs --root ${preflight.projectRoot} --project ${preflight.projectId}${runHint}; inspect result for the async response or error.`;
  }
  if (preflight?.kind === 'autoresearchclaw') {
    return 'Inspect result for the async response or error, then query the matching Memory Core run lifecycle using its project root and project id.';
  }
  return 'Inspect result for the final response or error.';
}

function runningMessage(preflight: Record<string, unknown> | undefined, elapsedMs: number): string {
  if (preflight?.kind === 'autoresearchclaw') {
    return 'AutoResearchClaw task is running. Progress includes the accepted project/run context and planned research stages.';
  }
  if (preflight?.kind === 'memory_core') {
    if (elapsedMs >= memoryTimeoutBoundaryMs(preflight)) {
      return 'Memory Core operation exceeded the expected async window. Progress includes a timeout boundary and partial-evidence next action.';
    }
    if (elapsedMs >= memoryExpectedCompletionMs(preflight)) {
      return 'Memory Core operation passed its expected completion window but is still below the timeout boundary. Progress includes partial-evidence guidance.';
    }
    return 'Memory Core operation is running. Progress includes write/search/context-pack and pending review stages.';
  }
  return 'Task is still running. Check statusUrl again later; long research tasks may expose more detail in their Memory Core run lifecycle.';
}

function researchLoopPreflightFromPrompt(prompt: string): Record<string, unknown> | undefined {
  if (!/\b(AutoResearchClaw|research\s+loop|自动科研|研究循环)\b/i.test(prompt)) return undefined;
  const projectId = extractPromptField(prompt, ['projectId', 'project_id', '项目ID', '项目']);
  const projectRoot = extractPromptField(prompt, ['projectRoot', 'project_root', 'root', '项目目录']);
  const runId = extractPromptField(prompt, ['runId', 'run_id', '运行ID', '运行']);
  const domain = extractPromptField(prompt, ['domain', '领域']);
  return {
    kind: 'autoresearchclaw',
    summary: 'AutoResearchClaw research loop request accepted by the bot bus.',
    projectId,
    runId,
    projectRoot,
    domain,
    stages: [
      { phase: 'context_pack', status: 'planned', description: 'Build a Memory Core context pack before dispatch.' },
      { phase: 'worker_dispatch', status: 'planned', description: 'Dispatch AutoResearchClaw through WorkerManager.' },
      {
        phase: 'output_contract',
        status: 'required',
        description: 'Require autoresearchclaw.output.v2 JSON artifact.',
      },
      {
        phase: 'ingest_review',
        status: 'planned',
        description: 'Validate artifact, then ingest or stage candidate memory.',
      },
    ],
    outputContract: [
      'contract_version',
      'project_id',
      'run_id',
      'status',
      'summary',
      'hypotheses',
      'experiments',
      'findings',
      'negative_results',
      'decisions',
      'artifacts',
      'open_questions',
      'memory_event_candidates',
      'recommended_followups',
      'tool_trace',
    ],
    completionCriteria: [
      'worker writes a valid autoresearchclaw.output.v2 artifact',
      'run lifecycle reaches completed, partial, or failed',
      'ingest/review result is traceable by memory/event ids',
    ],
    nextAction: `Run metabot talk-status for this task id; if a run id is returned, inspect Memory Core run lifecycle with metabot research runs.`,
  };
}

function memoryOperationPreflightFromPrompt(prompt: string): Record<string, unknown> | undefined {
  if (!isMemoryOperationPrompt(prompt)) return undefined;
  const projectId = extractPromptField(prompt, ['projectId', 'project_id', '项目ID', '项目']);
  const projectRoot = extractPromptField(prompt, ['projectRoot', 'project_root', 'root', '项目目录']);
  const domain = extractPromptField(prompt, ['domain', '领域']);
  return {
    kind: 'memory_core',
    summary: 'Memory Core operation request accepted by the bot bus.',
    operation: classifyMemoryOperation(prompt),
    projectId,
    projectRoot,
    domain,
    expectedCompletionMs: 120_000,
    timeoutBoundaryMs: 150_000,
    stages: [
      {
        phase: 'scope_parse',
        status: 'planned',
        description: 'Resolve projectId, projectRoot, domain, and allowed Memory Core root.',
      },
      {
        phase: 'memory_write',
        status: 'planned',
        description: 'Create requested finding, decision, candidate, or promotion request events.',
      },
      {
        phase: 'pending_review',
        status: 'planned',
        description: 'Keep candidate or promotion approval pending unless approval was explicitly requested.',
      },
      {
        phase: 'search_context_pack',
        status: 'planned',
        description: 'Search Memory Core and build a context pack with traceable ids.',
      },
      {
        phase: 'finalize',
        status: 'planned',
        description: 'Return concise event ids, unit ids, contextPack id, pending status, and rough latency.',
      },
      {
        phase: 'timeout_boundary',
        status: 'boundary',
        description: 'If this boundary is reached, return partial evidence or split the memory operation.',
      },
    ],
    completionCriteria: [
      'finding and decision writes return event ids and derived memory unit ids',
      'candidate or promotion approval remains pending unless explicitly approved',
      'search returns the requested finding',
      'context pack returns a contextPack id and does not inject rejected/superseded memory',
      'rough latency or timeout boundary is visible to the user',
    ],
    nextAction:
      'Run metabot talk-status for this task id; if it exceeds the timeout boundary, ask the bot to return partial event/context-pack evidence or split the operation.',
  };
}

function isMemoryOperationPrompt(prompt: string): boolean {
  if (
    !/\b(Memory Core|Research Memory|context[-\s]?pack|memory unit|memory units|promotion approval|candidate\/promotion|candidate memory|MetaBot 2\.0 memory|记忆|候选|审批)\b/i.test(
      prompt,
    )
  ) {
    return false;
  }
  return /\b(projectId|projectRoot|Memory Core|Research Memory|context[-\s]?pack|promotion|candidate|finding|decision)\b/i.test(
    prompt,
  );
}

function classifyMemoryOperation(prompt: string): string {
  if (/\b(context[-\s]?pack|search)\b/i.test(prompt)) return 'write_search_context_pack';
  if (/\b(promotion|approval|candidate|review)\b/i.test(prompt)) return 'write_pending_review';
  if (/\b(write|create|finding|decision)\b/i.test(prompt)) return 'write_memory';
  return 'memory_operation';
}

function extractPromptField(prompt: string, names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = prompt.matchAll(new RegExp(`${escaped}\\s*[=:：是]\\s*([^\\s,，。;；、]+)`, 'giu'));
    for (const match of matches) {
      if (!match[1]) continue;
      const sanitized = sanitizePromptField(match[1]);
      if (sanitized.length > 0) return sanitized;
    }
  }
  return undefined;
}

function sanitizePromptField(value: string): string {
  return value.trim().replace(/[.,，。;；:：、]+$/u, '');
}

function researchTaskProgress(
  preflight: Record<string, unknown>,
  elapsedMs: number,
  retryAfterMs: number | undefined,
): Record<string, unknown> {
  return {
    kind: 'phased',
    currentPhase: 'worker_dispatch',
    elapsedMs,
    retryAfterMs,
    projectId: preflight.projectId,
    runId: preflight.runId,
    projectRoot: preflight.projectRoot,
    domain: preflight.domain,
    stages: preflight.stages,
  };
}

function taskProgress(
  preflight: Record<string, unknown>,
  elapsedMs: number,
  retryAfterMs: number | undefined,
): Record<string, unknown> {
  if (preflight.kind === 'memory_core') {
    return memoryTaskProgress(preflight, elapsedMs, retryAfterMs);
  }
  return researchTaskProgress(preflight, elapsedMs, retryAfterMs);
}

function memoryTaskProgress(
  preflight: Record<string, unknown>,
  elapsedMs: number,
  retryAfterMs: number | undefined,
): Record<string, unknown> {
  return {
    kind: 'phased',
    currentPhase: memoryCurrentPhase(elapsedMs, preflight),
    elapsedMs,
    retryAfterMs,
    projectId: preflight.projectId,
    projectRoot: preflight.projectRoot,
    domain: preflight.domain,
    operation: preflight.operation,
    expectedCompletionMs: preflight.expectedCompletionMs,
    timeoutBoundaryMs: preflight.timeoutBoundaryMs,
    stages: preflight.stages,
  };
}

function memoryCurrentPhase(elapsedMs: number, preflight: Record<string, unknown>): string {
  if (elapsedMs >= memoryTimeoutBoundaryMs(preflight)) return 'timeout_boundary';
  if (elapsedMs >= memoryExpectedCompletionMs(preflight)) return 'expected_completion_overdue';
  if (elapsedMs >= 90_000) return 'pending_review';
  if (elapsedMs >= 30_000) return 'search_context_pack';
  if (elapsedMs >= 5_000) return 'memory_write';
  return 'scope_parse';
}

function memoryExpectedCompletionMs(preflight: Record<string, unknown>): number {
  return typeof preflight.expectedCompletionMs === 'number' ? preflight.expectedCompletionMs : 120_000;
}

function memoryTimeoutBoundaryMs(preflight: Record<string, unknown>): number {
  return typeof preflight.timeoutBoundaryMs === 'number' ? preflight.timeoutBoundaryMs : 150_000;
}

function researchNextAction(taskId: string, preflight: Record<string, unknown>): string {
  if (typeof preflight.projectRoot === 'string' && typeof preflight.projectId === 'string') {
    return `Run metabot talk-status ${taskId} again after 2s, or inspect Memory Core with metabot research runs --root ${preflight.projectRoot} --project ${preflight.projectId}.`;
  }
  return `Run metabot talk-status ${taskId} again after 2s; inspect Memory Core run lifecycle when project root and project id are known.`;
}

function taskNextAction(taskId: string, preflight: Record<string, unknown>, elapsedMs: number): string {
  if (preflight.kind === 'memory_core') {
    return memoryNextAction(taskId, preflight, elapsedMs);
  }
  return researchNextAction(taskId, preflight);
}

function memoryNextAction(taskId: string, preflight: Record<string, unknown>, elapsedMs: number): string {
  if (elapsedMs >= memoryTimeoutBoundaryMs(preflight)) {
    return `Run metabot talk-status ${taskId} once more, then ask the bot to return partial Memory Core evidence or split the operation if it is still running.`;
  }
  if (elapsedMs >= memoryExpectedCompletionMs(preflight)) {
    return `Run metabot talk-status ${taskId} again after 2s; if still running, ask for partial Memory Core evidence already created, then let finalization continue or split the remaining work.`;
  }
  if (typeof preflight.projectRoot === 'string' && typeof preflight.projectId === 'string') {
    return `Run metabot talk-status ${taskId} again after 2s; for evidence, inspect Memory Core with metabot research events/search/context-pack --root ${preflight.projectRoot} --project ${preflight.projectId}.`;
  }
  return `Run metabot talk-status ${taskId} again after 2s; ask for event ids, unit ids, pending review status, and contextPack id.`;
}

async function waitForTalkTask(task: Promise<void>, waitMs: number): Promise<boolean> {
  return await Promise.race([
    task.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs)),
  ]);
}

function statusForTalkResult(result: { success: boolean; error?: string; errorCode?: string }): number {
  if (result.success) return 200;
  if (result.errorCode === 'chat_busy' || result.error === 'Chat is busy with another task') return 409;
  return 500;
}

async function runTalkAsyncTask(input: {
  asyncTaskId: string;
  bot: any;
  botName: string;
  chatId: string;
  prompt: string;
  sendCards: boolean;
  callbackChatId?: string;
  callbackBotName?: string;
  registry: any;
  asyncTaskStore: any;
  circuitBreaker: any;
  budgetManager: any;
}): Promise<void> {
  input.asyncTaskStore.update(input.asyncTaskId, { status: 'running' });
  try {
    const result = await input.bot.bridge.executeApiTask({
      prompt: input.prompt,
      chatId: input.chatId,
      userId: 'api',
      sendCards: input.sendCards,
    });
    input.asyncTaskStore.update(input.asyncTaskId, {
      status: result.success ? 'completed' : 'failed',
      completedAt: Date.now(),
      result: {
        success: result.success,
        responseText: result.responseText,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        error: result.error,
        errorCode: result.errorCode,
        retryAfterMs: result.retryAfterMs,
        busy: result.busy,
      },
    });

    if (result.success) {
      input.circuitBreaker.recordSuccess(input.botName);
    } else {
      input.circuitBreaker.recordFailure(input.botName);
    }
    if (result.costUsd) {
      input.budgetManager.recordCost(input.botName, result.costUsd);
    }

    if (input.callbackChatId && input.callbackBotName) {
      const callbackBot = input.registry.get(input.callbackBotName);
      if (callbackBot) {
        const summary = result.responseText?.slice(0, 500) || result.error || 'Task completed';
        await callbackBot.bridge.executeApiTask({
          prompt: `[Async task callback] Bot "${input.botName}" finished a task. Result: ${summary}`,
          chatId: input.callbackChatId,
          userId: 'system',
          sendCards: true,
          maxTurns: 1,
        });
      }
    }
  } catch (err: any) {
    input.circuitBreaker.recordFailure(input.botName);
    input.asyncTaskStore.update(input.asyncTaskId, {
      status: 'failed',
      completedAt: Date.now(),
      result: { success: false, responseText: '', error: err.message },
    });
  }
}
