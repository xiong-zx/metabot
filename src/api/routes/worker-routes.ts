import type * as http from 'node:http';
import { jsonResponse, parseJsonBody, readBody, type JsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import type {
  CodexApprovalPolicy,
  CodexSandbox,
  WorkerOutputContract,
  WorkerReasoningEffort,
} from '../../workers/worker-manager.js';
import { isWorkerOutputContractName } from '../../workers/worker-manager.js';
import type { EngineName } from '../../config.js';
import { hasTeamCapability, type TeamActorRole, type TeamCapabilityAction } from '../../agent-teams/team-store.js';

/**
 * PM/Worker + remind endpoints (consumed by the worker-manager MCP server):
 *   GET    /api/workers            — list (optional ?pmChatId= filter)
 *   POST   /api/workers            — dispatch (202)
 *   GET    /api/workers/:id        — record details
 *   POST   /api/workers/:id/abort  — kill a running worker
 *   POST   /api/workers/:id/redirect — abort + re-dispatch with new prompt
 *   POST   /api/remind             — one-time reminder via the scheduler
 *   POST   /api/remind/stop        — disable auto-remind for a chat
 */
export async function handleWorkerRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { workerManager, registry, scheduler, logger } = ctx;

  // --- /api/workers ---

  if (url === '/api/workers' || url.startsWith('/api/workers?') || url.startsWith('/api/workers/')) {
    if (!workerManager) {
      jsonResponse(res, 503, { error: 'Worker manager not initialized' });
      return true;
    }

    if (method === 'GET' && (url === '/api/workers' || url.startsWith('/api/workers?'))) {
      const pmChatId = new URL(url, 'http://localhost').searchParams.get('pmChatId') || undefined;
      jsonResponse(res, 200, { workers: workerManager.listWorkers(pmChatId) });
      return true;
    }

    if (method === 'POST' && url === '/api/workers') {
      const body = await parseJsonBody(req);
      if (!requireActorCapability(res, body, 'worker_dispatch')) return true;
      const botName = body.botName as string;
      const pmChatId = body.pmChatId as string;
      const workingDirectory = body.workingDirectory as string;
      const prompt = body.prompt as string;
      if (!botName || !pmChatId || !workingDirectory || !prompt) {
        jsonResponse(res, 400, { error: 'Missing required fields: botName, pmChatId, workingDirectory, prompt' });
        return true;
      }
      if (body.outputContract !== undefined && !isWorkerOutputContract(body.outputContract)) {
        jsonResponse(res, 400, { error: 'Invalid outputContract: expected a supported contract name and optional expectedArtifacts as non-empty strings' });
        return true;
      }
      try {
        const record = workerManager.dispatch({
          botName,
          pmChatId,
          workingDirectory,
          prompt,
          label: body.label as string | undefined,
          model: body.model as string | undefined,
          engine: body.engine as EngineName | undefined,
          reasoningEffort: body.reasoningEffort as WorkerReasoningEffort | undefined,
          approvalPolicy: body.approvalPolicy as CodexApprovalPolicy | undefined,
          sandbox: body.sandbox as CodexSandbox | undefined,
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
          idleTimeoutMs: typeof body.idleTimeoutMs === 'number' ? body.idleTimeoutMs : undefined,
          dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : undefined,
          outputContract: isWorkerOutputContract(body.outputContract) ? body.outputContract : undefined,
        });
        jsonResponse(res, 202, record);
      } catch (err: any) {
        jsonResponse(res, 400, { error: err.message });
      }
      return true;
    }

    const idMatch = url.match(/^\/api\/workers\/([^/?]+)(\/(abort|redirect))?$/);
    if (idMatch) {
      const id = idMatch[1];
      const action = idMatch[3];

      if (method === 'GET' && !action) {
        const record = workerManager.getWorker(id);
        if (!record) {
          jsonResponse(res, 404, { error: `Worker not found: ${id}` });
          return true;
        }
        jsonResponse(res, 200, record);
        return true;
      }

      if (method === 'POST' && action === 'abort') {
        const body = await parseOptionalJsonBody(req);
        if (!requireActorCapability(res, body, 'worker_dispatch')) return true;
        const ok = workerManager.abortWorker(id);
        if (!ok) {
          jsonResponse(res, 404, { error: `Worker not found or not running: ${id}` });
          return true;
        }
        jsonResponse(res, 200, { ok: true });
        return true;
      }

      if (method === 'POST' && action === 'redirect') {
        const body = await parseOptionalJsonBody(req);
        if (!requireActorCapability(res, body, 'worker_dispatch')) return true;
        const newPrompt = body.newPrompt as string;
        if (!newPrompt) {
          jsonResponse(res, 400, { error: 'Missing required field: newPrompt' });
          return true;
        }
        const record = workerManager.redirectWorker(id, newPrompt);
        if (!record) {
          jsonResponse(res, 404, { error: `Worker not found: ${id}` });
          return true;
        }
        jsonResponse(res, 202, record);
        return true;
      }
    }
    return false;
  }

  // --- /api/remind ---

  if (method === 'POST' && url === '/api/remind') {
    const body = await parseJsonBody(req);
    const botName = body.botName as string;
    const chatId = body.chatId as string;
    const delaySeconds = body.delaySeconds as number;
    if (!botName || !chatId || !delaySeconds || delaySeconds <= 0) {
      jsonResponse(res, 400, { error: 'Missing/invalid fields: botName, chatId, delaySeconds' });
      return true;
    }
    const extraPrompt = (body.extraPrompt as string | undefined)
      || `⏰ 定时提醒（${delaySeconds}秒前你设置的）。请继续之前的工作。`;
    try {
      const task = scheduler.scheduleTask({
        botName,
        chatId,
        prompt: extraPrompt,
        delaySeconds,
        sendCards: true,
        label: `remind-${chatId}`,
      });
      jsonResponse(res, 200, { taskId: task.id, executeAt: task.executeAt });
    } catch (err: any) {
      logger.warn({ err, chatId }, 'Failed to schedule reminder');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  if (method === 'POST' && url === '/api/remind/stop') {
    const body = await parseJsonBody(req);
    const botName = body.botName as string;
    const chatId = body.chatId as string;
    if (!botName || !chatId) {
      jsonResponse(res, 400, { error: 'Missing required fields: botName, chatId' });
      return true;
    }
    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }
    bot.bridge.setAutoRemind(chatId, false);
    jsonResponse(res, 200, { ok: true });
    return true;
  }

  return false;
}

function requireActorCapability(
  res: http.ServerResponse,
  body: JsonBody,
  action: TeamCapabilityAction,
): boolean {
  const role = actorRoleField(body.actorRole ?? body.role) ?? 'agent';
  if (hasTeamCapability(role, action)) return true;
  jsonResponse(res, 403, { error: `actorRole ${role} is not allowed to ${action}` });
  return false;
}

async function parseOptionalJsonBody(req: http.IncomingMessage): Promise<JsonBody> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as JsonBody;
  } catch {
    throw Object.assign(new Error('Invalid JSON in request body'), { statusCode: 400 });
  }
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

function isWorkerOutputContract(value: unknown): value is WorkerOutputContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isWorkerOutputContractName(candidate.name) || typeof candidate.requiredArtifact !== 'boolean') return false;
  if (candidate.expectedArtifacts === undefined) return true;
  return Array.isArray(candidate.expectedArtifacts)
    && candidate.expectedArtifacts.length > 0
    && candidate.expectedArtifacts.every((item) => typeof item === 'string' && item.trim().length > 0);
}
