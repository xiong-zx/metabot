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
  const statusCommand = talkStatusCommand(taskId);
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
    statusCommand,
    retryAfterMs: 2000,
    nextAction:
      preflight === undefined
        ? `Run ${statusCommand} after 2s to check progress.`
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
  const memoryTerminalStatus =
    !running && preflight?.kind === 'memory_core'
      ? memoryTerminalStatusDetails(task.status, preflight, elapsedMs, task.result)
      : undefined;
  const terminalProgress =
    running || memoryTerminalStatus !== undefined
      ? memoryTerminalStatus?.progress
      : terminalTaskProgress(task.status, preflight, elapsedMs, task.result);
  const statusCommand = talkStatusCommand(task.id);
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
    ...(!running && (preflight?.kind === 'autoresearchclaw' || preflight?.kind === 'memory_core')
      ? { finalPhase: task.status }
      : {}),
    botName: task.botName,
    chatId: task.chatId,
    createdAt: new Date(task.createdAt).toISOString(),
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
    elapsedMs,
    statusUrl: `/api/talk/${encodeURIComponent(task.id)}`,
    statusCommand,
    retryAfterMs,
    message: running
      ? runningMessage(preflight, elapsedMs)
      : (memoryTerminalStatus?.message ?? terminalMessage(task.status, preflight)),
    nextAction: running
      ? preflight === undefined
        ? `Run ${statusCommand} again after 2s. For AutoResearchClaw tasks, also ask for the matching Memory Core run status.`
        : taskNextAction(task.id, preflight, elapsedMs)
      : (memoryTerminalStatus?.nextAction ?? terminalNextAction(preflight)),
    ...(preflight === undefined ? {} : { preflight }),
    ...(memoryTerminalStatus?.evidence === undefined ? {} : { memoryCoreEvidence: memoryTerminalStatus.evidence }),
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
    statusCommand: talkStatusCommand(taskId),
    error: 'Task not found or no longer retained',
    message:
      'Task status is unavailable. The task may never have existed, may have expired after retention, or may have been lost before persistence during service restart.',
    nextAction:
      'If this was a wake/check request, resend it with metabot talk --wait-ms so the response is observed directly. For AutoResearchClaw tasks, inspect the Memory Core run lifecycle if a run id was returned.',
  };
}

function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function talkStatusCommand(taskId: string): string {
  return `metabot talk-status ${shellQuoteArg(taskId)}`;
}

function researchRunsCommand(projectRoot: string, projectId: string): string {
  return `metabot research runs --root ${shellQuoteArg(projectRoot)} --project ${shellQuoteArg(projectId)}`;
}

function researchEvidenceCommand(projectRoot: string, projectId: string): string {
  return `metabot research events/search/context-pack --root ${shellQuoteArg(projectRoot)} --project ${shellQuoteArg(projectId)}`;
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

interface MemoryCoreTerminalEvidence {
  eventIds?: string[];
  memoryUnitIds?: string[];
  promotionIds?: string[];
  candidateIds?: string[];
  contextPackIds?: string[];
}

interface MemoryCoreTerminalStatusDetails {
  progress: Record<string, unknown>;
  message: string;
  nextAction: string;
  evidence?: MemoryCoreTerminalEvidence;
}

function memoryTerminalStatusDetails(
  status: string,
  preflight: Record<string, unknown>,
  elapsedMs: number,
  result: unknown,
): MemoryCoreTerminalStatusDetails {
  const resultRecord = isRecord(result) ? result : undefined;
  const errorMessage = typeof resultRecord?.error === 'string' ? resultRecord.error : undefined;
  const errorCode = typeof resultRecord?.errorCode === 'string' ? resultRecord.errorCode : undefined;
  const extracted = extractMemoryCoreTerminalEvidence(result);
  const evidence = extracted.evidence;
  const evidenceState = evidence === undefined ? 'no_structured_evidence' : 'structured_evidence_extracted';
  const reviewState = extracted.pendingReview === true ? 'pending_review' : 'not_pending_review';
  const overdueState = memoryTerminalOverdueState(elapsedMs, preflight);
  const completed = status === 'completed';
  const progress: Record<string, unknown> = {
    kind: 'phased',
    currentPhase: completed ? 'completed' : 'failed',
    finalPhase: status,
    elapsedMs,
    projectId: preflight.projectId,
    projectRoot: preflight.projectRoot,
    domain: preflight.domain,
    operation: preflight.operation,
    expectedCompletionMs: memoryExpectedCompletionMs(preflight),
    timeoutBoundaryMs: memoryTimeoutBoundaryMs(preflight),
    stages: preflight.stages,
    finalization: {
      status: completed ? 'memory_operation_completed' : 'memory_operation_failed',
      reviewState,
      evidenceState,
      overdueState,
      partialEvidence: evidence !== undefined && overdueState !== 'within_expected_window',
    },
    nextAction: memoryTerminalNextAction(preflight, status, overdueState, evidence, extracted.pendingReview),
  };
  if (evidence !== undefined) {
    progress.evidence = evidence;
  }
  if (!completed) {
    progress.error = {
      status: 'memory_operation_failed',
      ...(errorCode === undefined ? {} : { code: errorCode }),
      ...(errorMessage === undefined ? {} : { message: errorMessage }),
    };
  }
  return {
    progress,
    message: memoryTerminalMessage(status, overdueState, evidenceState, extracted.pendingReview),
    nextAction: String(progress.nextAction),
    evidence,
  };
}

function memoryTerminalMessage(
  status: string,
  overdueState: 'within_expected_window' | 'expected_completion_overdue' | 'timeout_boundary_exceeded',
  evidenceState: 'structured_evidence_extracted' | 'no_structured_evidence',
  pendingReview: boolean,
): string {
  const outcome = status === 'completed' ? 'completed' : 'failed';
  const review = pendingReview ? ' Pending review evidence was detected.' : '';
  const evidence =
    evidenceState === 'structured_evidence_extracted'
      ? ' Structured Memory Core evidence was extracted into status fields.'
      : ' No structured Memory Core evidence could be derived from the terminal result.';
  if (overdueState === 'timeout_boundary_exceeded') {
    return `Memory Core operation ${outcome} after the timeout boundary.${review}${evidence} Verify any partial evidence directly in Memory Core.`;
  }
  if (overdueState === 'expected_completion_overdue') {
    return `Memory Core operation ${outcome} after the expected completion window but before the timeout boundary.${review}${evidence}`;
  }
  return `Memory Core operation ${outcome}.${review}${evidence}`;
}

function memoryTerminalNextAction(
  preflight: Record<string, unknown>,
  status: string,
  overdueState: 'within_expected_window' | 'expected_completion_overdue' | 'timeout_boundary_exceeded',
  evidence: MemoryCoreTerminalEvidence | undefined,
  pendingReview: boolean,
): string {
  const inspectCommand =
    typeof preflight.projectRoot === 'string' && typeof preflight.projectId === 'string'
      ? researchEvidenceCommand(preflight.projectRoot, preflight.projectId)
      : undefined;
  const inspectText =
    inspectCommand === undefined
      ? 'Inspect Memory Core directly using the project root and project id.'
      : `Inspect Memory Core with ${inspectCommand}.`;
  const reviewText = pendingReview
    ? ' Review the pending candidate or promotion request before treating this as finalized.'
    : '';
  const evidenceText =
    evidence === undefined
      ? ' Use the system-of-record response there to recover event ids, memory unit ids, promotion/candidate ids, and context pack ids.'
      : ' Cross-check the structured ids in this status against the system-of-record response.';
  if (status !== 'completed') {
    if (overdueState === 'timeout_boundary_exceeded') {
      return `${inspectText} This task failed after the timeout boundary and may only have partial evidence.${reviewText}${evidenceText}`;
    }
    if (overdueState === 'expected_completion_overdue') {
      return `${inspectText} This task failed after the expected completion window and may have partial evidence.${reviewText}${evidenceText}`;
    }
    return `${inspectText} This task failed.${reviewText}${evidenceText}`;
  }
  if (overdueState === 'timeout_boundary_exceeded') {
    return `${inspectText} This task completed after the timeout boundary; verify any partial-evidence path and final state directly in Memory Core.${reviewText}${evidenceText}`;
  }
  if (overdueState === 'expected_completion_overdue') {
    return `${inspectText} This task completed after the expected completion window; verify the final state directly in Memory Core.${reviewText}${evidenceText}`;
  }
  return `${inspectText} This task completed.${reviewText}${evidenceText}`;
}

function memoryTerminalOverdueState(
  elapsedMs: number,
  preflight: Record<string, unknown>,
): 'within_expected_window' | 'expected_completion_overdue' | 'timeout_boundary_exceeded' {
  if (elapsedMs >= memoryTimeoutBoundaryMs(preflight)) return 'timeout_boundary_exceeded';
  if (elapsedMs >= memoryExpectedCompletionMs(preflight)) return 'expected_completion_overdue';
  return 'within_expected_window';
}

function extractMemoryCoreTerminalEvidence(result: unknown): {
  evidence: MemoryCoreTerminalEvidence | undefined;
  pendingReview: boolean;
} {
  const roots = collectMemoryCoreEvidenceRoots(result);
  const buckets = {
    eventIds: new Set<string>(),
    memoryUnitIds: new Set<string>(),
    promotionIds: new Set<string>(),
    candidateIds: new Set<string>(),
    contextPackIds: new Set<string>(),
  };
  let pendingReview = false;
  for (const root of roots) {
    walkMemoryCoreEvidence(root, buckets, { pendingReview: false }, []);
    pendingReview ||= memoryCorePendingReviewFromRoot(root);
  }
  pendingReview ||= buckets.promotionIds.size > 0 || buckets.candidateIds.size > 0;
  const evidence: MemoryCoreTerminalEvidence = {
    ...(buckets.eventIds.size === 0 ? {} : { eventIds: [...buckets.eventIds].sort() }),
    ...(buckets.memoryUnitIds.size === 0 ? {} : { memoryUnitIds: [...buckets.memoryUnitIds].sort() }),
    ...(buckets.promotionIds.size === 0 ? {} : { promotionIds: [...buckets.promotionIds].sort() }),
    ...(buckets.candidateIds.size === 0 ? {} : { candidateIds: [...buckets.candidateIds].sort() }),
    ...(buckets.contextPackIds.size === 0 ? {} : { contextPackIds: [...buckets.contextPackIds].sort() }),
  };
  return {
    evidence: Object.keys(evidence).length === 0 ? undefined : evidence,
    pendingReview,
  };
}

function collectMemoryCoreEvidenceRoots(result: unknown): unknown[] {
  const roots: unknown[] = [];
  const rootRecord = isRecord(result) ? result : undefined;
  if (rootRecord !== undefined) {
    roots.push(rootRecord);
    const parsedResponseText = parseMemoryCoreResponsePayload(rootRecord.responseText);
    if (parsedResponseText !== undefined) roots.push(parsedResponseText);
  } else {
    const parsed = parseMemoryCoreResponsePayload(result);
    if (parsed !== undefined) roots.push(parsed);
  }
  return roots;
}

function parseMemoryCoreResponsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced?.[1] === undefined) return undefined;
  return tryParseJson(fenced[1].trim());
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function walkMemoryCoreEvidence(
  value: unknown,
  buckets: {
    eventIds: Set<string>;
    memoryUnitIds: Set<string>;
    promotionIds: Set<string>;
    candidateIds: Set<string>;
    contextPackIds: Set<string>;
  },
  state: { pendingReview: boolean },
  path: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkMemoryCoreEvidence(item, buckets, state, path);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeEvidenceKey(key);
    if (typeof child === 'string') {
      collectMemoryCoreId(normalized, child, buckets, path);
      if (memoryCorePendingReviewString(normalized, child)) state.pendingReview = true;
      continue;
    }
    if (Array.isArray(child)) {
      collectMemoryCoreIdArray(normalized, child, buckets, path);
      if (memoryCoreCollectionKind(normalized) !== undefined) {
        for (const item of child) {
          if (isRecord(item) && typeof item.id === 'string') {
            collectMemoryCoreId(memoryCoreCollectionKind(normalized)!, item.id, buckets, path.concat(normalized));
          }
          walkMemoryCoreEvidence(item, buckets, state, path.concat(normalized));
        }
        continue;
      }
      for (const item of child) walkMemoryCoreEvidence(item, buckets, state, path.concat(normalized));
      continue;
    }
    if (isRecord(child)) {
      if (normalized === 'contextpack' && typeof child.id === 'string') {
        collectMemoryCoreId('contextpackid', child.id, buckets, path.concat(normalized));
      }
      if (normalized === 'promotionrequest' && typeof child.id === 'string') {
        collectMemoryCoreId('promotionid', child.id, buckets, path.concat(normalized));
      }
      if (normalized === 'candidate' && typeof child.id === 'string') {
        collectMemoryCoreId('candidateid', child.id, buckets, path.concat(normalized));
      }
      walkMemoryCoreEvidence(child, buckets, state, path.concat(normalized));
    }
  }
}

function normalizeEvidenceKey(key: string): string {
  return key.replace(/[_\-\s]/g, '').toLowerCase();
}

function collectMemoryCoreIdArray(
  normalizedKey: string,
  values: unknown[],
  buckets: {
    eventIds: Set<string>;
    memoryUnitIds: Set<string>;
    promotionIds: Set<string>;
    candidateIds: Set<string>;
    contextPackIds: Set<string>;
  },
  path: string[],
): void {
  for (const value of values) {
    if (typeof value === 'string') collectMemoryCoreId(normalizedKey, value, buckets, path);
  }
}

function collectMemoryCoreId(
  normalizedKey: string,
  value: string,
  buckets: {
    eventIds: Set<string>;
    memoryUnitIds: Set<string>;
    promotionIds: Set<string>;
    candidateIds: Set<string>;
    contextPackIds: Set<string>;
  },
  path: string[],
): void {
  const target = memoryCoreBucketForKey(normalizedKey, path);
  if (target === undefined) return;
  if (!value.trim()) return;
  buckets[target].add(value);
}

function memoryCoreBucketForKey(
  normalizedKey: string,
  path: string[],
): 'eventIds' | 'memoryUnitIds' | 'promotionIds' | 'candidateIds' | 'contextPackIds' | undefined {
  if (
    normalizedKey === 'eventid' ||
    normalizedKey === 'eventids' ||
    normalizedKey === 'memoryeventid' ||
    normalizedKey === 'memoryeventids' ||
    normalizedKey === 'evidenceeventids' ||
    normalizedKey === 'sourceeventids' ||
    normalizedKey === 'includedeventids' ||
    normalizedKey === 'approvedeventids' ||
    normalizedKey === 'rejectedeventids'
  ) {
    return 'eventIds';
  }
  if (
    normalizedKey === 'memoryunitid' ||
    normalizedKey === 'memoryunitids' ||
    normalizedKey === 'unitid' ||
    normalizedKey === 'unitids' ||
    normalizedKey === 'includedmemoryunitids' ||
    normalizedKey === 'sourcememoryunitids'
  ) {
    return 'memoryUnitIds';
  }
  if (normalizedKey === 'promotionid' || normalizedKey === 'promotionids' || normalizedKey === 'promotionrequestid') {
    return 'promotionIds';
  }
  if (normalizedKey === 'candidateid' || normalizedKey === 'candidateids') {
    return 'candidateIds';
  }
  if (
    normalizedKey === 'contextpackid' ||
    normalizedKey === 'contextpackids' ||
    normalizedKey === 'sourcecontextpackids'
  ) {
    return 'contextPackIds';
  }
  if (normalizedKey === 'id') {
    const parent = path[path.length - 1];
    if (parent === 'events' || parent === 'memoryevents') return 'eventIds';
    if (parent === 'memoryunits' || parent === 'units') return 'memoryUnitIds';
    if (parent === 'promotionrequests' || parent === 'promotions') return 'promotionIds';
    if (parent === 'candidates') return 'candidateIds';
    if (parent === 'contextpacks') return 'contextPackIds';
  }
  return undefined;
}

function memoryCoreCollectionKind(
  normalizedKey: string,
): 'eventid' | 'memoryunitid' | 'promotionid' | 'candidateid' | 'contextpackid' | undefined {
  if (normalizedKey === 'events' || normalizedKey === 'memoryevents') return 'eventid';
  if (normalizedKey === 'memoryunits' || normalizedKey === 'units') return 'memoryunitid';
  if (normalizedKey === 'promotionrequests' || normalizedKey === 'promotions') return 'promotionid';
  if (normalizedKey === 'candidates') return 'candidateid';
  if (normalizedKey === 'contextpacks') return 'contextpackid';
  return undefined;
}

function memoryCorePendingReviewFromRoot(root: unknown): boolean {
  if (Array.isArray(root)) return root.some((item) => memoryCorePendingReviewFromRoot(item));
  if (!isRecord(root)) return false;
  for (const [key, value] of Object.entries(root)) {
    const normalized = normalizeEvidenceKey(key);
    if (typeof value === 'string' && memoryCorePendingReviewString(normalized, value)) return true;
    if (
      typeof value === 'boolean' &&
      (normalized === 'pendingreview' || normalized === 'reviewpending' || normalized === 'approvalpending')
    ) {
      if (value) return true;
    }
    if (typeof value === 'object' && value !== null && memoryCorePendingReviewFromRoot(value)) return true;
  }
  return false;
}

function memoryCorePendingReviewString(normalizedKey: string, value: string): boolean {
  if (
    normalizedKey !== 'status' &&
    normalizedKey !== 'reviewstatus' &&
    normalizedKey !== 'approvalstatus' &&
    normalizedKey !== 'promotionstatus' &&
    normalizedKey !== 'finalizationphase' &&
    normalizedKey !== 'candidatestatus'
  ) {
    return false;
  }
  const normalizedValue = value.replace(/[_\-\s]/g, '').toLowerCase();
  return (
    normalizedValue.includes('pendingreview') ||
    normalizedValue.includes('candidatereviewpending') ||
    normalizedValue.includes('promotionreviewpending') ||
    normalizedValue.includes('reviewrequired')
  );
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
    const runHint =
      typeof preflight.runId === 'string' ? ` If needed, locate run ${shellQuoteArg(preflight.runId)}.` : '';
    return `Inspect the Memory Core system-of-record with ${researchRunsCommand(
      preflight.projectRoot,
      preflight.projectId,
    )};${runHint} Inspect result for the async response or error.`;
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
    const matches = prompt.matchAll(new RegExp(`${escaped}\\s*[=:：是]\\s*`, 'giu'));
    for (const match of matches) {
      const sanitized = parsePromptFieldValue(prompt.slice((match.index ?? 0) + match[0].length));
      if (sanitized.length > 0) return sanitized;
    }
  }
  return undefined;
}

function parsePromptFieldValue(source: string): string {
  const value = source.trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    let parsed = '';
    let escaped = false;
    for (let i = 1; i < value.length; i += 1) {
      const char = value[i];
      if (escaped) {
        parsed += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) return parsed.trim();
      parsed += char;
    }
    return '';
  }
  const unquoted = value.match(/^[^\s,，。;；、]+/u)?.[0] ?? '';
  return sanitizePromptField(unquoted);
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
  const statusCommand = talkStatusCommand(taskId);
  if (typeof preflight.projectRoot === 'string' && typeof preflight.projectId === 'string') {
    return `Run ${statusCommand} again after 2s, or inspect Memory Core with ${researchRunsCommand(
      preflight.projectRoot,
      preflight.projectId,
    )}.`;
  }
  return `Run ${statusCommand} again after 2s; inspect Memory Core run lifecycle when project root and project id are known.`;
}

function taskNextAction(taskId: string, preflight: Record<string, unknown>, elapsedMs: number): string {
  if (preflight.kind === 'memory_core') {
    return memoryNextAction(taskId, preflight, elapsedMs);
  }
  return researchNextAction(taskId, preflight);
}

function memoryNextAction(taskId: string, preflight: Record<string, unknown>, elapsedMs: number): string {
  const statusCommand = talkStatusCommand(taskId);
  if (elapsedMs >= memoryTimeoutBoundaryMs(preflight)) {
    return `Run ${statusCommand} once more, then ask the bot to return partial Memory Core evidence or split the operation if it is still running.`;
  }
  if (elapsedMs >= memoryExpectedCompletionMs(preflight)) {
    return `Run ${statusCommand} again after 2s; if still running, ask for partial Memory Core evidence already created, then let finalization continue or split the remaining work.`;
  }
  if (typeof preflight.projectRoot === 'string' && typeof preflight.projectId === 'string') {
    return `Run ${statusCommand} again after 2s; for evidence, inspect Memory Core with ${researchEvidenceCommand(
      preflight.projectRoot,
      preflight.projectId,
    )}.`;
  }
  return `Run ${statusCommand} again after 2s; ask for event ids, unit ids, pending review status, and contextPack id.`;
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
