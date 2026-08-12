#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { atomicWriteJson, isInside, readJsonFile } from './files.js';
import {
  RUNNER_STATE_VERSION,
  SUPERVISOR_REQUEST_VERSION,
  type OfficialRunnerState,
  type SupervisorRequest,
} from './types.js';

const requestPath = process.argv[2];
if (!requestPath) throw new Error('Supervisor request path is required');
const request = readJsonFile(requestPath) as SupervisorRequest;
if (request.contract_version !== SUPERVISOR_REQUEST_VERSION || request.request_path !== requestPath) {
  throw new Error('Invalid supervisor request');
}

const now = (): string => new Date().toISOString();
const initialState = readJsonFile(request.state_path) as OfficialRunnerState;

function writeState(patch: Partial<OfficialRunnerState>): void {
  const previous = existsSync(request.state_path)
    ? (readJsonFile(request.state_path) as OfficialRunnerState)
    : initialState;
  atomicWriteJson(request.state_path, {
    ...previous,
    ...patch,
    contract_version: RUNNER_STATE_VERSION,
    run_id: request.input.run_id,
    supervisor_pid: process.pid,
    updated_at: now(),
  } satisfies OfficialRunnerState);
}

// Register the detached supervisor before doing any work that can complete or
// fail. The parent waits for this handshake instead of racing a second state
// write against a fast official pipeline.
writeState({ status: 'starting', child_pid: null, error: null });

const detachedRunner = fileURLToPath(new URL('../python/detached_runner.py', import.meta.url));
let args = [
  detachedRunner,
  'run',
  '--topic',
  request.input.objective,
  '--config',
  request.config_path,
  '--output',
  request.run_dir,
  '--mode',
  request.mode,
];
if (request.profile) args.push('--profile', request.profile);
if (request.from_stage) args.push('--from-stage', request.from_stage);
if (request.to_stage) args.push('--to-stage', request.to_stage);
if (request.auto_approve) args.push('--auto-approve');
if (request.skip_preflight) args.push('--skip-preflight');
if (request.skip_noncritical_stage) args.push('--skip-noncritical-stage');
if (request.no_graceful_degradation) args.push('--no-graceful-degradation');
if (request.incremental_experiment) args.push('--incremental-experiment');

let finalized = false;
function finalize(exitCode: number, signal: NodeJS.Signals | null, error: string | null): void {
  if (finalized) return;
  finalized = true;
  writeEnvelope(request, exitCode, signal, error);
  writeState({
    status: exitCode === 0 ? 'completed' : 'failed',
    exit_code: exitCode,
    signal,
    error,
    finished_at: now(),
  });
  process.exitCode = exitCode === 0 ? 0 : 1;
}

function launchChild(): void {
  const stdoutFd = openSync(path.join(request.run_dir, 'researchclaw.stdout.log'), 'a', 0o600);
  const stderrFd = openSync(path.join(request.run_dir, 'researchclaw.stderr.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(request.python, args, {
      cwd: request.input.project_root,
      env: { ...process.env, NO_COLOR: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    const message = error instanceof Error ? error.message : String(error);
    writeState({ status: 'failed', error: message, finished_at: now() });
    writeEnvelope(request, 1, null, message);
    process.exitCode = 1;
    throw error;
  }
  closeSync(stdoutFd);
  closeSync(stderrFd);
  writeState({
    status: 'running',
    child_pid: child.pid ?? null,
    error: null,
    finished_at: null,
    exit_code: null,
    signal: null,
  });
  child.once('error', (error) => finalize(1, null, error.message));
  child.once('close', (code, signal) => {
    const exitCode = code ?? 1;
    if (exitCode === 0 && restartRejectedGate()) return;
    const error = exitCode === 0 ? null : `Official AutoResearchClaw exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}`;
    finalize(exitCode, signal, error);
  });
}

function restartRejectedGate(): boolean {
  const markerPath = path.join(request.run_dir, 'metabot-hitl-rejection.json');
  const summaryPath = path.join(request.run_dir, 'pipeline_summary.json');
  if (!existsSync(markerPath) || !existsSync(summaryPath)) return false;
  const marker = readJsonFile(markerPath) as Record<string, unknown>;
  const summary = readJsonFile(summaryPath) as Record<string, unknown>;
  if (
    marker.contract_version !== 'metabot.researchclaw.hitl-rejection.v1' ||
    marker.run_id !== request.input.run_id ||
    summary.final_status !== 'rejected' ||
    typeof marker.from_stage !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,80}$/.test(marker.from_stage)
  ) {
    return false;
  }
  args = replaceOption(args, '--from-stage', marker.from_stage);
  writeState({ status: 'starting', child_pid: null, error: null, finished_at: null, exit_code: null, signal: null });
  launchChild();
  unlinkSync(markerPath);
  return true;
}

function replaceOption(values: string[], option: string, value: string): string[] {
  const result = [...values];
  const index = result.indexOf(option);
  if (index >= 0) result.splice(index, 2);
  result.push(option, value);
  return result;
}

launchChild();

function writeEnvelope(
  item: SupervisorRequest,
  exitCode: number,
  signal: NodeJS.Signals | null,
  error: string | null,
): void {
  let pipelineSummary: Record<string, unknown> = {};
  const summaryPath = path.join(item.run_dir, 'pipeline_summary.json');
  if (existsSync(summaryPath)) {
    const parsed = readJsonFile(summaryPath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      pipelineSummary = parsed as Record<string, unknown>;
    }
  }
  const stagesDone = finiteNumber(pipelineSummary.stages_done);
  const stagesFailed = finiteNumber(pipelineSummary.stages_failed);
  const fullyCompleted = exitCode === 0 && !item.to_stage && stagesDone >= 23 && stagesFailed === 0;
  const status = exitCode !== 0 ? 'failed' : fullyCompleted ? 'completed' : 'partial';
  const artifacts = collectArtifacts(item.input.project_root, item.run_dir);
  const summary =
    status === 'completed'
      ? `Official AutoResearchClaw completed all ${stagesDone} pipeline stages.`
      : status === 'partial'
        ? `Official AutoResearchClaw finished a bounded partial pipeline (${stagesDone} stages completed).`
        : `Official AutoResearchClaw failed: ${error ?? 'unknown error'}.`;
  const output = {
    contract_version: 'autoresearchclaw.output.v2',
    project_id: item.input.project_id,
    run_id: item.input.run_id,
    status,
    summary,
    hypotheses: [],
    experiments: [],
    findings: [],
    negative_results: [],
    decisions: [],
    artifacts,
    open_questions: [],
    recommended_followups: status === 'failed' ? ['Inspect the official ResearchClaw stderr log and resume from its checkpoint.'] : [],
    tool_trace: [
      {
        tool: 'official_autoresearchclaw_pipeline',
        summary: `Executed the pinned official ${item.official_version} pipeline at ${item.official_revision}.`,
        status: status === 'failed' ? 'failed' : 'completed',
        started_at: (readJsonFile(item.state_path) as OfficialRunnerState).started_at,
        finished_at: now(),
      },
    ],
    metrics: {
      official_stage_count: 23,
      stages_done: stagesDone,
      stages_failed: stagesFailed,
      exit_code: exitCode,
    },
    ...(signal ? { pivots: [{ summary: `Process signal: ${signal}`, rationale: 'The official runner did not exit normally.' }] } : {}),
  };
  const outputPath = path.resolve(item.input.project_root, item.input.artifact_path);
  if (!isInside(item.input.project_root, outputPath)) throw new Error('Output path escaped project root');
  atomicWriteJson(outputPath, output);
}

function collectArtifacts(projectRoot: string, runDir: string): Array<Record<string, unknown>> {
  const selected = new Set<string>();
  for (const name of ['pipeline_summary.json', 'checkpoint.json', 'researchclaw.stdout.log', 'researchclaw.stderr.log']) {
    const candidate = path.join(runDir, name);
    if (existsSync(candidate) && lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink()) selected.add(candidate);
  }
  const deliverables = path.join(runDir, 'deliverables');
  if (existsSync(deliverables) && lstatSync(deliverables).isDirectory() && !lstatSync(deliverables).isSymbolicLink()) {
    for (const candidate of walkRegularFiles(deliverables, 96)) selected.add(candidate);
  }
  return [...selected].slice(0, 100).map((file, index) => ({
    id: `official-artifact-${index + 1}`,
    uri: path.relative(projectRoot, file).split(path.sep).join('/'),
    summary: `Official AutoResearchClaw artifact: ${path.relative(runDir, file).split(path.sep).join('/')}`,
    media_type: mediaType(file),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }));
}

function walkRegularFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    const directory = pending.shift()!;
    for (const entry of readdirSync(directory).sort()) {
      const candidate = path.join(directory, entry);
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) pending.push(candidate);
      else if (info.isFile() && statSync(candidate).size <= 64 * 1024 * 1024) files.push(candidate);
      if (files.length >= limit) break;
    }
  }
  return files;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function mediaType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    case '.tex':
      return 'application/x-tex';
    case '.bib':
      return 'application/x-bibtex';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    default:
      return 'text/plain';
  }
}
