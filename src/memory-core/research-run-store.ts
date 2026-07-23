import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_MEMORY_DIR, MemoryCoreError } from './event-ledger.js';

export type ResearchRunStatus =
  | 'started'
  | 'context_ready'
  | 'worker_dispatched'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'aborted';

export interface ResearchRunRecord {
  id: string;
  project_id: string;
  project_root: string;
  task: string;
  domain?: string;
  status: ResearchRunStatus;
  context_pack_id?: string;
  worker_id?: string;
  worker_chat_id?: string;
  artifact_uri?: string;
  output_summary?: string;
  error_messages: string[];
  artifact_ids: string[];
  started_at: string;
  updated_at: string;
  completed_at?: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchArtifactRecord {
  id: string;
  run_id: string;
  project_id: string;
  uri: string;
  summary?: string;
  kind?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface StartResearchRunInput {
  id: string;
  projectId: string;
  projectRoot: string;
  task: string;
  domain?: string;
  now?: Date;
  metadata?: Record<string, unknown>;
}

export interface UpdateResearchRunInput {
  status?: ResearchRunStatus;
  contextPackId?: string;
  workerId?: string;
  workerChatId?: string;
  artifactUri?: string;
  outputSummary?: string;
  errorMessages?: string[];
  artifactIds?: string[];
  completedAt?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface IndexResearchArtifactInput {
  id: string;
  runId: string;
  projectId: string;
  uri: string;
  summary?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface ResearchRunStoreLike {
  startRun(input: StartResearchRunInput): ResearchRunRecord;
  updateRun(runId: string, input: UpdateResearchRunInput): ResearchRunRecord;
  indexArtifact(input: IndexResearchArtifactInput): ResearchArtifactRecord;
}

export class ResearchRunStore implements ResearchRunStoreLike {
  constructor(
    private readonly rootDir: string,
    private readonly memoryDirName = DEFAULT_MEMORY_DIR,
  ) {}

  get memoryDir(): string {
    return path.join(this.rootDir, this.memoryDirName);
  }

  get runsPath(): string {
    return path.join(this.memoryDir, 'research-runs.json');
  }

  get artifactIndexPath(): string {
    return path.join(this.memoryDir, 'artifact-index.jsonl');
  }

  startRun(input: StartResearchRunInput): ResearchRunRecord {
    const runs = this.readRuns();
    const existing = runs.find((run) => run.id === input.id);
    if (existing !== undefined) {
      return existing;
    }

    const now = (input.now ?? new Date()).toISOString();
    const run: ResearchRunRecord = {
      id: input.id,
      project_id: input.projectId,
      project_root: input.projectRoot,
      task: input.task,
      domain: input.domain,
      status: 'started',
      error_messages: [],
      artifact_ids: [],
      started_at: now,
      updated_at: now,
      metadata: input.metadata,
    };
    this.writeRuns([...runs, run]);
    return run;
  }

  updateRun(runId: string, input: UpdateResearchRunInput): ResearchRunRecord {
    const runs = this.readRuns();
    const index = runs.findIndex((run) => run.id === runId);
    if (index < 0) {
      throw new MemoryCoreError('research_run_not_found', `Research run not found: ${runId}`);
    }

    const existing = runs[index]!;
    const updated: ResearchRunRecord = {
      ...existing,
      status: input.status ?? existing.status,
      context_pack_id: input.contextPackId ?? existing.context_pack_id,
      worker_id: input.workerId ?? existing.worker_id,
      worker_chat_id: input.workerChatId ?? existing.worker_chat_id,
      artifact_uri: input.artifactUri ?? existing.artifact_uri,
      output_summary: input.outputSummary ?? existing.output_summary,
      error_messages: input.errorMessages ?? existing.error_messages,
      artifact_ids: input.artifactIds ?? existing.artifact_ids,
      completed_at: input.completedAt ?? existing.completed_at,
      updated_at: (input.now ?? new Date()).toISOString(),
      metadata: mergeMetadata(existing.metadata, input.metadata),
    };
    runs[index] = updated;
    this.writeRuns(runs);
    return updated;
  }

  getRun(runId: string): ResearchRunRecord | undefined {
    return this.readRuns().find((run) => run.id === runId);
  }

  listRuns(projectId?: string): ResearchRunRecord[] {
    const runs = this.readRuns();
    return projectId === undefined ? runs : runs.filter((run) => run.project_id === projectId);
  }

  indexArtifact(input: IndexResearchArtifactInput): ResearchArtifactRecord {
    this.ensureMemoryDir();
    const existing = this.listArtifacts().find(
      (artifact) => artifact.id === input.id && artifact.run_id === input.runId,
    );
    if (existing !== undefined) {
      return existing;
    }
    const artifact: ResearchArtifactRecord = {
      id: input.id,
      run_id: input.runId,
      project_id: input.projectId,
      uri: input.uri,
      summary: input.summary,
      kind: input.kind,
      created_at: (input.now ?? new Date()).toISOString(),
      metadata: input.metadata,
    };
    fs.appendFileSync(this.artifactIndexPath, `${JSON.stringify(artifact)}\n`);
    return artifact;
  }

  listArtifacts(input: { runId?: string; projectId?: string } = {}): ResearchArtifactRecord[] {
    if (!fs.existsSync(this.artifactIndexPath)) {
      return [];
    }
    const content = fs.readFileSync(this.artifactIndexPath, 'utf8');
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseArtifactLine(line, index + 1))
      .filter((artifact) => input.runId === undefined || artifact.run_id === input.runId)
      .filter((artifact) => input.projectId === undefined || artifact.project_id === input.projectId);
  }

  private readRuns(): ResearchRunRecord[] {
    if (!fs.existsSync(this.runsPath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(this.runsPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new MemoryCoreError('invalid_research_runs_file', 'research-runs.json must contain an array');
    }
    return parsed.map((item, index) => parseRunRecord(item, index));
  }

  private writeRuns(runs: ResearchRunRecord[]): void {
    this.ensureMemoryDir();
    fs.writeFileSync(this.runsPath, `${JSON.stringify(runs, null, 2)}\n`);
  }

  private ensureMemoryDir(): void {
    fs.mkdirSync(this.memoryDir, { recursive: true });
    if (!fs.existsSync(this.artifactIndexPath)) {
      fs.writeFileSync(this.artifactIndexPath, '');
    }
  }
}

function parseRunRecord(value: unknown, index: number): ResearchRunRecord {
  if (!isRecord(value)) {
    throw new MemoryCoreError('invalid_research_run_record', `Research run record ${index} must be an object`);
  }
  requireString(value.id, `runs[${index}].id`);
  requireString(value.project_id, `runs[${index}].project_id`);
  requireString(value.project_root, `runs[${index}].project_root`);
  requireString(value.task, `runs[${index}].task`);
  requireString(value.status, `runs[${index}].status`);
  return value as unknown as ResearchRunRecord;
}

function parseArtifactLine(line: string, lineNumber: number): ResearchArtifactRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new MemoryCoreError(
      'invalid_artifact_index',
      `Invalid artifact index JSONL at line ${lineNumber}: ${String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new MemoryCoreError('invalid_artifact_index', `Artifact index line ${lineNumber} must be an object`);
  }
  requireString(parsed.id, `artifact[${lineNumber}].id`);
  requireString(parsed.run_id, `artifact[${lineNumber}].run_id`);
  requireString(parsed.project_id, `artifact[${lineNumber}].project_id`);
  requireString(parsed.uri, `artifact[${lineNumber}].uri`);
  return parsed as unknown as ResearchArtifactRecord;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryCoreError('invalid_field', `${field} must be a non-empty string`);
  }
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (existing === undefined && patch === undefined) {
    return undefined;
  }
  return { ...(existing ?? {}), ...(patch ?? {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
