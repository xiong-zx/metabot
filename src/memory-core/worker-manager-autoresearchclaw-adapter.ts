import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineName } from '../config.js';
import type {
  CodexApprovalPolicy,
  CodexSandbox,
  DispatchInput,
  WorkerReasoningEffort,
} from '../workers/worker-manager.js';
import type {
  AutoResearchClawWorkerAdapter,
  ResearchWorkerDispatchInput,
  ResearchWorkerHandle,
} from './research-loop-runner.js';
import { MemoryCoreError } from './event-ledger.js';

export interface WorkerManagerLike {
  dispatch(input: DispatchInput): {
    id: string;
    workerChatId: string;
    workingDirectory: string;
    status: 'running' | 'completed' | 'failed' | 'aborted';
  };
  getWorker(id: string):
    | {
        id: string;
        workerChatId: string;
        workingDirectory: string;
        status: 'running' | 'completed' | 'failed' | 'aborted';
        resultSummary?: string;
        error?: string;
      }
    | undefined;
}

export interface WorkerManagerAutoResearchClawAdapterOptions {
  workerManager: WorkerManagerLike;
  botName: string;
  pmChatId: string;
  outputFileName?: string;
  model?: string;
  engine?: EngineName;
  reasoningEffort?: WorkerReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandbox;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  pollIntervalMs?: number;
  collectTimeoutMs?: number;
  artifactGraceMs?: number;
}

export class WorkerManagerAutoResearchClawAdapter implements AutoResearchClawWorkerAdapter {
  private readonly configuredOutputFileName: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly collectTimeoutMs: number;
  private readonly artifactGraceMs: number;

  constructor(private readonly options: WorkerManagerAutoResearchClawAdapterOptions) {
    this.configuredOutputFileName =
      options.outputFileName === undefined ? undefined : normalizeOutputFileName(options.outputFileName);
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.collectTimeoutMs = options.collectTimeoutMs ?? 6 * 60 * 60 * 1000;
    this.artifactGraceMs = options.artifactGraceMs ?? 30_000;
  }

  async dispatch(input: ResearchWorkerDispatchInput): Promise<ResearchWorkerHandle> {
    const artifact = this.resolveArtifact(input.projectRoot, input.runId);
    fs.mkdirSync(path.dirname(artifact.absolutePath), { recursive: true });
    const record = this.options.workerManager.dispatch({
      botName: this.options.botName,
      pmChatId: this.options.pmChatId,
      workingDirectory: input.projectRoot,
      prompt: withArtifactInstruction(input.prompt, artifact.relativePath),
      label: `autoresearchclaw-${input.projectId}-${input.runId}`,
      model: this.options.model,
      engine: this.options.engine,
      reasoningEffort: this.options.reasoningEffort,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandbox,
      timeoutMs: this.options.timeoutMs,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });
    return {
      workerId: record.id,
      workerChatId: record.workerChatId,
      artifactUri: pathToFileUri(artifact.absolutePath),
      metadata: {
        run_id: input.runId,
        output_file_name: artifact.relativePath,
        worker_manager_label: `autoresearchclaw-${input.projectId}-${input.runId}`,
      },
    };
  }

  async collectOutput(handle: ResearchWorkerHandle): Promise<unknown> {
    const started = Date.now();
    let artifactPath: string | undefined;
    let lastInvalidArtifact: unknown;
    while (Date.now() - started <= this.collectTimeoutMs) {
      const record = this.options.workerManager.getWorker(handle.workerId);
      if (record === undefined) {
        throw new Error(`Worker not found: ${handle.workerId}`);
      }

      artifactPath ??= this.resolveArtifactPath(handle, record);
      const artifact = tryReadJsonArtifact(artifactPath);
      if (artifact.status === 'parsed') {
        return artifact.value;
      }
      if (artifact.status === 'invalid') {
        lastInvalidArtifact = artifact.error;
      }

      if (record.status !== 'running') {
        if (
          artifact.status === 'missing' &&
          (await waitForFile(artifactPath, this.artifactGraceMs, this.pollIntervalMs))
        ) {
          return readJsonArtifact(artifactPath);
        }
        if (lastInvalidArtifact !== undefined) {
          throw new Error(
            `AutoResearchClaw output artifact is not valid JSON: ${artifactPath}: ${errorMessage(lastInvalidArtifact)}`,
          );
        }
        if (record.status !== 'completed') {
          throw new Error(
            `AutoResearchClaw worker ${record.id} ${record.status}: ${
              record.error ?? 'no error detail'
            }; output artifact not found: ${artifactPath}`,
          );
        }
        throw new Error(`AutoResearchClaw output artifact not found: ${artifactPath}`);
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`Timed out waiting for AutoResearchClaw worker output: ${handle.workerId}`);
  }

  private resolveArtifactPath(
    handle: ResearchWorkerHandle,
    record: NonNullable<ReturnType<WorkerManagerLike['getWorker']>>,
  ): string {
    const artifactPath = fileUriToPath(
      handle.artifactUri ??
        pathToFileUri(
          this.resolveArtifact(record.workingDirectory, handle.metadata?.run_id as string | undefined).absolutePath,
        ),
    );
    ensureInsideRoot(artifactPath, record.workingDirectory);
    return artifactPath;
  }

  private resolveArtifact(
    projectRoot: string,
    runId: string | undefined,
  ): { relativePath: string; absolutePath: string } {
    const relativePath =
      this.configuredOutputFileName ??
      path.join('.metabot-memory', 'autoresearchclaw', `${safeRunId(runId)}-output.json`);
    const absolutePath = path.resolve(projectRoot, relativePath);
    ensureInsideRoot(absolutePath, projectRoot);
    return { relativePath, absolutePath };
  }
}

function withArtifactInstruction(prompt: string, outputFileName: string): string {
  return [
    prompt,
    '',
    '## Required Output Artifact',
    `Write the final AutoResearchClaw JSON object to ${outputFileName} in the project root.`,
    'Do not rely on chat text as the system-of-record output; the JSON artifact is required for ingestion.',
    'Do not dispatch nested workers, subagents, reminders, or metabot talk tasks. This worker must write the artifact itself before it exits.',
  ].join('\n');
}

function pathToFileUri(filePath: string): string {
  return `file://${path.resolve(filePath)}`;
}

function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    throw new Error(`Unsupported artifact URI: ${uri}`);
  }
  return uri.slice('file://'.length);
}

function normalizeOutputFileName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new MemoryCoreError('invalid_output_file_name', 'outputFileName must be non-empty');
  }
  if (path.isAbsolute(normalized)) {
    throw new MemoryCoreError('invalid_output_file_name', 'outputFileName must be relative to the project root');
  }
  const parts = normalized.split(/[\\/]+/u);
  if (parts.some((part) => part === '..' || part.length === 0)) {
    throw new MemoryCoreError(
      'invalid_output_file_name',
      'outputFileName cannot contain empty or parent path segments',
    );
  }
  return parts.join(path.sep);
}

function ensureInsideRoot(candidate: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MemoryCoreError('artifact_path_escapes_root', `Artifact path escapes project root: ${resolvedCandidate}`);
  }
}

function safeRunId(runId: string | undefined): string {
  const value = runId ?? 'run';
  return value.replace(/[^a-zA-Z0-9_.-]+/gu, '_').slice(0, 80) || 'run';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryReadJsonArtifact(
  filePath: string,
): { status: 'missing' } | { status: 'invalid'; error: unknown } | { status: 'parsed'; value: unknown } {
  if (!fs.existsSync(filePath)) {
    return { status: 'missing' };
  }
  try {
    return { status: 'parsed', value: readJsonArtifact(filePath) };
  } catch (error) {
    return { status: 'invalid', error };
  }
}

function readJsonArtifact(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

async function waitForFile(filePath: string, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await sleep(Math.max(1, Math.min(pollIntervalMs, 1000)));
  }
  return fs.existsSync(filePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
