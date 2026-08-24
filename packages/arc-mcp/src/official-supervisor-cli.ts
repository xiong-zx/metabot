#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  forwardGateDecision,
  publishOfficialGate,
  readOfficialWaitingState,
  readSubmittedGateDecision,
} from './official-hitl-bridge.js';
import { atomicWriteJson, isInside } from './official-paths.js';
import {
  OFFICIAL_RUNNER_STATE_VERSION,
  readRunnerState,
  readSupervisorRequest,
  type OfficialRunnerState,
} from './official-state.js';
import { ARC_OUTPUT_CONTRACT_VERSION } from './contract.js';

/**
 * The detached official AutoResearchClaw supervisor.
 *
 * It is the durable owner of one official run: it launches the pinned CLI in
 * its own process group, bridges the official file-based HITL transport to the
 * MetaBot gate contract, and publishes exactly one terminal artifact. It holds
 * no capability, opens no socket, and never talks to the MCP daemon — the
 * coordinator re-attaches purely through the atomic state file.
 */

const MAX_COLLECTED_ARTIFACTS = 100;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const requestPath = process.argv[2];
if (!requestPath) throw new Error('Supervisor request path is required');
const request = readSupervisorRequest(requestPath);
if (request.request_path !== requestPath) throw new Error('Supervisor request does not describe itself');

const now = (): string => new Date().toISOString();
const officialHitlDir = path.join(request.run_dir, 'hitl');
const forwardedGates = new Set<string>();
let child: ChildProcess | undefined;
let finalized = false;

/**
 * Terminal state is never downgraded: a cancel writes `cancelled` from the
 * coordinator before signalling this group, and the child's exit must not
 * rewrite it as a plain failure.
 */
function writeState(patch: Partial<OfficialRunnerState>): OfficialRunnerState {
  const previous = readRunnerState(request.state_path);
  if (previous.status === 'cancelled' && patch.status && patch.status !== 'cancelled') {
    return previous;
  }
  const next: OfficialRunnerState = {
    ...previous,
    ...patch,
    contract_version: OFFICIAL_RUNNER_STATE_VERSION,
    run_id: request.input.run_id,
    supervisor_pid: process.pid,
    updated_at: now(),
  };
  atomicWriteJson(request.state_path, next);
  return next;
}

// Register before any work that can complete or fail, so the coordinator never
// races a fast pipeline against an unregistered handle.
writeState({ status: 'starting', child_pid: null, error: null });

function officialArgs(): string[] {
  const args = [
    request.runner_path,
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
  return args;
}

function launchOfficialChild(): void {
  const stdoutFd = openSync(path.join(request.run_dir, 'researchclaw.stdout.log'), 'a', 0o600);
  const stderrFd = openSync(path.join(request.run_dir, 'researchclaw.stderr.log'), 'a', 0o600);
  try {
    child = spawn(request.python, officialArgs(), {
      cwd: request.input.project_root,
      env: {
        ...process.env,
        NO_COLOR: '1',
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: [path.dirname(request.compat_path), process.env.PYTHONPATH]
          .filter((entry): entry is string => !!entry)
          .join(path.delimiter),
      },
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } catch (error) {
    finalize(1, null, error instanceof Error ? error.message : String(error));
    return;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
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
    finalize(
      exitCode,
      signal,
      exitCode === 0
        ? null
        : `Official AutoResearchClaw exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}`,
    );
  });
}

function finalize(exitCode: number, signal: NodeJS.Signals | null, error: string | null): void {
  if (finalized) return;
  finalized = true;
  clearInterval(bridgeTimer);
  try {
    writeEnvelope(exitCode, signal, error);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    writeState({ status: 'failed', exit_code: exitCode, signal, error: message, finished_at: now() });
    process.exitCode = 1;
    return;
  }
  writeState({
    status: exitCode === 0 ? 'completed' : 'failed',
    exit_code: exitCode,
    signal,
    error,
    finished_at: now(),
  });
  process.exitCode = exitCode === 0 ? 0 : 1;
}

/**
 * Bridges the two gate contracts in both directions. Official waiting states
 * become MetaBot gate requests; MetaBot decisions become official responses.
 * Every step is idempotent so a slow poll or a duplicate submission is safe.
 */
function pumpHitlBridge(): void {
  if (finalized) return;
  const waiting = readOfficialWaitingState(officialHitlDir);
  if (!waiting) return;
  let requestId: string;
  try {
    requestId = publishOfficialGate(request.gate_dir, request.input.run_id, waiting, now()).request_id;
  } catch {
    // The gate directory can be temporarily unavailable; retry on next tick
    // rather than aborting a live official pipeline.
    return;
  }
  if (forwardedGates.has(requestId)) return;
  let decision;
  try {
    decision = readSubmittedGateDecision(request.gate_dir, requestId);
  } catch {
    return;
  }
  if (!decision) return;
  forwardGateDecision(officialHitlDir, decision, now());
  forwardedGates.add(requestId);
}

const bridgeTimer = setInterval(pumpHitlBridge, Math.max(100, request.poll_interval_ms));
bridgeTimer.unref?.();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(bridgeTimer);
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Already gone; the durable state is what the coordinator reads.
      }
    }
    finalized = true;
    const state = readRunnerState(request.state_path);
    if (state.status === 'starting' || state.status === 'running') {
      writeState({ status: 'cancelled', signal, finished_at: now() });
    }
    process.exit(0);
  });
}

launchOfficialChild();

/**
 * Writes the single authoritative ARC output artifact. Provenance comes from
 * the sealed release and the official pipeline summary; the semantic arrays
 * stay empty because this package never invents scientific claims.
 */
function writeEnvelope(exitCode: number, signal: NodeJS.Signals | null, error: string | null): void {
  const summaryPath = path.join(request.run_dir, 'pipeline_summary.json');
  let pipelineSummary: Record<string, unknown> = {};
  if (existsSync(summaryPath)) {
    try {
      const parsed = JSON.parse(readFileSync(summaryPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        pipelineSummary = parsed as Record<string, unknown>;
      }
    } catch {
      // An unreadable official summary must not hide the run's real outcome.
    }
  }
  const stagesDone = finiteNumber(pipelineSummary.stages_done);
  const stagesFailed = finiteNumber(pipelineSummary.stages_failed);
  const fullyCompleted =
    exitCode === 0 && !request.to_stage && stagesDone >= request.stage_count && stagesFailed === 0;
  const status = exitCode !== 0 ? 'failed' : fullyCompleted ? 'completed' : 'partial';
  const startedAt = readRunnerState(request.state_path).started_at;
  const output = {
    contract_version: ARC_OUTPUT_CONTRACT_VERSION,
    project_id: request.input.project_id,
    run_id: request.input.run_id,
    status,
    summary:
      status === 'completed'
        ? `Official AutoResearchClaw ${request.official_version} completed all ${stagesDone} pipeline stages.`
        : status === 'partial'
          ? `Official AutoResearchClaw ${request.official_version} finished a bounded partial pipeline (${stagesDone} stages completed).`
          : `Official AutoResearchClaw ${request.official_version} failed: ${error ?? 'unknown error'}.`,
    hypotheses: [],
    experiments: [],
    findings: [],
    negative_results: [],
    decisions: [],
    artifacts: collectArtifacts(),
    open_questions: [],
    recommended_followups:
      status === 'failed'
        ? ['Inspect the official AutoResearchClaw stderr log and resume from its checkpoint.']
        : [],
    tool_trace: [
      {
        tool: 'official_autoresearchclaw_pipeline',
        summary: `Executed the pinned official ${request.official_version} pipeline at ${request.official_revision} from release ${request.release_id}.`,
        status: status === 'failed' ? 'failed' : 'completed',
        ...(startedAt ? { started_at: startedAt } : {}),
        finished_at: now(),
      },
    ],
    metrics: {
      official_stage_count: request.stage_count,
      stages_done: stagesDone,
      stages_failed: stagesFailed,
      exit_code: exitCode,
    },
    ...(signal
      ? {
          pivots: [
            { summary: `Process signal: ${signal}`, rationale: 'The official runner did not exit normally.' },
          ],
        }
      : {}),
  };
  const outputPath = path.resolve(request.input.project_root, request.input.artifact_path);
  if (!isInside(request.input.project_root, outputPath)) {
    throw new Error('Official AutoResearchClaw output path escaped the project root');
  }
  atomicWriteJson(outputPath, output);
}

function collectArtifacts(): Array<Record<string, unknown>> {
  const selected = new Set<string>();
  for (const name of [
    'pipeline_summary.json',
    'checkpoint.json',
    'researchclaw.stdout.log',
    'researchclaw.stderr.log',
  ]) {
    const candidate = path.join(request.run_dir, name);
    if (isRegularFile(candidate)) selected.add(candidate);
  }
  const deliverables = path.join(request.run_dir, 'deliverables');
  if (existsSync(deliverables) && lstatSync(deliverables).isDirectory()) {
    for (const candidate of walkRegularFiles(deliverables, MAX_COLLECTED_ARTIFACTS - selected.size)) {
      selected.add(candidate);
    }
  }
  return [...selected].slice(0, MAX_COLLECTED_ARTIFACTS).map((file, index) => ({
    id: `official-artifact-${index + 1}`,
    uri: path.relative(request.input.project_root, file).split(path.sep).join('/'),
    summary: `Official AutoResearchClaw artifact: ${path.relative(request.run_dir, file).split(path.sep).join('/')}`,
    media_type: mediaType(file),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }));
}

function isRegularFile(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  const info = lstatSync(candidate);
  return info.isFile() && !info.isSymbolicLink();
}

function walkRegularFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    const directory = pending.shift()!;
    for (const entry of readdirSync(directory).sort()) {
      const candidate = path.join(directory, entry);
      const info = lstatSync(candidate);
      // Symlinks are skipped so a planted link cannot pull an out-of-project
      // file into the official artifact manifest.
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) pending.push(candidate);
      else if (info.isFile() && statSync(candidate).size <= MAX_ARTIFACT_BYTES) files.push(candidate);
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
