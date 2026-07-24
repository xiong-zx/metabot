import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BotConfigBase, CodexBotConfig, CodexReasoningEffort } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type {
  ApiContext,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
} from '../claude/executor.js';
import {
  createCodexTranslatorState,
  translateCodexJsonEvent,
  type CodexJsonEvent,
} from './jsonl-translator.js';
import { prepareWorkdirCodexHome } from './codex-home.js';
import { resolveDefaultCodexSandbox } from './sandbox-support.js';
import { buildPmSystemPrompt } from '../pm-prompt.js';

const isWindows = process.platform === 'win32';
const FALLBACK_CODEX_CONTEXT_WINDOW = 272000;
const CODEX_AUTH_ENV_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
const CODEX_EXIT_GRACE_MS = 1000;

export function resolveCodexPath(explicitPath?: string): string {
  const override = explicitPath || process.env.CODEX_EXECUTABLE_PATH;
  if (override && existsSync(override)) return override;

  try {
    const cmd = isWindows ? 'where codex' : 'which codex';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    if (!isWindows) {
      const home = os.homedir();
      for (const candidate of [
        path.join(home, '.local', 'bin', 'codex'),
        '/usr/local/bin/codex',
        '/usr/bin/codex',
        '/opt/homebrew/bin/codex',
        path.join(home, '.npm-global', 'bin', 'codex'),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    return 'codex';
  }
}

interface CodexModelMetadata {
  model?: string;
  contextWindow?: number;
}

export const CODEX_MODEL_PROFILES: Record<string, { configOverrides: Record<string, number>; contextWindow: number }> = {
  'gpt-5.4': {
    configOverrides: {
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 820_000,
      model_max_output_tokens: 192_000,
    },
    contextWindow: 1_000_000,
  },
  'gpt-5.5': {
    configOverrides: {
      model_context_window: 272_000,
      model_auto_compact_token_limit: 258_400,
      model_max_output_tokens: 128_000,
    },
    contextWindow: 272_000,
  },
};

export function resolveCodexModelMetadata(codexConfig: CodexBotConfig, requestedModel?: string): CodexModelMetadata {
  const model = requestedModel
    || codexConfig.model
    || codexConfig.displayModel
    || readCodexConfigModel(codexConfig.profile)
    || readDefaultModelFromCache();
  return {
    model,
    contextWindow: codexConfig.contextWindow
      ?? (model ? CODEX_MODEL_PROFILES[model]?.contextWindow : undefined)
      ?? readCodexConfigContextWindow(codexConfig.profile)
      ?? readContextWindowFromCache(model)
      ?? (model ? FALLBACK_CODEX_CONTEXT_WINDOW : undefined),
  };
}

function readCodexConfigModel(profile?: string): string | undefined {
  const configPath = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'config.toml')
    : path.join(os.homedir(), '.codex', 'config.toml');
  try {
    const text = readFileSync(configPath, 'utf-8');
    const profileModel = profile ? readTomlSectionValue(text, `profiles.${profile}`, 'model') : undefined;
    return profileModel ?? readTomlTopLevelValue(text, 'model');
  } catch {
    return undefined;
  }
}

function readCodexConfigContextWindow(profile?: string): number | undefined {
  const configPath = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'config.toml')
    : path.join(os.homedir(), '.codex', 'config.toml');
  try {
    const text = readFileSync(configPath, 'utf-8');
    const raw = (profile ? readTomlSectionValue(text, `profiles.${profile}`, 'model_context_window') : undefined)
      ?? readTomlTopLevelValue(text, 'model_context_window');
    if (!raw) return undefined;
    const parsed = parseInt(raw.replace(/_/g, ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readDefaultModelFromCache(): string | undefined {
  return readModelsCache()?.models?.find((m) => m.slug)?.slug;
}

function readContextWindowFromCache(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const found = readModelsCache()?.models?.find((m) => m.slug === model);
  return found?.context_window ?? found?.max_context_window;
}

function readModelsCache(): { models?: Array<{ slug?: string; context_window?: number; max_context_window?: number }> } | undefined {
  const cachePath = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'models_cache.json')
    : path.join(os.homedir(), '.codex', 'models_cache.json');
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as { models?: Array<{ slug?: string; context_window?: number; max_context_window?: number }> };
  } catch {
    return undefined;
  }
}

interface CodexTokenCountSnapshot {
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  contextWindow?: number;
}

function readLastTokenCountFromSession(sessionId: string | undefined, codexHome?: string): CodexTokenCountSnapshot | undefined {
  if (!sessionId) return undefined;
  const sessionsDir = path.join(resolveCodexHome(codexHome), 'sessions');
  const sessionPath = findCodexSessionFile(sessionsDir, sessionId);
  if (!sessionPath) return undefined;

  try {
    const lines = readFileSync(sessionPath, 'utf-8').trimEnd().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      const rec = JSON.parse(lines[i]) as {
        type?: string;
        payload?: {
          type?: string;
          info?: {
            last_token_usage?: CodexTokenCountSnapshot['usage'];
            model_context_window?: number;
          };
        };
      };
      if (rec.type !== 'event_msg' || rec.payload?.type !== 'token_count') continue;
      const usage = rec.payload.info?.last_token_usage;
      if (!usage) return undefined;
      return {
        usage,
        contextWindow: rec.payload.info?.model_context_window,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveCodexHome(codexHome?: string): string {
  return codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function findCodexRolloutFile(sessionId: string, codexHome?: string): string | undefined {
  const sessionsDir = path.join(resolveCodexHome(codexHome), 'sessions');
  return findCodexSessionFile(sessionsDir, sessionId);
}

export function forkCodexThread(sessionId: string, codexHome?: string): { forkId: string; forkPath: string } | undefined {
  const src = findCodexRolloutFile(sessionId, codexHome);
  if (!src) return undefined;
  const forkId = randomUUID();
  const dst = path.join(path.dirname(src), path.basename(src).split(sessionId).join(forkId));
  try {
    const content = readFileSync(src, 'utf-8');
    writeFileSync(dst, content.split(sessionId).join(forkId));
    return { forkId, forkPath: dst };
  } catch {
    return undefined;
  }
}

const BYTHEWAY_CODEX_NOTE = [
  'SIDE BRANCH MODE (/bytheway). You are in a SIDE BRANCH session that',
  'inherits the main conversation history but does NOT write back to it.',
  'The user may later continue THIS branch with /btwc.',
  'File reading and editing are allowed under the bot\'s normal sandbox.',
  'Do NOT dispatch or control workers in side branches; worker_dispatch,',
  'worker_abort, worker_redirect, remind_me, and stop_auto_remind are',
  'off-limits by design. Checking status via worker_list is fine.',
  'If the task requires dispatching workers, tell the user to re-send it as',
  'a normal non-/bytheway message.',
].join('\n');

export function applyCodexRuntimeOverrides(
  base: CodexBotConfig,
  options: Pick<ExecutorOptions, 'approvalPolicy' | 'sandbox'>,
): CodexBotConfig {
  if (!options.approvalPolicy && !options.sandbox) return base;
  return {
    ...base,
    dangerouslyBypassApprovalsAndSandbox: false,
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
  };
}

export function readCodexLastTokenUsage(
  sessionId: string,
  codexHome?: string,
): { inputTokens: number; cachedInputTokens: number; outputTokens: number; contextWindow?: number } | undefined {
  const file = findCodexRolloutFile(sessionId, codexHome);
  if (!file) return undefined;
  try {
    const fd = openSync(file, 'r');
    let tail: string;
    try {
      const size = fstatSync(fd).size;
      const readLen = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, size - readLen);
      tail = buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      try {
        const parsed = JSON.parse(lines[i]) as {
          payload?: {
            type?: string;
            info?: {
              last_token_usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
              model_context_window?: number;
            };
          };
        };
        const info = parsed.payload?.type === 'token_count' ? parsed.payload.info : undefined;
        const last = info?.last_token_usage;
        if (last) {
          return {
            inputTokens: last.input_tokens ?? 0,
            cachedInputTokens: last.cached_input_tokens ?? 0,
            outputTokens: last.output_tokens ?? 0,
            contextWindow: info?.model_context_window,
          };
        }
      } catch {
        // Partial tail line; continue scanning.
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function findCodexSessionFile(root: string, sessionId: string): string | undefined {
  try {
    if (!existsSync(root)) return undefined;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        let stat;
        try { stat = statSync(fullPath); } catch { continue; }
        if (stat.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.endsWith('.jsonl') && entry.includes(sessionId)) {
          return fullPath;
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function applyTokenCountSnapshot(message: SDKMessage, snapshot: CodexTokenCountSnapshot | undefined): SDKMessage {
  if (!snapshot?.usage || !message.modelUsage) return message;
  const model = Object.keys(message.modelUsage)[0];
  if (!model) return message;
  const outputTokens = snapshot.usage.output_tokens ?? 0;
  const inputTokens = typeof snapshot.usage.total_tokens === 'number'
    ? Math.max(0, snapshot.usage.total_tokens - outputTokens)
    : snapshot.usage.input_tokens ?? 0;
  return {
    ...message,
    modelUsage: {
      ...message.modelUsage,
      [model]: {
        ...message.modelUsage[model],
        inputTokens,
        outputTokens,
        contextWindow: snapshot.contextWindow ?? message.modelUsage[model].contextWindow,
      },
    },
  };
}

function readTomlTopLevelValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) return undefined;
    const value = parseTomlStringAssignment(trimmed, key);
    if (value) return value;
  }
  return undefined;
}

function readTomlSectionValue(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      inSection = header[1] === section;
      continue;
    }
    if (!inSection) continue;
    const value = parseTomlStringAssignment(trimmed, key);
    if (value) return value;
  }
  return undefined;
}

function parseTomlStringAssignment(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`^${key}\\s*=\\s*(.+?)(?:\\s+#.*)?$`));
  if (!match) return undefined;
  const raw = match[1].trim();
  const quoted = raw.match(/^["'](.+)["']$/);
  return quoted ? quoted[1] : raw;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function extraArgsContainConfigKey(extraArgs: string[] | undefined, key: string): boolean {
  return (extraArgs ?? []).some((arg) => arg === key || arg.startsWith(`${key}=`));
}

/**
 * Build the environment for the Codex CLI child process.
 *
 * When `codex.apiKey` is configured, normalize it to OPENAI_API_KEY and remove
 * other Codex/OpenAI auth env vars first. Codex reports an auth conflict when
 * multiple supported auth env vars are present, so explicit per-bot config
 * must win cleanly over inherited .env / host values.
 */
export function buildCodexEnv(
  codexConfig: CodexBotConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(codexConfig.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }

  const explicitApiKey = codexConfig.apiKey?.trim();
  if (explicitApiKey) {
    for (const key of CODEX_AUTH_ENV_VARS) delete env[key];
    env.OPENAI_API_KEY = explicitApiKey;
  }

  return env;
}

function applyApiContextEnv(env: Record<string, string>, apiContext: ApiContext | undefined): void {
  if (!apiContext) return;
  env.METABOT_BOT_NAME = apiContext.botName;
  env.METABOT_CHAT_ID = apiContext.chatId;
  if (apiContext.groupId) env.METABOT_GROUP_ID = apiContext.groupId;
}

/**
 * Build the argv array for `codex exec`. Exported for unit testing.
 * Values are passed as discrete argv entries (never through a shell), so
 * `extraArgs` / `profile` / `model` cannot introduce shell-injection even
 * if they contain metacharacters — but they will still be visible to the
 * Codex CLI as literal arguments.
 */
export function buildCodexArgs(
  codexConfig: CodexBotConfig,
  cwd: string,
  prompt: string,
  sessionId: string | undefined,
  model: string | undefined,
  reasoningEffort?: CodexReasoningEffort,
  developerInstructions?: string,
): string[] {
  const args: string[] = [];

  if (codexConfig.dangerouslyBypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-a', codexConfig.approvalPolicy ?? 'never');
    args.push('--sandbox', codexConfig.sandbox ?? resolveDefaultCodexSandbox());
  }

  args.push('-C', cwd);
  if (model) args.push('-m', model);
  if (codexConfig.profile) args.push('-p', codexConfig.profile);
  if (codexConfig.baseUrl) args.push('-c', `openai_base_url=${tomlString(codexConfig.baseUrl)}`);

  const modelProfile = model ? CODEX_MODEL_PROFILES[model] : undefined;
  if (modelProfile) {
    for (const [key, value] of Object.entries(modelProfile.configOverrides)) {
      if (extraArgsContainConfigKey(codexConfig.extraArgs, key)) continue;
      args.push('-c', `${key}=${value}`);
    }
  }

  const effectiveEffort = reasoningEffort ?? codexConfig.reasoningEffort;
  if (effectiveEffort && !extraArgsContainConfigKey(codexConfig.extraArgs, 'model_reasoning_effort')) {
    args.push('-c', `model_reasoning_effort=${tomlString(effectiveEffort)}`);
  }
  if (developerInstructions) {
    args.push('-c', `developer_instructions=${tomlString(developerInstructions)}`);
  }
  for (const extraArg of codexConfig.extraArgs ?? []) args.push(extraArg);

  args.push('exec');
  if (sessionId) {
    args.push('resume', '--json', '--skip-git-repo-check', sessionId, prompt);
  } else {
    args.push('--json', '--color', 'never', '--skip-git-repo-check', prompt);
  }
  return args;
}

export class CodexExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;
    const codexConfig = applyCodexRuntimeOverrides(this.config.codex ?? {}, options);
    const model = options.model ?? codexConfig.model;
    const modelMetadata = resolveCodexModelMetadata(codexConfig, model);
    const effectiveCodexHome = codexConfig.env?.CODEX_HOME
      ?? (codexConfig.homeScope === 'workdir' ? prepareWorkdirCodexHome(cwd, this.logger) : undefined);
    let effectiveSessionId = sessionId;
    let fullPrompt = prompt;
    if (options.oneShot) {
      fullPrompt = `${BYTHEWAY_CODEX_NOTE}\n\n${prompt}`;
      if (options.oneShot === 'fork' && sessionId) {
        const fork = forkCodexThread(sessionId, effectiveCodexHome);
        if (fork) {
          effectiveSessionId = fork.forkId;
          this.logger.info({ mainThread: sessionId, forkThread: fork.forkId }, '/bytheway: forked codex thread');
        } else {
          effectiveSessionId = undefined;
          fullPrompt = `(The main conversation history could not be forked for this side query; answer from scratch.)\n\n${fullPrompt}`;
          this.logger.warn({ sessionId }, '/bytheway: codex rollout not found; running without history');
        }
      }
    }
    const developerInstructions = this.buildDeveloperInstructions(outputsDir, apiContext, !!this.config.pmPrompt);
    const queue = new AsyncQueue<SDKMessage>();
    const state = createCodexTranslatorState({
      model: modelMetadata.model,
      contextWindow: modelMetadata.contextWindow,
    });
    // Resolve the sandbox here rather than leaving it to buildCodexArgs' own
    // fallback, so the degrade warning is emitted through this bot's logger.
    const sandbox = codexConfig.sandbox ?? resolveDefaultCodexSandbox(this.logger);
    const args = buildCodexArgs(
      { ...codexConfig, sandbox },
      cwd,
      fullPrompt,
      effectiveSessionId,
      model,
      options.reasoningEffort as CodexReasoningEffort | undefined,
      developerInstructions,
    );
    const startTime = Date.now();
    let child: ChildProcess | undefined;
    let sawResult = false;
    let pendingResult: SDKMessage | undefined;
    let stderr = '';
    let stdoutBuffer = '';
    let terminalResultDelivered = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;

    const executable = resolveCodexPath(codexConfig.executable);
    this.logger.info({ cwd, hasSession: !!effectiveSessionId, outputsDir, executable, engine: 'codex' }, 'Starting Codex execution');

    const finishWithError = (message: string): void => {
      if (terminalResultDelivered) return;
      sawResult = true;
      terminalResultDelivered = true;
      queue.enqueue({
        type: 'result',
        subtype: abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
        session_id: state.sessionId ?? effectiveSessionId,
        duration_ms: Date.now() - startTime,
        result: state.lastAgentText,
        is_error: true,
        errors: [message],
      });
      queue.finish();
    };

    const deliverPendingResult = (): void => {
      if (!pendingResult || terminalResultDelivered) return;
      terminalResultDelivered = true;
      const snapshot = state.lastUsage
        ? { usage: state.lastUsage, contextWindow: state.contextWindow }
        : readLastTokenCountFromSession(state.sessionId ?? effectiveSessionId, effectiveCodexHome);
      queue.enqueue(applyTokenCountSnapshot(pendingResult, snapshot));
      queue.finish();

      exitTimer = setTimeout(() => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        this.logger.warn({ pid: child.pid }, 'Codex emitted a terminal result but did not exit; terminating process');
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, CODEX_EXIT_GRACE_MS);
        killTimer.unref?.();
      }, CODEX_EXIT_GRACE_MS);
      exitTimer.unref?.();
    };

    const emitEvent = (event: CodexJsonEvent): void => {
      const messages = translateCodexJsonEvent(event, state);
      for (const message of messages) {
        if (message.type === 'result') {
          sawResult = true;
          pendingResult = message;
          deliverPendingResult();
        } else {
          queue.enqueue(message);
        }
      }
    };

    const processStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          emitEvent(JSON.parse(line) as CodexJsonEvent);
        } catch (err) {
          this.logger.warn({ err, line }, 'Failed to parse Codex JSONL event');
        }
      }
    };

    try {
      const env = buildCodexEnv(codexConfig);
      if (effectiveCodexHome) env.CODEX_HOME = effectiveCodexHome;
      applyApiContextEnv(env, apiContext);
      child = spawn(executable, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      finishWithError(err?.message || String(err));
      queue.finish();
    }

    if (child) {
      if (abortController.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        abortController.signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true });
      }

      child.stdout?.on('data', processStdout);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        finishWithError(err.message);
      });
      child.on('close', (code, signal) => {
        if (exitTimer) clearTimeout(exitTimer);
        if (stdoutBuffer.trim()) {
          try {
            emitEvent(JSON.parse(stdoutBuffer) as CodexJsonEvent);
          } catch (err) {
            this.logger.warn({ err, line: stdoutBuffer }, 'Failed to parse final Codex JSONL event');
          }
        }
        if (code !== 0 && !sawResult) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          finishWithError(`Codex exited with ${signal ? `signal ${signal}` : `code ${code}`}${suffix}`);
        } else {
          deliverPendingResult();
        }
        if (stderr.trim()) {
          this.logger.debug({ stderr: stderr.trim() }, 'Codex stderr');
        }
        queue.finish();
      });
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'codex' }, 'sendAnswer called on Codex executor — not implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'codex' }, 'resolveQuestion called on Codex executor — not implemented');
      },
      finish: () => {
        if (exitTimer) clearTimeout(exitTimer);
        if (child && !child.killed) child.kill('SIGTERM');
        queue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const msg of handle.stream) {
        yield msg;
      }
    } finally {
      handle.finish();
    }
  }

  private buildDeveloperInstructions(
    outputsDir: string | undefined,
    apiContext: ApiContext | undefined,
    includePmPrompt: boolean,
  ): string | undefined {
    const sections: string[] = [];

    if (outputsDir) {
      sections.push(
        `## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nThe bridge will automatically send files placed there to the user.`,
      );
    }

    if (apiContext) {
      sections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`,
      );

      if (apiContext.groupMembers && apiContext.groupMembers.length > 0) {
        const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
        if (apiContext.groupId) {
          sections.push(
            `## Group Chat\nYou are in a group chat (group: ${apiContext.groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`metabot talk <botName> grouptalk-${apiContext.groupId}-<botName> "message"\``,
          );
        }
      }
    }

    if (includePmPrompt) {
      sections.push(buildPmSystemPrompt());
    }

    return sections.length > 0 ? sections.join('\n\n') : undefined;
  }
}
