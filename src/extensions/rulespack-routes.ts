import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from '../api/routes/helpers.js';
import type { RouteContext } from '../api/routes/types.js';

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
  if (!bot || !operator) {
    jsonResponse(res, 404, { error: `RulesPack is not configured for bot: ${botName}` });
    return true;
  }
  if (method === 'GET' && (action === 'status' || action === 'cache/status')) {
    jsonResponse(res, 200, operator.status());
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
      jsonResponse(res, 400, { error: 'mode must be off, shadow, or enforce' });
      return true;
    }
    jsonResponse(res, 200, operator.setMode(mode));
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

function stringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : fallback;
}
