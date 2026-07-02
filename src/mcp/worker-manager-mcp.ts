#!/usr/bin/env node
/**
 * Worker Manager MCP Server
 *
 * A stdio-based MCP server that exposes worker lifecycle management tools.
 * Internally calls metabot's /api/workers and /api/remind HTTP endpoints.
 *
 * Identity resolution: tools accept explicit `botName` / `pmChatId` (or
 * `chatId`) arguments; when omitted they fall back to the env vars below.
 * For Claude-engine PMs, metabot injects METABOT_BOT_NAME / METABOT_CHAT_ID
 * per session (loadMcpServersWithApiContext). Codex-engine PMs register this
 * server globally (~/.codex/config.toml [mcp_servers]) where per-session env
 * is not possible — they MUST pass bot_name/chat_id explicitly; the PM
 * system prompt tells them their identity.
 *
 * Environment variables:
 *   METABOT_API_URL    — metabot HTTP API base URL (default: http://localhost:9100)
 *   METABOT_API_SECRET — API secret for auth (optional)
 *   METABOT_BOT_NAME   — default bot name
 *   METABOT_CHAT_ID    — default PM chat id
 */

import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_URL = process.env.METABOT_API_URL || 'http://localhost:9100';
const API_SECRET = process.env.METABOT_API_SECRET || process.env.API_SECRET || '';
const DEFAULT_BOT_NAME = process.env.METABOT_BOT_NAME || '';
const DEFAULT_CHAT_ID = process.env.METABOT_CHAT_ID || '';

const MODEL_GUIDE = [
  'Supported model values:',
  '  - "gpt-5.4" (default; engine codex; REAL 1M-token context — use for long-context work)',
  '  - "gpt-5.5" (engine codex; 272k input + 128k output — stronger model, smaller context)',
  '  - "opus"   (= claude-opus-4-8, engine claude; strongest reasoning)',
  '  - "sonnet" (= claude-sonnet-4-6, engine claude; fast executor)',
  'Any raw model name also works: gpt-* → codex, claude-* → claude.',
].join('\n');

// --- HTTP helper ---

function apiRequest(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const postData = body ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (API_SECRET) {
      headers['Authorization'] = `Bearer ${API_SECRET}`;
    }
    if (postData) {
      headers['Content-Length'] = Buffer.byteLength(postData).toString();
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode || 500, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 500, data: { raw } });
          }
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// --- MCP Server ---

const server = new Server(
  { name: 'worker-manager', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'worker_dispatch',
      description:
        'Dispatch a new worker agent to execute a task asynchronously. Returns immediately with a worker ID; the worker runs in the background and you are notified on completion.\n' +
        MODEL_GUIDE,
      inputSchema: {
        type: 'object' as const,
        properties: {
          workdir: { type: 'string', description: 'Working directory for the worker (absolute path)' },
          prompt: { type: 'string', description: 'Task instructions for the worker' },
          label: { type: 'string', description: 'Optional short label for this worker (e.g. "xgboost-exp")' },
          model: { type: 'string', description: 'Model or alias: gpt-5.4 (default, 1M ctx) | gpt-5.5 | opus | sonnet | raw model name' },
          engine: { type: 'string', enum: ['claude', 'codex', 'kimi'], description: 'Engine override (normally inferred from model)' },
          reasoning_effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort for the worker' },
          approval_policy: { type: 'string', enum: ['untrusted', 'on-failure', 'on-request', 'never'], description: 'Codex approval policy (codex workers only)' },
          sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Codex sandbox level (codex workers only)' },
          botName: { type: 'string', description: `Bot name (default: ${DEFAULT_BOT_NAME || 'from METABOT_BOT_NAME env'})` },
          pmChatId: { type: 'string', description: 'Your chat ID for callbacks (REQUIRED for codex-engine PMs; auto-detected for claude PMs)' },
        },
        required: ['workdir', 'prompt'],
      },
    },
    {
      name: 'worker_list',
      description: 'List all workers and their current status (engine/model/effort markers included).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pmChatId: { type: 'string', description: 'Filter by PM chat ID (optional)' },
        },
      },
    },
    {
      name: 'worker_quick_status',
      description:
        'Get a brief metadata-level status of a worker. WARNING: this only returns basic metadata (status, duration, last progress summary). For detailed understanding you MUST inspect the worker\'s workdir yourself — read worker-progress.json, results.json, train.log, and the code/output files directly.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Worker ID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'worker_abort',
      description: 'Kill a running worker immediately.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Worker ID to abort' },
        },
        required: ['id'],
      },
    },
    {
      name: 'worker_redirect',
      description:
        'Interrupt a running worker and re-dispatch with new instructions. The new worker inherits the same workdir/engine/model and receives context about the previous task.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Worker ID to redirect' },
          newPrompt: { type: 'string', description: 'New task instructions for the replacement worker' },
        },
        required: ['id', 'newPrompt'],
      },
    },
    {
      name: 'remind_me',
      description:
        'Schedule a reminder to wake you up after a specified delay. Use this instead of sleep/polling when you want to check on something later (e.g. 2 minutes) without blocking your session. After calling this, end your turn — the system will message you when the timer fires.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          seconds: { type: 'number', description: 'Delay in seconds before the reminder fires' },
          extra_prompt: { type: 'string', description: 'Optional: what to do when reminded (e.g. "check exp-xxx results")' },
          chatId: { type: 'string', description: 'Your chat ID (REQUIRED for codex-engine PMs; auto-detected for claude PMs)' },
          botName: { type: 'string', description: `Bot name (default: ${DEFAULT_BOT_NAME || 'from METABOT_BOT_NAME env'})` },
        },
        required: ['seconds'],
      },
    },
    {
      name: 'stop_auto_remind',
      description:
        'Stop the automatic 40-minute periodic reminders for your chat session. Call this when all experiments are complete and no further research is pending. Reminders auto-resume when the user sends a new message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chatId: { type: 'string', description: 'Your chat ID (REQUIRED for codex-engine PMs; auto-detected for claude PMs)' },
          botName: { type: 'string', description: `Bot name (default: ${DEFAULT_BOT_NAME || 'from METABOT_BOT_NAME env'})` },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'worker_dispatch': {
        const { status, data } = await apiRequest('POST', '/api/workers', {
          botName: args?.botName || DEFAULT_BOT_NAME,
          pmChatId: args?.pmChatId || DEFAULT_CHAT_ID,
          workingDirectory: args?.workdir,
          prompt: args?.prompt,
          label: args?.label,
          model: args?.model,
          engine: args?.engine,
          reasoningEffort: args?.reasoning_effort,
          approvalPolicy: args?.approval_policy,
          sandbox: args?.sandbox,
        });
        if (status >= 400) {
          return { content: [{ type: 'text', text: `Error: ${data.error || JSON.stringify(data)}` }] };
        }
        return {
          content: [{
            type: 'text',
            text: [
              `Worker dispatched successfully.`,
              `ID: ${data.id}`,
              `Worker chat: ${data.workerChatId}`,
              `Engine/Model: ${data.engine}/${data.model}${data.reasoningEffort ? ` (effort: ${data.reasoningEffort})` : ''}`,
              `Workdir: ${data.workingDirectory}`,
              `Status: ${data.status}`,
              '',
              'The worker is now running in the background. You will be notified when it completes.',
              'Use worker_quick_status to check progress, or inspect the workdir directly for details.',
            ].join('\n'),
          }],
        };
      }

      case 'worker_list': {
        const queryStr = args?.pmChatId ? `?pmChatId=${encodeURIComponent(args.pmChatId as string)}` : '';
        const { status, data } = await apiRequest('GET', `/api/workers${queryStr}`);
        if (status >= 400) {
          return { content: [{ type: 'text', text: `Error: ${data.error || JSON.stringify(data)}` }] };
        }
        const workers = data.workers || [];
        if (workers.length === 0) {
          return { content: [{ type: 'text', text: 'No workers found.' }] };
        }
        const lines = workers.map((w: any) => {
          const dur = w.durationMs ? `${Math.round(w.durationMs / 60000)}min` : 'running';
          const cost = w.costUsd ? `$${w.costUsd.toFixed(2)}` : '';
          const engineTag = w.engine ? `${w.engine}/${w.model}${w.reasoningEffort ? `@${w.reasoningEffort}` : ''}` : w.model;
          return `- [${w.id}] ${w.status} | ${w.label || 'no-label'} | ${engineTag} | ${dur} ${cost} | ${w.workingDirectory}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'worker_quick_status': {
        const { status, data } = await apiRequest('GET', `/api/workers/${args?.id}`);
        if (status >= 400) {
          return { content: [{ type: 'text', text: `Error: ${data.error || JSON.stringify(data)}` }] };
        }
        const w = data;
        const dur = w.durationMs
          ? `${Math.round(w.durationMs / 60000)}min`
          : `${Math.round((Date.now() - w.startTime) / 60000)}min (running)`;
        const lines = [
          `Worker ${w.id}: ${w.status}`,
          `Label: ${w.label || 'none'}`,
          `Engine/Model: ${w.engine}/${w.model}${w.reasoningEffort ? ` (effort: ${w.reasoningEffort})` : ''}`,
          `Duration: ${dur}`,
          w.costUsd ? `Cost: $${w.costUsd.toFixed(2)}` : '',
          `Workdir: ${w.workingDirectory}`,
          w.resultSummary ? `Result (truncated): ${w.resultSummary.slice(0, 200)}` : '',
          w.error ? `Error: ${w.error}` : '',
          '',
          '⚠️ This is a quick metadata-level status only.',
          'For detailed information, inspect the worker\'s workdir yourself:',
          `  - Progress: ${w.workingDirectory}/worker-progress.json`,
          `  - Results:  ${w.workingDirectory}/results.json`,
          `  - Logs:     ${w.workingDirectory}/train.log`,
          '  - Also check the code and any training output files directly.',
        ].filter(Boolean);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'worker_abort': {
        const { status, data } = await apiRequest('POST', `/api/workers/${args?.id}/abort`);
        if (status >= 400) {
          return { content: [{ type: 'text', text: `Error: ${data.error || JSON.stringify(data)}` }] };
        }
        return { content: [{ type: 'text', text: `Worker ${args?.id} has been aborted.` }] };
      }

      case 'worker_redirect': {
        const { status, data } = await apiRequest('POST', `/api/workers/${args?.id}/redirect`, {
          newPrompt: args?.newPrompt,
        });
        if (status >= 400) {
          return { content: [{ type: 'text', text: `Error: ${data.error || JSON.stringify(data)}` }] };
        }
        return {
          content: [{
            type: 'text',
            text: [
              `Worker ${args?.id} redirected.`,
              `New worker ID: ${data.id}`,
              `New worker chat: ${data.workerChatId}`,
              `Workdir: ${data.workingDirectory}`,
              'The old worker has been aborted and a new one dispatched with your updated instructions.',
            ].join('\n'),
          }],
        };
      }

      case 'remind_me': {
        const seconds = args?.seconds as number;
        if (!seconds || seconds <= 0) {
          return { content: [{ type: 'text', text: 'Error: seconds must be a positive number' }] };
        }
        const defaultPrompt = `⏰ 定时提醒（${seconds}秒前你设置的）。请继续之前的工作。`;
        const { status, data } = await apiRequest('POST', '/api/remind', {
          botName: args?.botName || DEFAULT_BOT_NAME,
          chatId: args?.chatId || DEFAULT_CHAT_ID,
          delaySeconds: seconds,
          extraPrompt: args?.extra_prompt || defaultPrompt,
        });
        if (status >= 400) {
          return { content: [{ type: 'text', text: `Error: ${data.error || JSON.stringify(data)}` }] };
        }
        const mins = Math.round(seconds / 60);
        return {
          content: [{
            type: 'text',
            text: `Reminder set for ${mins > 0 ? mins + ' minutes' : seconds + ' seconds'} from now.\nTask ID: ${data.taskId}\n\nYou can now end your turn. The system will wake you up when the timer fires.`,
          }],
        };
      }

      case 'stop_auto_remind': {
        const { status, data } = await apiRequest('POST', '/api/remind/stop', {
          botName: args?.botName || DEFAULT_BOT_NAME,
          chatId: args?.chatId || DEFAULT_CHAT_ID,
        });
        if (status >= 400) {
          return { content: [{ type: 'text', text: `Error: ${data.error || JSON.stringify(data)}` }] };
        }
        return {
          content: [{
            type: 'text',
            text: 'Auto-remind has been stopped. You will no longer receive 40-minute periodic reminders.\nNote: Auto-remind will resume automatically when the user sends a new message.',
          }],
        };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Worker Manager MCP server error: ${err.message}\n`);
  process.exit(1);
});
