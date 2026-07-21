import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { BotConfigBase, ClaudeEffort, ClaudePermissionMode, CodexReasoningEffort } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import { makeCanUseTool } from './exit-plan-mode.js';
import { buildPmSystemPrompt } from '../pm-prompt.js';

const isWindows = process.platform === 'win32';

/** Resolve the Claude Code binary path at module load time. */
function resolveClaudePath(): string {
  if (process.env.CLAUDE_EXECUTABLE_PATH) return process.env.CLAUDE_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where claude' : 'which claude';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return isWindows ? 'claude' : '/usr/local/bin/claude';
  }
}

const CLAUDE_EXECUTABLE = resolveClaudePath();

/**
 * Env var prefixes to always strip from the inherited process environment.
 * CLAUDE*: prevents "nested session" errors from the SDK.
 */
const ALWAYS_FILTERED_PREFIXES = ['CLAUDE'];

/**
 * Specific CLAUDE_* env vars that are SAFE to pass through to the child
 * Claude Code process even though the broad CLAUDE* filter would normally
 * strip them. These are user-tunable feature flags / mode toggles, not
 * session-state vars (which are what the nested-session guard is for).
 *
 * Add a var here when you need MetaBot users to be able to enable a
 * Claude Code feature via .env or the host environment.
 */
const CLAUDE_ENV_PASSTHROUGH = new Set([
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', // /agent teams (multi-instance coordination)
  'CLAUDE_CODE_DISABLE_AGENT_VIEW',       // disable claude agents / --bg / /background
  'CLAUDE_CODE_SIMPLE',                   // --bare equivalent
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',      // toggle auto-memory (project patterns/learnings)
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',       // opt out of Max-tier silent 1M context upgrade
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',      // hard-cap the auto-compact window (keeps non-[1m] models at 200k)
]);

/**
 * Auth-related env vars that are only filtered when an explicit API key
 * is provided in bots.json OR when ~/.claude/.credentials.json exists.
 * This ensures users who rely solely on ANTHROPIC_API_KEY env var can
 * still authenticate without configuring bots.json.
 */
const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * no_proxy list written into every child Claude process env. Disable with
 * METABOT_NO_PROXY_DISABLE=true on hosts that want inherited proxy behavior.
 */
export const NO_PROXY_LIST = [
  'localhost', '127.0.0.1',
  'open.feishu.cn', '*.feishu.cn', 'lark.larksuite.com', '*.larksuite.com',
  '*.tuna.tsinghua.edu.cn', '*.aliyun.com', '*.ubuntu.com',
  '*.npmmirror.com', 'registry.npmmirror.com',
  '*.anaconda.com', '*.conda.io',
  '*.github.com', 'github.com', '*.githubusercontent.com',
  '*.pypi.org', 'pypi.org', 'files.pythonhosted.org',
  '*.papercopilot.com', 'papercopilot.com',
  '*.semanticscholar.org', 'api.semanticscholar.org',
  '*.arxiv.org', 'arxiv.org',
  '*.openreview.net', 'openreview.net',
  '*.google.com', '*.googleapis.com',
  '*.huggingface.co', '*.hf.co',
].join(',');

export function applyNoProxyPolicy(env: Record<string, string>): void {
  if (process.env.METABOT_NO_PROXY_DISABLE === 'true') return;
  env.no_proxy = NO_PROXY_LIST;
  env.NO_PROXY = NO_PROXY_LIST;
}

/**
 * Normalize proxy variables for Claude child processes. Some HTTP stacks prefer
 * lowercase proxy vars; others prefer uppercase. The rest of MetaBot treats the
 * uppercase value as authoritative when both are present, so mirror that here
 * to avoid a stale lowercase proxy sending Claude traffic down the wrong route.
 */
export function applyProxyPolicy(env: Record<string, string>): void {
  if (process.env.METABOT_PROXY_NORMALIZE_DISABLE === 'true') return;

  for (const [upper, lower] of [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy'],
    ['ALL_PROXY', 'all_proxy'],
  ] as const) {
    const upperValue = env[upper];
    const lowerValue = env[lower];
    if (upperValue) {
      env[lower] = upperValue;
    } else if (lowerValue) {
      env[upper] = lowerValue;
    }
  }
}

export function applyClaudeChildEnvPolicy(env: Record<string, string>): void {
  applyProxyPolicy(env);
  applyNoProxyPolicy(env);
}

export function resolveClaudePermissionOptions(
  configuredPermissionMode: ClaudePermissionMode | undefined,
  isRoot: boolean = process.getuid?.() === 0,
): { permissionMode: ClaudePermissionMode; allowDangerouslySkipPermissions?: true } {
  const permissionMode = configuredPermissionMode ?? (isRoot ? 'auto' : 'bypassPermissions');
  return {
    permissionMode,
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true as const } : {}),
  };
}

export const BYTHEWAY_DISALLOWED_MCP_TOOLS = [
  'mcp__worker-manager__worker_dispatch',
  'mcp__worker-manager__worker_abort',
  'mcp__worker-manager__worker_redirect',
  'mcp__worker-manager__remind_me',
  'mcp__worker-manager__stop_auto_remind',
];

export const BYTHEWAY_SYSTEM_NOTE = [
  'SIDE BRANCH MODE (/bytheway).',
  "You are in a SIDE BRANCH session that inherits the main conversation's",
  'history but does NOT write back to it. The user is asking something on',
  'the side; the user may later continue THIS branch with /btwc.',
  '',
  '## What is intentionally restricted (NOT a real outage)',
  '- The mutating worker-manager MCP tools (worker_dispatch, worker_abort,',
  '  worker_redirect, remind_me, stop_auto_remind) are hidden in this mode',
  '  by design. This is the /bytheway safety policy, NOT an MCP server outage.',
  '- The read-only worker tools `worker_list` and `worker_quick_status` ARE',
  '  available; use them freely if you need to check worker state.',
  '',
  '## What is allowed',
  '- Reading AND editing files are allowed under the bot\'s normal permissions.',
  '',
  '## Behavior',
  '- Answer the side question / do the side task, then exit.',
  '- If the task requires dispatching or controlling workers, tell the user',
  '  to re-send it as a normal non-/bytheway message.',
].join('\n');

/**
 * Check if Claude Code has credentials.json (OAuth login).
 */
function hasCredentialsFile(): boolean {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    return fs.existsSync(credPath);
  } catch {
    return false;
  }
}

/**
 * Create a custom spawn function for cross-platform compatibility.
 * - Honors `options.command` from the SDK — for claude-agent-sdk >= 0.2.140
 *   the SDK spawns the native Claude binary directly, so we must NOT force
 *   `process.execPath` (node). Legacy JS entrypoints set `options.command`
 *   to the node executable themselves, so this works in both worlds.
 * - Always filters CLAUDE* env vars to prevent nested session errors.
 * - Filters ANTHROPIC auth env vars only when an explicit API key is provided
 *   or credentials.json exists (so env-var-only users can still authenticate).
 * - Merges process.env so child inherits system PATH, TEMP, etc.
 * - Optionally injects an explicit ANTHROPIC_API_KEY from bots.json config.
 */
function createSpawnFn(explicitApiKey?: string, extraEnv?: Record<string, string>): (options: SpawnOptions) => SpawnedProcess {
  // Force-use-env mode: pass ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY /
  // ANTHROPIC_BASE_URL through to the Claude Code subprocess instead of
  // filtering them out. Triggered by either:
  //   (a) METABOT_PREFER_ENV_AUTH=true (explicit opt-in flag), or
  //   (b) presence of ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
  //       in the process env (auto-detect — user clearly wants env-based auth).
  // Use case: a bot points Claude Code at a third-party Anthropic-compatible
  // proxy while other bots on the same machine still use OAuth via
  // ~/.claude/.credentials.json (which can't be deleted).
  const preferEnvAuth =
    process.env.METABOT_PREFER_ENV_AUTH === 'true' ||
    !!(
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_BASE_URL
    );

  // Decide once whether to filter auth env vars
  const filterAuthVars = !preferEnvAuth && !!(explicitApiKey || hasCredentialsFile());

  return (options: SpawnOptions): SpawnedProcess => {
    // Merge provided env with process.env for a complete environment
    const baseEnv = options.env && Object.keys(options.env).length > 0
      ? { ...process.env, ...options.env }
      : { ...process.env };

    // Filter out env vars that interfere with auth or cause nested session errors
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      // Safe-pass list takes precedence over the broad CLAUDE* strip — these
      // are feature flags users opt into (agent teams, disable agent view, etc.)
      if (CLAUDE_ENV_PASSTHROUGH.has(key)) {
        env[key] = value;
        continue;
      }
      if (ALWAYS_FILTERED_PREFIXES.some(p => key.startsWith(p))) continue;
      if (filterAuthVars && AUTH_ENV_VARS.some(v => key.startsWith(v))) continue;
      env[key] = value;
    }

    // Inject explicit API key from bots.json (after filtering, so it takes effect)
    if (explicitApiKey) {
      env.ANTHROPIC_API_KEY = explicitApiKey;
    }
    for (const [key, value] of Object.entries(extraEnv ?? {})) {
      env[key] = value;
    }

    // Default-enable Claude Code Agent Teams. Without a real terminal there's
    // no tmux/iTerm2, so Agent Team agents must run in-process (controlled via the
    // `teammateMode` setting passed in queryOptions). Users can disable by
    // setting CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0 in MetaBot's parent env.
    if (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === undefined) {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }

    // Default-enable Claude Code auto-memory so Claude can write project
    // patterns / preferences / decisions to ~/.claude/projects/<projDir>/memory/
    // across sessions — the user-facing memory system the bot's skills
    // rely on. Users can disable by setting
    // CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 in MetaBot's parent env.
    // Pinning to '0' here makes the feature immune to upstream default
    // changes; the user shouldn't need to keep a magic line in .env.
    if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === undefined) {
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0';
    }
    applyClaudeChildEnvPolicy(env);

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return child as unknown as SpawnedProcess;
  };
}

export interface ApiContext {
  botName: string;
  chatId: string;
  /** Group chat member names — enables inter-bot communication prompt. */
  groupMembers?: string[];
  /** Group ID — used to build grouptalk chatIds for inter-bot communication. */
  groupId?: string;
}

function apiContextEnv(apiContext: ApiContext | undefined): Record<string, string> | undefined {
  if (!apiContext) return undefined;
  return {
    METABOT_BOT_NAME: apiContext.botName,
    METABOT_CHAT_ID: apiContext.chatId,
    ...(apiContext.groupId ? { METABOT_GROUP_ID: apiContext.groupId } : {}),
  };
}

/**
 * Apply 1M-context settings based on the effective model name in `queryOptions.model`:
 *
 *   - With `[1m]` suffix (e.g. `claude-opus-4-7[1m]`): set the matching
 *     `betas` flag. The SDK strips the suffix and forwards the beta header
 *     to the API. Belt-and-braces for API-key auth modes where the SDK
 *     may not auto-infer the beta from the suffix alone.
 *
 *   - Fable 5 has native 1M context in Claude Code, so leave its env alone
 *     and let the CLI use the model's default window.
 *
 *   - Without `[1m]` on legacy 1M-capable Opus/Sonnet models: keep the model
 *     at the standard 200K window. We set
 *     two env vars in the spawn env:
 *       • `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` — the binary's opt-out switch
 *         for the silent Max-tier 1M upgrade (opus-4-8, opus-4-7, opus-4-6,
 *         sonnet-4-6), which otherwise bills all tokens at 2× past 200K.
 *       • `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` — caps the auto-compact
 *         window. The CLI's window resolver takes `min(modelWindow, configured)`,
 *         so on 1M-capable auth this forces auto-compaction to fire near 200K
 *         (≈ window − 13K) instead of ~987K. NOTE: on auth where the model
 *         already reports a 200K window (e.g. a proxy that doesn't grant the
 *         1M tier — as observed for opus-4-8 behind some auth proxies),
 *         this is a no-op, since min(200K, 200K) = 200K. It's a defensive
 *         guard for the day this bot runs on 1M-capable auth. Pushing the
 *         window *above* the model's reported size isn't possible here: the
 *         only upward override is `DISABLE_COMPACT + CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
 *         which turns auto-compaction off entirely. Value must stay within
 *         the binary's 100K–1M bounds.
 *     (MetaBot's spawn handler merges `queryOptions.env` on top of
 *     `process.env`, so we only need to set the override keys. Both keys are
 *     in CLAUDE_ENV_PASSTHROUGH so the CLAUDE* env filter doesn't strip them.)
 *     Append `[1m]` to opt back in to the full 1M window.
 *
 * Must be called *after* any per-call `options.model` override so the
 * suffix detection sees the actually-effective model, not the bot default.
 */
export const DEFAULT_AUTO_COMPACT_WINDOW = '200000';
const FABLE_5_MODEL_RE = /^claude-fable-5(?:$|\[)/;

export function apply1MContextSettings(queryOptions: Record<string, unknown>): void {
  const model = queryOptions.model as string | undefined;
  if (model && FABLE_5_MODEL_RE.test(model)) {
    return;
  }
  if (model?.includes('[1m]')) {
    queryOptions.betas = ['context-1m-2025-08-07'];
  } else {
    const existingEnv = (queryOptions.env as Record<string, string> | undefined) ?? {};
    queryOptions.env = {
      ...existingEnv,
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: DEFAULT_AUTO_COMPACT_WINDOW,
    };
  }
}

/**
 * Events surfaced by Claude Code's experimental Agent Teams hooks
 * (TaskCreated / TaskCompleted / TeammateIdle). Used to drive the
 * Feishu / Web team panel without requiring the user to switch panes.
 */
export type TeamEvent =
  | {
      kind: 'task_created';
      taskId: string;
      subject: string;
      description?: string;
      teammate?: string;
      teamName?: string;
    }
  | {
      kind: 'task_completed';
      taskId: string;
      subject: string;
      teammate?: string;
      teamName?: string;
    }
  | {
      kind: 'teammate_idle';
      teammate: string;
      teamName: string;
    };

export interface ExecutorOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  abortController: AbortController;
  outputsDir?: string;
  apiContext?: ApiContext;
  /** Override maxTurns for this execution. */
  maxTurns?: number;
  /** Override model for this execution (e.g. faster model for voice calls). */
  model?: string;
  /** Per-turn reasoning effort override. Claude maps it to SDK `effort`; Codex maps it to model_reasoning_effort. */
  reasoningEffort?: CodexReasoningEffort | ClaudeEffort;
  /** Per-turn Codex approval policy override. Ignored by non-Codex executors. */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  /** Per-turn Codex sandbox override. Ignored by non-Codex executors. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Override allowed tools for this execution (empty array = no tools). */
  allowedTools?: string[];
  /**
   * /bytheway side-branch mode.
   * - fork: inherit main session history without writing back to it.
   * - continue: resume the remembered side-branch session.
   */
  oneShot?: 'fork' | 'continue';
  /** Called whenever Claude Code fires a team coordination hook. */
  onTeamEvent?: (event: TeamEvent) => void;
}

type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
};

const EXECUTOR_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveWorkerManagerMcpServer(): McpServerConfig | undefined {
  const builtCandidates = [
    path.resolve(EXECUTOR_MODULE_DIR, '../../mcp/worker-manager-mcp.js'),
    path.resolve(process.cwd(), 'dist/mcp/worker-manager-mcp.js'),
  ];
  for (const entrypoint of builtCandidates) {
    if (fs.existsSync(entrypoint)) {
      return {
        command: process.execPath,
        args: [entrypoint],
      };
    }
  }

  const sourceCandidates = [
    path.resolve(EXECUTOR_MODULE_DIR, '../../mcp/worker-manager-mcp.ts'),
    path.resolve(process.cwd(), 'src/mcp/worker-manager-mcp.ts'),
  ];
  for (const entrypoint of sourceCandidates) {
    if (fs.existsSync(entrypoint)) {
      return {
        command: process.execPath,
        args: ['--import', 'tsx', entrypoint],
      };
    }
  }

  return undefined;
}

function applyApiContextToMcpServer(server: McpServerConfig, apiContext: ApiContext): McpServerConfig {
  const apiPort = process.env.METABOT_API_PORT || process.env.API_PORT || '9100';
  const apiSecret = process.env.METABOT_API_SECRET || process.env.API_SECRET;
  return {
    ...server,
    env: {
      ...(server.env ?? {}),
      METABOT_API_URL: process.env.METABOT_API_URL || `http://localhost:${apiPort}`,
      ...(apiSecret ? { METABOT_API_SECRET: apiSecret } : {}),
      METABOT_BOT_NAME: apiContext.botName,
      METABOT_CHAT_ID: apiContext.chatId,
    },
  };
}

export function loadMcpServersWithApiContext(apiContext: ApiContext | undefined): Record<string, unknown> | undefined {
  if (!apiContext) return undefined;
  let configured: Record<string, McpServerConfig> = {};
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      mcpServers?: Record<string, McpServerConfig>;
    };
    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      configured = JSON.parse(JSON.stringify(settings.mcpServers)) as Record<string, McpServerConfig>;
    }
  } catch {
    configured = {};
  }

  const defaultWorkerManager = resolveWorkerManagerMcpServer();
  if (!configured['worker-manager'] && defaultWorkerManager) {
    configured['worker-manager'] = defaultWorkerManager;
  }

  const names = Object.keys(configured);
  if (names.length === 0) return undefined;
  for (const name of names) {
    configured[name] = applyApiContextToMcpServer(configured[name]!, apiContext);
  }
  return configured;
}

export type SDKMessage = {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
    }>;
  };
  // Result fields
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  errors?: string[];
  // Model usage from result message (per-model breakdown)
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number; costUSD: number }>;
  // Stream event fields
  event?: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
    };
    content_block?: {
      type: string;
      text?: string;
      name?: string;
      id?: string;
    };
  };
  parent_tool_use_id?: string | null;
};

export interface ExecutionHandle {
  stream: AsyncGenerator<SDKMessage>;
  sendAnswer(toolUseId: string, sessionId: string, answerText: string): void;
  /**
   * Resolve a pending AskUserQuestion PreToolUse hook with the user's answers.
   * Use this instead of sendAnswer when running in bypassPermissions mode —
   * sendAnswer enqueues a tool_result that never reaches the SDK because the
   * internal permission check short-circuits before auto-allow.
   */
  resolveQuestion(toolUseId: string, answers: Record<string, string>): void;
  finish(): void;
}

export class ClaudeExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  private buildQueryOptions(cwd: string, sessionId: string | undefined, abortController: AbortController, outputsDir?: string, apiContext?: ApiContext): Record<string, unknown> {
    const isRoot = process.getuid?.() === 0;
    const queryOptions: Record<string, unknown> = {
      ...resolveClaudePermissionOptions(this.config.claude.permissionMode, isRoot),
      cwd,
      abortController,
      includePartialMessages: true,
      // Load MCP servers and settings from user/project config files
      settingSources: ['user', 'project'],
      // Custom spawn filters CLAUDE* env vars (prevents nested session errors)
      // and injects an explicit ANTHROPIC_API_KEY when configured. The SDK
      // (>= 0.2.140) supplies the correct command in spawn options — for the
      // native Claude binary that's the binary itself; for legacy JS
      // entrypoints it's the Node executable.
      spawnClaudeCodeProcess: createSpawnFn(this.config.claude.apiKey, apiContextEnv(apiContext)),
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      // MetaBot has no terminal — split-pane (tmux/iTerm2) Agent Team display
      // doesn't apply. Force in-process so Agent Team agents run inside the same
      // session and surface via SDK message origin / TeammateIdle hooks.
      settings: { teammateMode: 'in-process' },
      // Periodic AI summaries for foreground/background subagents. The SDK
      // emits these as `task_progress.summary`; StreamProcessor already
      // forwards task events into the card's "Background" panel, so enabling
      // this immediately makes subagent cards richer (Agent View parity).
      agentProgressSummaries: true,
    };

    // Build system prompt appendix from sections
    const appendSections: string[] = [];

    if (outputsDir) {
      appendSections.push(`## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nUse \`cp\` via the Bash tool. The bridge will automatically send files placed there to the user.`);
    }

    if (apiContext) {
      // botName and chatId are per-session — inject into system prompt to avoid
      // race conditions when multiple chats run concurrently.
      // Port and secret are already set as METABOT_* env vars in config.ts.
      appendSections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`
      );

      // Agent Teams namespace guidance: the team config lives at
      // ~/.claude/teams/{name}/, which is shared across all bots and chats
      // on the same host. Tell the lead to namespace team names so concurrent
      // bots/chats don't collide.
      const teamNs = `${apiContext.botName}-${apiContext.chatId.slice(0, 8)}`;
      appendSections.push(
        [
          '## Agent Teams (experimental)',
          `When the user asks you to create an agent team, ALWAYS prefix the team name with \`${teamNs}-\` to avoid collisions with other MetaBot chats sharing this machine. For example: \`${teamNs}-research\`, \`${teamNs}-refactor\`.`,
          'Display mode is forced to `in-process` (no tmux/iTerm2 in MetaBot). Agent Team agents show up in the user\'s Feishu card via TeammateIdle / TaskCreated / TaskCompleted events — you don\'t need to walk the user through Shift+Down navigation.',
          'Clean up the team yourself when work is done so resources don\'t leak (`Clean up the team`).',
        ].join('\n')
      );

      // Group chat — tell the bot who else is in the group and how to talk to them
      if (apiContext.groupMembers && apiContext.groupMembers.length > 0) {
        const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
        const groupId = apiContext.groupId;
        if (groupId) {
          appendSections.push(
            `## Group Chat\nYou are in a group chat (group: ${groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`metabot talk <botName> grouptalk-${groupId}-<botName> "message"\`\nExample: \`metabot talk ${others[0]} grouptalk-${groupId}-${others[0]} "hello"\`\nIMPORTANT: Always use the grouptalk-${groupId}-<botName> chatId pattern when talking to other bots in this group.`
          );
        } else {
          appendSections.push(
            `## Group Chat\nYou are in a group chat with these bots: ${others.join(', ')}.\nUse \`metabot talk <botName> <chatId> "message"\` to communicate with other bots in the group.`
          );
        }
      }
    }

    if (appendSections.length > 0) {
      queryOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: '\n\n' + appendSections.join('\n\n'),
      };
    }
    if (this.config.pmPrompt) {
      appendSections.push(buildPmSystemPrompt());
      queryOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: '\n\n' + appendSections.join('\n\n'),
      };
    }
    const mcpServers = loadMcpServersWithApiContext(apiContext);
    if (mcpServers) queryOptions.mcpServers = mcpServers;

    if (this.config.claude.maxTurns !== undefined) {
      queryOptions.maxTurns = this.config.claude.maxTurns;
    }

    if (this.config.claude.maxBudgetUsd !== undefined) {
      queryOptions.maxBudgetUsd = this.config.claude.maxBudgetUsd;
    }

    if (this.config.claude.model) {
      queryOptions.model = this.config.claude.model;
    }

    if (this.config.claude.effort) {
      queryOptions.effort = this.config.claude.effort;
    }

    if (sessionId) {
      queryOptions.resume = sessionId;
    }

    return queryOptions;
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;

    this.logger.info({ cwd, hasSession: !!sessionId, outputsDir }, 'Starting Claude execution (multi-turn)');

    const inputQueue = new AsyncQueue<SDKUserMessage>();

    // Push the initial user message
    const initialMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user' as const,
        content: prompt,
      },
      parent_tool_use_id: null,
      session_id: sessionId || '',
    };
    inputQueue.enqueue(initialMessage);

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController, outputsDir, apiContext);
    if (options.maxTurns !== undefined) {
      queryOptions.maxTurns = options.maxTurns;
    }
    if (options.model) {
      queryOptions.model = options.model;
    }
    if (options.allowedTools !== undefined) {
      queryOptions.allowedTools = options.allowedTools;
    }
    if (options.reasoningEffort) {
      queryOptions.effort = options.reasoningEffort;
    }

    if (options.oneShot) {
      if (options.oneShot === 'fork' && sessionId) {
        queryOptions.forkSession = true;
      }
      queryOptions.disallowedTools = BYTHEWAY_DISALLOWED_MCP_TOOLS;
      const sp = queryOptions.systemPrompt as { type: string; preset: string; append?: string } | undefined;
      if (sp && typeof sp === 'object') {
        sp.append = (sp.append ?? '') + '\n\n' + BYTHEWAY_SYSTEM_NOTE;
      } else {
        queryOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: '\n\n' + BYTHEWAY_SYSTEM_NOTE,
        };
      }
    }

    apply1MContextSettings(queryOptions);

    // AskUserQuestion PreToolUse hook: the SDK marks AskUserQuestion as
    // requiresUserInteraction=true, so in bypassPermissions mode it is denied
    // before auto-allow can fire. We intercept the PreToolUse event, pause until
    // the bridge collects the user's answers, then return them as updatedInput.
    // Providing updatedInput satisfies the interaction requirement and the SDK
    // resolves the tool call with {answers} filled in.
    const pendingQuestionResolvers = new Map<string, (answers: Record<string, string>) => void>();

    const askUserQuestionHook = async (
      input: { hook_event_name: string; tool_name: string; tool_input: unknown; tool_use_id: string },
      _toolUseId: string | undefined,
      { signal }: { signal: AbortSignal },
    ): Promise<Record<string, unknown>> => {
      const toolInput = input.tool_input as Record<string, unknown>;
      const id = input.tool_use_id;

      const answers = await new Promise<Record<string, string>>((resolve) => {
        pendingQuestionResolvers.set(id, resolve);

        // Safety timeout: auto-resolve with empty answers after 6 minutes
        // (slightly longer than bridge's 5-minute QUESTION_TIMEOUT_MS) to
        // prevent indefinite hang if the bridge fails to deliver an answer.
        const timeout = setTimeout(() => {
          if (pendingQuestionResolvers.delete(id)) {
            logger.warn({ toolUseId: id }, 'AskUserQuestion hook timed out after 6 minutes — returning empty answers');
            resolve({});
          }
        }, 6 * 60 * 1000);

        const onAbort = () => {
          clearTimeout(timeout);
          pendingQuestionResolvers.delete(id);
          resolve({});
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...toolInput, answers },
        },
      };
    };

    // Agent Teams observation hooks. These never block — they just tap the
    // event so we can re-render the team panel in the Feishu / Web card.
    // Returning {} (no decision) lets the underlying action proceed.
    const onTeamEvent = options.onTeamEvent;
    const teamObserverHook = (kind: TeamEvent['kind']) => {
      return async (input: any): Promise<Record<string, unknown>> => {
        if (!onTeamEvent) return {};
        try {
          if (kind === 'task_created') {
            onTeamEvent({
              kind: 'task_created',
              taskId: input.task_id,
              subject: input.task_subject,
              description: input.task_description,
              teammate: input.teammate_name,
              teamName: input.team_name,
            });
          } else if (kind === 'task_completed') {
            onTeamEvent({
              kind: 'task_completed',
              taskId: input.task_id,
              subject: input.task_subject,
              teammate: input.teammate_name,
              teamName: input.team_name,
            });
          } else if (kind === 'teammate_idle') {
            onTeamEvent({
              kind: 'teammate_idle',
              teammate: input.teammate_name,
              teamName: input.team_name,
            });
          }
        } catch (err) {
          this.logger.warn({ err, kind }, 'Team observer hook callback threw');
        }
        return {};
      };
    };

    // ExitPlanMode: the native tool's checkPermissions returns
    // `{behavior: "ask", message: "Exit plan mode?"}` even under
    // bypassPermissions, and that "ask" routes through the can_use_tool
    // control_request — NOT through PreToolUse hooks. We auto-allow via
    // canUseTool; the bridge still ships the plan body to the user as a
    // separate card (StreamProcessor + sendPlanContent).
    queryOptions.canUseTool = makeCanUseTool(this.logger);

    queryOptions.hooks = {
      PreToolUse: [
        {
          matcher: 'AskUserQuestion',
          hooks: [askUserQuestionHook as any],
        },
      ],
      TaskCreated: [{ hooks: [teamObserverHook('task_created') as any] }],
      TaskCompleted: [{ hooks: [teamObserverHook('task_completed') as any] }],
      TeammateIdle: [{ hooks: [teamObserverHook('teammate_idle') as any] }],
    };

    const stream = query({
      prompt: inputQueue,
      options: queryOptions as any,
    });

    const logger = this.logger;

    async function* wrapStream(): AsyncGenerator<SDKMessage> {
      // Race each stream.next() against the abort signal so we exit immediately on /stop
      const abortPromise = new Promise<never>((_, reject) => {
        if (abortController.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        abortController.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });

      const iterator = stream[Symbol.asyncIterator]();

      try {
        while (true) {
          const result = await Promise.race([
            iterator.next(),
            abortPromise,
          ]);
          if (result.done) break;
          yield result.value as SDKMessage;
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || abortController.signal.aborted) {
          logger.info('Claude execution aborted');
          // Clean up the underlying iterator (non-blocking)
          try { iterator.return?.(undefined); } catch { /* ignore */ }
          return;
        }
        throw err;
      }
    }

    return {
      stream: wrapStream(),
      sendAnswer: (toolUseId: string, sid: string, answerText: string) => {
        logger.info({ toolUseId }, 'Sending answer to Claude');
        const answerMessage: SDKUserMessage = {
          type: 'user',
          message: {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: answerText,
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: sid,
        };
        inputQueue.enqueue(answerMessage);
      },
      resolveQuestion: (toolUseId: string, answers: Record<string, string>) => {
        const resolver = pendingQuestionResolvers.get(toolUseId);
        if (resolver) {
          pendingQuestionResolvers.delete(toolUseId);
          logger.info({ toolUseId, answerCount: Object.keys(answers).length }, 'Resolving AskUserQuestion hook');
          resolver(answers);
        } else {
          // Fallback: enqueue tool_result via inputQueue. Used if the hook
          // didn't capture this toolUseId (e.g., legacy sendAnswer path) or
          // the SDK version differs.
          logger.warn({ toolUseId }, 'No pending AskUserQuestion resolver — falling back to sendAnswer path');
          const answerMessage: SDKUserMessage = {
            type: 'user',
            message: {
              role: 'user' as const,
              content: [{ type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify({ answers }) }],
            },
            parent_tool_use_id: null,
            session_id: '',
          };
          inputQueue.enqueue(answerMessage);
        }
      },
      finish: () => {
        inputQueue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const { prompt, cwd, sessionId, abortController, outputsDir } = options;

    this.logger.info({ cwd, hasSession: !!sessionId }, 'Starting Claude execution');

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController, outputsDir);

    const stream = query({
      prompt,
      options: queryOptions as any,
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (abortController.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      abortController.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

    const iterator = stream[Symbol.asyncIterator]();

    try {
      while (true) {
        const result = await Promise.race([
          iterator.next(),
          abortPromise,
        ]);
        if (result.done) break;
        yield result.value as SDKMessage;
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        this.logger.info('Claude execution aborted');
        try { iterator.return?.(undefined); } catch { /* ignore */ }
        return;
      }
      throw err;
    }
  }
}
