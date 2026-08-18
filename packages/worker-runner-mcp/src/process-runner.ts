import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { KIMI_PROMPT_MAX_BYTES, renderWorkerPrompt, renderedPromptBytes } from './prompt.js';
import type {
  ProcessLaunchHooks,
  ProcessLaunchSpec,
  ProcessResult,
  ProcessRunner,
  RunningProcess,
  WorkerEngine,
} from './types.js';

const DEFAULT_SAFE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'KIMI_CODE_HOME',
] as const;

const FORBIDDEN_ENV_NAME =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API|ADMIN|AUTH|CALLBACK|CAPABILIT(?:Y|IES)|PRINCIPAL|CREDENTIALS?|COOKIE|SESSION|ACCESS_KEY|PRIVATE_KEY)(_|$)|^METABOT_(WORKER|ARC)_/i;

export interface NodeCliProcessRunnerConfig {
  executables?: Partial<Record<WorkerEngine, string>>;
  maxOutputBytes?: number;
  killGraceMs?: number;
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexApprovalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  claudePermissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';
  sourceEnv?: NodeJS.ProcessEnv;
  safeEnvAllowlist?: string[];
}

export interface CommandSpec {
  command: string;
  args: string[];
  stdin?: string;
}

interface ActiveChild {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<ProcessResult>;
}

export class NodeCliProcessRunner implements ProcessRunner {
  private readonly active = new Map<number, ActiveChild>();
  private readonly executables: Record<WorkerEngine, string>;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly codexSandbox: NonNullable<NodeCliProcessRunnerConfig['codexSandbox']>;
  private readonly codexApprovalPolicy: NonNullable<NodeCliProcessRunnerConfig['codexApprovalPolicy']>;
  private readonly claudePermissionMode: NonNullable<NodeCliProcessRunnerConfig['claudePermissionMode']>;
  private readonly childEnv: NodeJS.ProcessEnv;

  constructor(config: NodeCliProcessRunnerConfig = {}) {
    this.executables = {
      codex: config.executables?.codex ?? 'codex',
      claude: config.executables?.claude ?? 'claude',
      kimi: config.executables?.kimi ?? 'kimi',
    };
    this.maxOutputBytes = config.maxOutputBytes ?? 1_048_576;
    this.killGraceMs = config.killGraceMs ?? 2_000;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new Error('maxOutputBytes must be a positive integer');
    }
    if (!Number.isSafeInteger(this.killGraceMs) || this.killGraceMs < 1) {
      throw new Error('killGraceMs must be a positive integer');
    }
    this.codexSandbox = config.codexSandbox ?? 'workspace-write';
    this.codexApprovalPolicy = config.codexApprovalPolicy ?? 'never';
    this.claudePermissionMode = config.claudePermissionMode ?? 'auto';
    this.childEnv = buildSanitizedEnv(config.sourceEnv ?? process.env, config.safeEnvAllowlist ?? []);
  }

  async launch(spec: ProcessLaunchSpec, hooks: ProcessLaunchHooks): Promise<RunningProcess> {
    const command = this.buildCommand(spec);
    const stdout = new BoundedCollector(this.maxOutputBytes);
    const stderr = new BoundedCollector(this.maxOutputBytes);
    const child = spawn(command.command, command.args, {
      cwd: spec.workdir,
      env: this.childEnv,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let spawned = false;
    let settled = false;
    let resolveCompletion!: (result: ProcessResult) => void;
    const completion = new Promise<ProcessResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const finish = (result: Pick<ProcessResult, 'exitCode' | 'signal' | 'error'>): void => {
      if (settled) return;
      settled = true;
      if (child.pid) this.active.delete(child.pid);
      resolveCompletion({
        ...result,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.append(chunk);
      hooks.onActivity();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.append(chunk);
      hooks.onActivity();
    });
    child.stdin.on('error', (error) => stderr.append(Buffer.from(`stdin error: ${error.message}\n`)));
    child.once('close', (exitCode, signal) => {
      finish({
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal ? { signal } : {}),
      });
    });

    return await new Promise<RunningProcess>((resolve, reject) => {
      child.once('spawn', () => {
        spawned = true;
        const pid = child.pid;
        if (!pid) {
          reject(new Error(`CLI process for ${spec.engine} started without a pid`));
          return;
        }
        this.active.set(pid, { child, completion });
        hooks.onActivity();
        child.stdin.end(command.stdin, () => {
          if (spec.engine === 'codex') spec.rulesPack?.markInjected();
        });
        resolve({ pid, completion });
      });
      child.once('error', (error) => {
        if (!spawned) {
          settled = true;
          reject(error);
          return;
        }
        finish({ error: error.message });
      });
    });
  }

  async abort(pid: number): Promise<void> {
    const active = this.active.get(pid);
    if (!active) return;
    this.kill(pid, 'SIGTERM');
    await Promise.race([active.completion.then(() => undefined), delay(this.killGraceMs)]);
    if (this.active.has(pid)) this.kill(pid, 'SIGKILL');
  }

  buildCommand(spec: ProcessLaunchSpec): CommandSpec {
    const workerPrompt = renderWorkerPrompt(spec.prompt, spec.outputContract);
    const prompt =
      spec.engine === 'codex' && spec.rulesPack?.injectionText
        ? `${spec.rulesPack.injectionText}\n\n---\n\n${workerPrompt}`
        : workerPrompt;
    switch (spec.engine) {
      case 'codex':
        return {
          command: this.executables.codex,
          args: [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--sandbox',
            this.codexSandbox,
            '--config',
            `approval_policy=${JSON.stringify(this.codexApprovalPolicy)}`,
            ...(spec.model ? ['--model', spec.model] : []),
            '-',
          ],
          stdin: prompt,
        };
      case 'claude':
        return {
          command: this.executables.claude,
          args: [
            '--print',
            '--output-format',
            'text',
            '--no-session-persistence',
            '--permission-mode',
            this.claudePermissionMode,
            ...(spec.model ? ['--model', spec.model] : []),
          ],
          stdin: prompt,
        };
      case 'kimi':
        if (renderedPromptBytes(spec.prompt, spec.outputContract) > KIMI_PROMPT_MAX_BYTES) {
          throw new Error(`Kimi rendered prompt exceeds the ${KIMI_PROMPT_MAX_BYTES}-byte argv safety limit`);
        }
        return {
          command: this.executables.kimi,
          args: [...(spec.model ? ['--model', spec.model] : []), '--prompt', prompt, '--output-format', 'text'],
        };
    }
  }

  private kill(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

export function buildSanitizedEnv(source: NodeJS.ProcessEnv, extraAllowlist: string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set([...DEFAULT_SAFE_ENV, ...extraAllowlist].map((name) => name.trim()).filter(Boolean));
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (FORBIDDEN_ENV_NAME.test(name)) continue;
    const value = source[name];
    if (typeof value === 'string' && !value.includes('\0')) result[name] = value;
  }
  return result;
}

class BoundedCollector {
  private readonly chunks: Buffer[] = [];
  private keptBytes = 0;
  private totalBytes = 0;

  constructor(private readonly limit: number) {}

  get truncated(): boolean {
    return this.totalBytes > this.keptBytes;
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    const remaining = this.limit - this.keptBytes;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    this.chunks.push(kept);
    this.keptBytes += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
