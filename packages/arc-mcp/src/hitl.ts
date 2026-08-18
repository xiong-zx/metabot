import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { ArcArtifactStore } from './artifact-store.js';
import { ArcError } from './errors.js';

export const ARC_HITL_CONTRACT_VERSION = 'autoresearchclaw.hitl.v1' as const;
export const ARC_MAX_HITL_GUIDANCE_BYTES = 16 * 1024;
const MAX_HITL_FILE_BYTES = 256 * 1024;
const MAX_LISTED_REQUESTS = 50;

/**
 * HITL identifiers name a file inside the run's own gate directory. The pattern
 * excludes separators, `.`/`..`, and NUL so no submission can traverse out of
 * the project root even before path containment runs.
 */
const HITL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const arcHitlDecisionSchema = z.enum(['approve', 'reject', 'revise']);
export type ArcHitlDecision = z.infer<typeof arcHitlDecisionSchema>;

export const arcHitlSubmitRequestSchema = z
  .object({
    run_id: z.string().trim().min(1).max(200),
    request_id: z.string().trim().min(1).max(128),
    decision: arcHitlDecisionSchema,
    guidance: z
      .string()
      .trim()
      .max(ARC_MAX_HITL_GUIDANCE_BYTES)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= ARC_MAX_HITL_GUIDANCE_BYTES, {
        message: `guidance exceeds ${ARC_MAX_HITL_GUIDANCE_BYTES} UTF-8 bytes`,
      })
      .optional(),
  })
  .strict();

export type ArcHitlSubmitRequest = z.infer<typeof arcHitlSubmitRequestSchema>;

export const arcHitlRequestRecordSchema = z
  .object({
    contract_version: z.literal(ARC_HITL_CONTRACT_VERSION),
    request_id: z.string(),
    run_id: z.string(),
    stage: z.string(),
    prompt: z.string(),
    created_at: z.string(),
  })
  .strict();

export type ArcHitlRequestRecord = z.infer<typeof arcHitlRequestRecordSchema>;

export const arcHitlResponseRecordSchema = z
  .object({
    contract_version: z.literal(ARC_HITL_CONTRACT_VERSION),
    request_id: z.string(),
    run_id: z.string(),
    decision: arcHitlDecisionSchema,
    guidance: z.string().nullable(),
    responder: z.object({ bot_name: z.string(), chat_id: z.string() }).strict(),
    responded_at: z.string(),
  })
  .strict();

export type ArcHitlResponseRecord = z.infer<typeof arcHitlResponseRecordSchema>;

export interface ArcHitlLocation {
  projectRoot: string;
  runId: string;
}

export function assertSafeHitlId(value: string, label: string): string {
  if (!HITL_ID.test(value)) {
    throw new ArcError('invalid_contract', `Unsafe ARC ${label}`, { details: { label } });
  }
  return value;
}

export function hitlDirectoryRelativePath(runId: string): string {
  return path.posix.join('.metabot-arc', 'runs', assertSafeHitlId(runId, 'run_id'), 'hitl');
}

/** Lists the gates the official pipeline is currently waiting on. */
export function listPendingHitlRequests(
  artifacts: ArcArtifactStore,
  location: ArcHitlLocation,
): ArcHitlRequestRecord[] {
  const directory = resolveHitlDirectory(artifacts, location, { mustExist: false });
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory)
    .filter((name) => name.endsWith('.request.json'))
    .sort()
    .slice(0, MAX_LISTED_REQUESTS);
  const pending: ArcHitlRequestRecord[] = [];
  for (const name of entries) {
    const requestId = name.slice(0, -'.request.json'.length);
    if (!HITL_ID.test(requestId)) continue;
    if (existsSync(path.join(directory, `${requestId}.response.json`))) continue;
    pending.push(readHitlRequest(directory, requestId));
  }
  return pending;
}

export function readHitlRequest(directory: string, requestId: string): ArcHitlRequestRecord {
  const file = path.join(directory, `${assertSafeHitlId(requestId, 'request_id')}.request.json`);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ArcError('symlink_not_allowed', 'ARC HITL request must be a regular file');
  }
  if (info.size > MAX_HITL_FILE_BYTES) {
    throw new ArcError('artifact_invalid', 'ARC HITL request exceeds the size limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ArcError('artifact_invalid', 'ARC HITL request is not valid JSON', { cause: error });
  }
  const parsed = arcHitlRequestRecordSchema.safeParse(value);
  if (!parsed.success) throw new ArcError('invalid_contract', 'ARC HITL request does not match the contract');
  if (parsed.data.request_id !== requestId) {
    throw new ArcError('invalid_contract', 'ARC HITL request id does not match its file name');
  }
  return parsed.data;
}

/**
 * Writes the operator decision atomically next to the request. Submitting twice
 * for the same gate is a conflict rather than a silent overwrite, so a late
 * duplicate cannot flip an already-consumed decision.
 */
export function writeHitlResponse(
  artifacts: ArcArtifactStore,
  location: ArcHitlLocation,
  request: ArcHitlSubmitRequest,
  responder: { bot_name: string; chat_id: string },
  now: string,
): ArcHitlResponseRecord {
  const requestId = assertSafeHitlId(request.request_id, 'request_id');
  const directory = resolveHitlDirectory(artifacts, location, { mustExist: true });
  const requestFile = path.join(directory, `${requestId}.request.json`);
  if (!existsSync(requestFile)) {
    throw new ArcError('artifact_missing', 'ARC HITL request was not found', { details: { requestId } });
  }
  readHitlRequest(directory, requestId);

  const target = path.join(directory, `${requestId}.response.json`);
  if (existsSync(target)) {
    throw new ArcError('run_conflict', 'ARC HITL request already has a decision', { details: { requestId } });
  }
  const record: ArcHitlResponseRecord = {
    contract_version: ARC_HITL_CONTRACT_VERSION,
    request_id: requestId,
    run_id: location.runId,
    decision: request.decision,
    guidance: request.guidance ?? null,
    responder,
    responded_at: now,
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const temporary = path.join(directory, `.hitl-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(target)) {
      throw new ArcError('run_conflict', 'ARC HITL request already has a decision', { details: { requestId } });
    }
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error instanceof ArcError
      ? error
      : new ArcError('artifact_invalid', 'Could not atomically write the ARC HITL decision', { cause: error });
  }
  return record;
}

function resolveHitlDirectory(
  artifacts: ArcArtifactStore,
  location: ArcHitlLocation,
  options: { mustExist: boolean },
): string {
  const relative = hitlDirectoryRelativePath(location.runId);
  const directory = artifacts.resolveLocalPath(location.projectRoot, relative, { rejectSymlinks: true });
  if (!existsSync(directory)) {
    if (!options.mustExist) return directory;
    throw new ArcError('artifact_missing', 'ARC run has no HITL gate directory', {
      details: { runId: location.runId },
    });
  }
  if (!statSync(directory).isDirectory()) {
    throw new ArcError('artifact_invalid', 'ARC HITL path is not a directory');
  }
  return directory;
}
