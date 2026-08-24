import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ArcError } from './errors.js';
import {
  ARC_HITL_CONTRACT_VERSION,
  assertSafeHitlId,
  type ArcHitlDecision,
  type ArcHitlRequestRecord,
} from './hitl.js';
import { atomicWriteJson, readJsonFile } from './official-paths.js';

/**
 * Translation between the two authoritative gate contracts.
 *
 * Official AutoResearchClaw owns `run_dir/hitl/waiting.json` and consumes
 * `run_dir/hitl/response.json` (`researchclaw.hitl.file_wait`). MetaBot's MCP
 * surface owns `.metabot-arc/runs/<run>/hitl/<request>.request.json` and its
 * `.response.json` sibling. The detached supervisor is the only writer that
 * bridges them, so neither side has to learn the other's schema and no gate
 * decision is ever invented by this package.
 */

export const OFFICIAL_WAITING_FILE = 'waiting.json';
export const OFFICIAL_RESPONSE_FILE = 'response.json';

/** Official `HumanAction` values this bridge is allowed to produce. */
const DECISION_ACTIONS: Record<ArcHitlDecision, 'approve' | 'reject' | 'inject'> = {
  approve: 'approve',
  reject: 'reject',
  revise: 'inject',
};

export interface OfficialWaitingState {
  stage: number;
  stage_name: string;
  reason: string;
  since: string;
  available_actions: string[];
  context_summary: string;
  output_files: string[];
}

export interface OfficialHitlResponse {
  action: string;
  message: string;
  guidance: string;
  edited_files: Record<string, string>;
  config_changes: Record<string, unknown>;
  resources: string[];
  rollback_to_stage: number | null;
  timestamp: string;
}

export function readOfficialWaitingState(officialHitlDir: string): OfficialWaitingState | undefined {
  const waitingPath = path.join(officialHitlDir, OFFICIAL_WAITING_FILE);
  if (!existsSync(waitingPath)) return undefined;
  let value: Partial<OfficialWaitingState> | null;
  try {
    value = readJsonFile(waitingPath) as Partial<OfficialWaitingState> | null;
  } catch {
    // The official writer is not atomic, so a torn read is normal. Treat it as
    // "not waiting yet" and re-read on the next poll rather than failing a run.
    return undefined;
  }
  if (!value || !Number.isSafeInteger(value.stage) || (value.stage as number) < 0) return undefined;
  return {
    stage: value.stage as number,
    stage_name: typeof value.stage_name === 'string' ? value.stage_name : '',
    reason: typeof value.reason === 'string' ? value.reason : 'post_stage',
    since: typeof value.since === 'string' ? value.since : '',
    available_actions: Array.isArray(value.available_actions)
      ? value.available_actions.filter((item): item is string => typeof item === 'string')
      : [],
    context_summary: typeof value.context_summary === 'string' ? value.context_summary : '',
    output_files: Array.isArray(value.output_files)
      ? value.output_files.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

/**
 * One official gate maps to exactly one MetaBot request id. It is derived from
 * the gate's own identity so a supervisor restart republishes the same id
 * instead of opening a second gate for the same pause.
 */
export function officialGateRequestId(waiting: OfficialWaitingState): string {
  const digest = createHash('sha256')
    .update(String(waiting.stage))
    .update('\0')
    .update(waiting.stage_name)
    .update('\0')
    .update(waiting.since)
    .digest('hex')
    .slice(0, 16);
  return assertSafeHitlId(`stage-${String(waiting.stage).padStart(2, '0')}-${digest}`, 'request_id');
}

export function officialGateRequestRecord(
  runId: string,
  waiting: OfficialWaitingState,
  now: string,
): ArcHitlRequestRecord {
  const outputs = waiting.output_files.slice(0, 20).join(', ');
  return {
    contract_version: ARC_HITL_CONTRACT_VERSION,
    request_id: officialGateRequestId(waiting),
    run_id: runId,
    stage: waiting.stage_name || `stage-${waiting.stage}`,
    prompt:
      `Official AutoResearchClaw is waiting at stage ${waiting.stage} (${waiting.stage_name || 'unnamed'}), ` +
      `reason ${waiting.reason}.` +
      (waiting.context_summary ? ` Context: ${waiting.context_summary}` : '') +
      (outputs ? ` Outputs: ${outputs}` : ''),
    created_at: waiting.since || now,
  };
}

/**
 * Publishes the pending official gate into the MetaBot gate directory. Writing
 * the same gate twice is a no-op so the supervisor poll loop stays idempotent.
 */
export function publishOfficialGate(
  gateDir: string,
  runId: string,
  waiting: OfficialWaitingState,
  now: string,
): ArcHitlRequestRecord {
  const record = officialGateRequestRecord(runId, waiting, now);
  const target = path.join(gateDir, `${record.request_id}.request.json`);
  if (!existsSync(target)) atomicWriteJson(target, record);
  return record;
}

export interface SubmittedGateDecision {
  request_id: string;
  run_id: string;
  decision: ArcHitlDecision;
  guidance: string | null;
}

export function readSubmittedGateDecision(gateDir: string, requestId: string): SubmittedGateDecision | undefined {
  const responsePath = path.join(gateDir, `${assertSafeHitlId(requestId, 'request_id')}.response.json`);
  if (!existsSync(responsePath)) return undefined;
  const value = readJsonFile(responsePath) as Partial<SubmittedGateDecision> & { contract_version?: unknown };
  if (
    !value ||
    value.contract_version !== ARC_HITL_CONTRACT_VERSION ||
    value.request_id !== requestId ||
    typeof value.run_id !== 'string' ||
    !(value.decision === 'approve' || value.decision === 'reject' || value.decision === 'revise')
  ) {
    throw new ArcError('invalid_contract', 'Submitted ARC HITL decision does not match the contract', {
      details: { requestId },
    });
  }
  return {
    request_id: requestId,
    run_id: value.run_id,
    decision: value.decision,
    guidance: typeof value.guidance === 'string' ? value.guidance : null,
  };
}

export function officialHitlResponse(decision: SubmittedGateDecision, now: string): OfficialHitlResponse {
  const guidance = decision.guidance ?? '';
  return {
    action: DECISION_ACTIONS[decision.decision],
    message: guidance,
    guidance: decision.decision === 'revise' ? guidance : '',
    edited_files: {},
    config_changes: {},
    resources: [],
    rollback_to_stage: null,
    timestamp: now,
  };
}

/**
 * Hands one operator decision to the official pipeline. The official poll loop
 * deletes `response.json` once it has consumed it, so writing it is the whole
 * handoff.
 */
export function forwardGateDecision(
  officialHitlDir: string,
  decision: SubmittedGateDecision,
  now: string,
): OfficialHitlResponse {
  const response = officialHitlResponse(decision, now);
  atomicWriteJson(path.join(officialHitlDir, OFFICIAL_RESPONSE_FILE), response);
  return response;
}
