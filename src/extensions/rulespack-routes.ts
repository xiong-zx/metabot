import type * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { jsonResponse, parseJsonBody } from '../api/routes/helpers.js';
import type { RouteContext } from '../api/routes/types.js';
import { resolveEngineName } from '../engines/index.js';
import { RulesPackWorkerCoordinationError } from './rulespack-worker-coordinator.js';
import type {
  CoordinatedRulesPackMode,
  RulesPackWorkerCoordinator,
  WorkerRulesPackCoordinationStatus,
} from './rulespack-worker-coordinator.js';

const botModeQueues = new Map<string, Promise<void>>();

/** Downstream-owned authenticated HTTP binding for the RulesPack operator. */
export async function handleRulesPackRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const match = /^\/api\/bots\/([^/]+)\/rulespack(?:\/(.*))?$/.exec(url.split('?')[0]);
  if (!match) return false;
  const botName = decodeURIComponent(match[1]);
  const action = match[2] ?? 'status';
  const bot = ctx.registry.get(botName);
  const operator = bot?.bridge.getRulesPackOperator?.();
  if (bot && !operator && method === 'GET' && action === 'status') {
    const engine = resolveEngineName(bot.config);
    jsonResponse(res, 200, {
      supported: engine === 'codex',
      ...(bot.config.rulesPackPolicy ?? {
        state: engine === 'codex' ? 'unconfigured' : 'unsupported',
        required: false,
      }),
      initialized: false,
      mode: 'off',
    });
    return true;
  }
  if (!bot || !operator) {
    jsonResponse(res, 404, { error: `RulesPack is not configured for bot: ${botName}` });
    return true;
  }
  if (method === 'GET' && (action === 'status' || action === 'cache/status')) {
    const workerRulesPack = await workerCoordinationStatus(ctx, botName);
    jsonResponse(res, 200, {
      supported: true,
      ...(bot.config.rulesPackPolicy ?? { state: 'overridden', required: false }),
      ...operator.status(),
      workerRulesPack,
    });
    return true;
  }
  if (method === 'POST' && action === 'refresh') {
    jsonResponse(res, 200, await operator.refresh());
    return true;
  }
  if (method === 'POST' && action === 'cache/clear') {
    jsonResponse(res, 200, operator.clearCache());
    return true;
  }
  if (method === 'PATCH' && action === 'mode') {
    const body = await parseJsonBody(req);
    const mode = body.mode;
    if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
      if (mode !== null) {
        jsonResponse(res, 400, { error: 'mode must be off, shadow, enforce, or null to clear the override' });
        return true;
      }
    }
    await withBotModeLock(botName, () => patchRulesPackMode({
      ctx,
      botName,
      policy: bot.config.rulesPackPolicy,
      operator,
      mode: mode as CoordinatedRulesPackMode | null,
      res,
    }));
    return true;
  }
  if (method === 'POST' && action === 'explain') {
    const body = await parseJsonBody(req);
    jsonResponse(res, 200, await operator.explain({
      botName,
      chatId: typeof body.chatId === 'string' ? body.chatId : 'operator:explain',
      roles: stringArray(body.roles),
      cwd: typeof body.cwd === 'string' ? body.cwd : bot.config.claude.defaultWorkingDirectory,
      ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
      ...(typeof body.agentName === 'string' ? { agentName: body.agentName } : {}),
      ...(typeof body.workerId === 'string' ? { workerId: body.workerId } : {}),
      ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
      tools: stringArray(body.tools),
      dataClasses: stringArray(body.dataClasses),
      outputTypes: stringArray(body.outputTypes, ['text']),
    }));
    return true;
  }
  if (method === 'POST' && (action === 'temporary' || action === 'dispatch/compile')) {
    const body = await parseJsonBody(req);
    const facts = {
      botName,
      chatId: typeof body.chatId === 'string' ? body.chatId : 'operator:rulespack',
      roles: stringArray(body.roles),
      cwd: typeof body.cwd === 'string' ? body.cwd : bot.config.claude.defaultWorkingDirectory,
      ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
      ...(typeof body.agentName === 'string' ? { agentName: body.agentName } : {}),
      ...(typeof body.workerId === 'string' ? { workerId: body.workerId } : {}),
      ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
      tools: stringArray(body.tools),
      dataClasses: stringArray(body.dataClasses),
      outputTypes: stringArray(body.outputTypes, ['text']),
    };
    if (action === 'temporary') {
      if (typeof body.sourceId !== 'string' || typeof body.revision !== 'string' || !Array.isArray(body.rules)) {
        jsonResponse(res, 400, { error: 'sourceId, revision, and structured rules are required' });
        return true;
      }
      jsonResponse(res, 200, await operator.replaceTemporaryRules({
        sourceId: body.sourceId,
        revision: body.revision,
        rules: body.rules as import('@metabot/rulespack').RuleInputV1[],
        authenticatedFacts: facts,
      }));
      return true;
    }
    if (typeof body.audience !== 'string') {
      jsonResponse(res, 400, { error: 'audience is required' });
      return true;
    }
    jsonResponse(res, 201, await operator.createDispatchEnvelope({
      facts: {
        ...facts,
        botName: typeof body.targetBotName === 'string' ? body.targetBotName : botName,
      },
      audience: body.audience,
      ...(typeof body.targetHostId === 'string' ? { targetHostId: body.targetHostId } : {}),
      ...(typeof body.targetProjectId === 'string' ? { targetProjectId: body.targetProjectId } : {}),
      ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
      ...(body.required === true ? { required: true } : {}),
      ...(typeof body.parentDispatchId === 'string' ? { parentDispatchId: body.parentDispatchId } : {}),
    }));
    return true;
  }
  if (method === 'GET' && (action === 'receipts' || action === 'feedback')) {
    const query = new URL(url, 'http://localhost').searchParams;
    const digest = query.get('digest') ?? undefined;
    const limit = Number(query.get('limit') ?? 100);
    jsonResponse(res, 200, action === 'receipts'
      ? operator.receipts(digest, limit)
      : operator.feedback(digest, limit));
    return true;
  }
  if (method === 'POST' && action === 'feedback') {
    const body = await parseJsonBody(req);
    const kind = body.kind;
    if (
      typeof body.packDigest !== 'string' ||
      typeof body.message !== 'string' ||
      !['wrong', 'missing', 'unhelpful', 'helpful'].includes(String(kind))
    ) {
      jsonResponse(res, 400, { error: 'packDigest, kind, and message are required' });
      return true;
    }
    jsonResponse(res, 201, operator.addFeedback({
      packDigest: body.packDigest,
      kind: kind as 'wrong' | 'missing' | 'unhelpful' | 'helpful',
      message: body.message,
      ...(typeof body.ruleId === 'string' ? { ruleId: body.ruleId } : {}),
      ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
    }));
    return true;
  }
  jsonResponse(res, 405, { error: `Unsupported RulesPack operator action: ${action}` });
  return true;
}

async function patchRulesPackMode(input: {
  ctx: RouteContext;
  botName: string;
  policy: import('@metabot/rulespack-adapter').RulesPackBotPolicy | undefined;
  operator: import('@metabot/rulespack-adapter').RulesPackOperator;
  mode: CoordinatedRulesPackMode | null;
  res: http.ServerResponse;
}): Promise<void> {
  const coordinator = input.ctx.rulesPackWorkerCoordinator;
  if (!coordinator) {
    jsonResponse(input.res, 503, {
      error: 'Worker RulesPack coordination is not configured',
      code: 'WORKER_PREFLIGHT_FAILED',
      coordination: 'not-attempted',
      workerMutationAttempted: false,
      bridgeMutationAttempted: false,
    });
    return;
  }
  let previousBridge: import('@metabot/rulespack-adapter').RulesPackOperatorStatus;
  try {
    previousBridge = input.operator.status();
  } catch (error) {
    jsonResponse(input.res, 500, {
      error: safeError(error),
      code: 'BRIDGE_PREFLIGHT_FAILED',
      coordination: 'not-attempted',
      workerMutationAttempted: false,
      bridgeMutationAttempted: false,
    });
    return;
  }
  let previousWorker: WorkerRulesPackCoordinationStatus;
  try {
    previousWorker = await coordinator.status(input.botName);
    if (!previousWorker.botScoped || previousWorker.state !== 'configured') {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack bot-scoped control is ${previousWorker.state} for ${input.botName}`,
        'WORKER_REJECTED',
      );
    }
  } catch (error) {
    jsonResponse(input.res, coordinationFailureStatus(error), {
      error: safeError(error),
      code: 'WORKER_PREFLIGHT_FAILED',
      coordination: 'not-attempted',
      workerMutationAttempted: false,
      bridgeMutationAttempted: false,
    });
    return;
  }

  const workerOperationId = randomUUID();
  let workerRulesPack: WorkerRulesPackCoordinationStatus;
  try {
    workerRulesPack = await coordinator.setMode(
      input.botName,
      input.mode,
      previousWorker.operatorModeVersion,
      workerOperationId,
    );
  } catch (error) {
    const recovery = await restoreWorkerMode(
      coordinator,
      input.botName,
      previousWorker,
      workerOperationId,
    );
    if (recovery.confirmed) {
      jsonResponse(input.res, coordinationFailureStatus(error), {
        error: safeError(error),
        code: 'WORKER_MUTATION_FAILED',
        coordination: 'restored',
        workerMutationAttempted: true,
        workerRestored: true,
        bridgeMutationAttempted: false,
      });
      return;
    }
    jsonResponse(input.res, 500, {
      error: `Worker mutation outcome could not be fenced and restored: ${safeError(error)}`,
      code: 'RULESPACK_COORDINATION_INDETERMINATE',
      coordination: 'indeterminate',
      workerMutationAttempted: true,
      bridgeMutationAttempted: false,
      ...(recovery.lastObserved
        ? { workerRulesPack: { coordination: 'last-observed', ...recovery.lastObserved } }
        : {}),
    });
    return;
  }

  const bridgeOperationId = randomUUID();
  try {
    const status = input.operator.compareAndSetMode(
      input.mode,
      previousBridge.operatorModeVersion,
      bridgeOperationId,
    );
    const confirmedWorker = await coordinator.status(input.botName);
    if (
      confirmedWorker.operatorModeVersion !== workerRulesPack.operatorModeVersion ||
      confirmedWorker.operatorModeOperationId !== workerOperationId ||
      !sameWorkerModeState(confirmedWorker, workerRulesPack)
    ) {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack changed before two-surface confirmation for ${input.botName}`,
        'INVALID_RESPONSE',
      );
    }
    await publishRulesPackStatus(input.ctx, input.botName, input.policy, status);
    const publishedWorker = await coordinator.status(input.botName);
    if (
      publishedWorker.operatorModeVersion !== workerRulesPack.operatorModeVersion ||
      publishedWorker.operatorModeOperationId !== workerOperationId ||
      !sameWorkerModeState(publishedWorker, workerRulesPack)
    ) {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack changed during peer publication for ${input.botName}`,
        'INVALID_RESPONSE',
      );
    }
    jsonResponse(input.res, 200, {
      ...status,
      workerRulesPack: { coordination: 'confirmed', ...publishedWorker },
    });
  } catch (error) {
    const restoredBridge = restoreBridgeMode(
      input.operator,
      previousBridge,
      bridgeOperationId,
    );
    const workerRecovery = await restoreWorkerMode(
      coordinator,
      input.botName,
      previousWorker,
      workerOperationId,
    );
    let publicationRestored = false;
    if (restoredBridge && workerRecovery.confirmed) {
      try {
        await publishRulesPackStatus(input.ctx, input.botName, input.policy, restoredBridge);
        publicationRestored = true;
      } catch {
        // A stale advertised peer status is not safe to report as a confirmed restoration.
      }
      if (publicationRestored) {
        jsonResponse(input.res, 500, {
          error: `Bridge RulesPack mode update failed after Worker acknowledgement: ${safeError(error)}`,
          code: 'BRIDGE_MODE_UPDATE_FAILED',
          coordination: 'restored',
          workerRestored: true,
          bridgeRestored: true,
        });
        return;
      }
    }
    jsonResponse(input.res, 500, {
      error: `Bridge update failure could not be restored on both surfaces: ${safeError(error)}`,
      code: 'RULESPACK_COORDINATION_INDETERMINATE',
      coordination: 'indeterminate',
      workerRestored: workerRecovery.confirmed,
      bridgeRestored: restoredBridge !== undefined,
      peerStatusRestored: publicationRestored,
      ...(workerRecovery.lastObserved
        ? { workerRulesPack: { coordination: 'last-observed', ...workerRecovery.lastObserved } }
        : {}),
    });
  }
}

async function restoreWorkerMode(
  coordinator: RulesPackWorkerCoordinator,
  botName: string,
  original: WorkerRulesPackCoordinationStatus,
  attemptedOperationId: string,
): Promise<{ confirmed: boolean; lastObserved?: WorkerRulesPackCoordinationStatus }> {
  let permittedOperationId = attemptedOperationId;
  let lastObserved: WorkerRulesPackCoordinationStatus | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await coordinator.status(botName);
      lastObserved = current;
      const originalVersion = current.operatorModeVersion === original.operatorModeVersion;
      const ownedVersion = current.operatorModeOperationId === attemptedOperationId ||
        current.operatorModeOperationId === permittedOperationId;
      if (!originalVersion && !ownedVersion) return { confirmed: false, lastObserved };
      const compensationOperationId = randomUUID();
      permittedOperationId = compensationOperationId;
      try {
        await coordinator.setMode(
          botName,
          original.operatorModeOverride?.mode ?? null,
          current.operatorModeVersion,
          compensationOperationId,
        );
      } catch {
        // The acknowledgement is not trusted until the mandatory read below.
      }
      const confirmed = await coordinator.status(botName);
      lastObserved = confirmed;
      if (
        confirmed.operatorModeVersion === current.operatorModeVersion + 1 &&
        confirmed.operatorModeOperationId === compensationOperationId &&
        sameWorkerModeState(confirmed, original)
      ) {
        return { confirmed: true, lastObserved: confirmed };
      }
      if (confirmed.operatorModeOperationId !== attemptedOperationId) {
        return { confirmed: false, lastObserved: confirmed };
      }
    } catch {
      return { confirmed: false, ...(lastObserved ? { lastObserved } : {}) };
    }
  }
  return { confirmed: false, ...(lastObserved ? { lastObserved } : {}) };
}

function restoreBridgeMode(
  operator: import('@metabot/rulespack-adapter').RulesPackOperator,
  original: import('@metabot/rulespack-adapter').RulesPackOperatorStatus,
  attemptedOperationId: string,
): import('@metabot/rulespack-adapter').RulesPackOperatorStatus | undefined {
  try {
    const current = operator.status();
    if (current.operatorModeVersion === original.operatorModeVersion) {
      return sameBridgeModeState(current, original) ? current : undefined;
    }
    if (current.operatorModeOperationId !== attemptedOperationId) return undefined;
    const compensationOperationId = randomUUID();
    const restored = operator.compareAndSetMode(
      original.operatorModeOverride?.mode ?? null,
      current.operatorModeVersion,
      compensationOperationId,
    );
    return restored.operatorModeOperationId === compensationOperationId && sameBridgeModeState(restored, original)
      ? restored
      : undefined;
  } catch {
    return undefined;
  }
}

function sameWorkerModeState(
  left: WorkerRulesPackCoordinationStatus,
  right: WorkerRulesPackCoordinationStatus,
): boolean {
  return left.mode === right.mode && left.operatorModeOverride?.mode === right.operatorModeOverride?.mode;
}

function sameBridgeModeState(
  left: import('@metabot/rulespack-adapter').RulesPackOperatorStatus,
  right: import('@metabot/rulespack-adapter').RulesPackOperatorStatus,
): boolean {
  return left.mode === right.mode && left.operatorModeOverride?.mode === right.operatorModeOverride?.mode;
}

async function withBotModeLock<T>(botName: string, task: () => Promise<T>): Promise<T> {
  const previous = botModeQueues.get(botName) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  botModeQueues.set(botName, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (botModeQueues.get(botName) === tail) botModeQueues.delete(botName);
  }
}

async function workerCoordinationStatus(ctx: RouteContext, botName: string): Promise<Record<string, unknown>> {
  if (!ctx.rulesPackWorkerCoordinator) {
    return {
      coordination: 'unavailable',
      error: 'Worker RulesPack coordinator is not configured',
      appliesTo: 'subsequent-codex-policy-preparations',
      inFlight: 'unchanged',
    };
  }
  try {
    return { coordination: 'confirmed', ...await ctx.rulesPackWorkerCoordinator.status(botName) };
  } catch (error) {
    return {
      coordination: 'unavailable',
      error: safeError(error),
      appliesTo: 'subsequent-codex-policy-preparations',
      inFlight: 'unchanged',
    };
  }
}

function coordinationFailureStatus(error: unknown): number {
  return error instanceof RulesPackWorkerCoordinationError && error.code === 'WORKER_UNAVAILABLE' ? 503 : 409;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
    .slice(0, 500);
}

async function publishRulesPackStatus(
  ctx: RouteContext,
  botName: string,
  policy: import('@metabot/rulespack-adapter').RulesPackBotPolicy | undefined,
  status: import('@metabot/rulespack-adapter').RulesPackOperatorStatus,
): Promise<void> {
  await ctx.peerManager?.updateLocalRulesPackStatus(botName, {
    ...(policy ?? { state: 'overridden', required: false }),
    mode: status.mode,
    operatorModeVersion: status.operatorModeVersion,
    ...(status.operatorModeOperationId
      ? { operatorModeOperationId: status.operatorModeOperationId }
      : {}),
  });
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : fallback;
}
