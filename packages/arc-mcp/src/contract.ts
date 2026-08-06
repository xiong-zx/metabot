import { z } from 'zod';

import { ArcError } from './errors.js';

export const ARC_INPUT_CONTRACT_VERSION = 'autoresearchclaw.input.v1' as const;
export const ARC_OUTPUT_CONTRACT_VERSION = 'autoresearchclaw.output.v2' as const;
export const ARC_RUN_CONTRACT_VERSION = 'autoresearchclaw.run.v1' as const;

const nonEmpty = z.string().trim().min(1);
const identifier = nonEmpty.max(200);
const timestamp = z.string().datetime({ offset: true });

export const arcRunStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);

export const arcResultStatusSchema = z.enum(['completed', 'partial', 'failed']);

export const arcExecutionHandleSchema = z
  .object({
    id: identifier,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const arcExecutionInputSchema = z
  .object({
    contract_version: z.literal(ARC_INPUT_CONTRACT_VERSION),
    project_id: identifier,
    run_id: identifier,
    objective: nonEmpty,
    project_root: nonEmpty,
    artifact_path: nonEmpty,
    requested_at: timestamp,
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const evidenceSchema = z
  .object({
    id: identifier,
    uri: nonEmpty,
    summary: nonEmpty,
  })
  .strict();

const hypothesisSchema = z
  .object({
    id: identifier,
    statement: nonEmpty,
    rationale: nonEmpty.optional(),
    status: z.enum(['proposed', 'supported', 'refuted', 'inconclusive']).optional(),
  })
  .strict();

const experimentSchema = z
  .object({
    id: identifier,
    hypothesis_ids: z.array(identifier),
    summary: nonEmpty,
    method: nonEmpty,
    status: z.enum(['planned', 'running', 'completed', 'failed', 'cancelled']),
    metrics: z.record(z.string(), z.number().finite()).optional(),
    artifact_ids: z.array(identifier).optional(),
  })
  .strict();

const findingSchema = z
  .object({
    id: identifier,
    summary: nonEmpty,
    evidence: z.array(evidenceSchema),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const negativeResultSchema = z
  .object({
    id: identifier,
    summary: nonEmpty,
    experiment_id: identifier.optional(),
    evidence: z.array(evidenceSchema).optional(),
  })
  .strict();

const decisionSchema = z
  .object({
    id: identifier,
    summary: nonEmpty,
    rationale: nonEmpty,
    related_finding_ids: z.array(identifier).optional(),
  })
  .strict();

const artifactSchema = z
  .object({
    id: identifier,
    uri: nonEmpty,
    summary: nonEmpty,
    media_type: nonEmpty.optional(),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  })
  .strict();

const openQuestionSchema = z
  .object({
    id: identifier,
    question: nonEmpty,
    context: nonEmpty.optional(),
  })
  .strict();

const pivotSchema = z
  .object({
    summary: nonEmpty,
    rationale: nonEmpty,
  })
  .strict();

const toolTraceSchema = z
  .object({
    tool: nonEmpty,
    summary: nonEmpty,
    status: z.enum(['started', 'completed', 'failed']),
    started_at: timestamp.optional(),
    finished_at: timestamp.optional(),
  })
  .strict();

export const arcOutputSchema = z
  .object({
    contract_version: z.literal(ARC_OUTPUT_CONTRACT_VERSION),
    project_id: identifier,
    run_id: identifier,
    status: arcResultStatusSchema,
    summary: nonEmpty,
    hypotheses: z.array(hypothesisSchema),
    experiments: z.array(experimentSchema),
    findings: z.array(findingSchema),
    negative_results: z.array(negativeResultSchema),
    decisions: z.array(decisionSchema),
    artifacts: z.array(artifactSchema),
    open_questions: z.array(openQuestionSchema),
    recommended_followups: z.array(nonEmpty),
    tool_trace: z.array(toolTraceSchema),
    metrics: z.record(z.string(), z.number().finite()).optional(),
    pivots: z.array(pivotSchema).optional(),
    memory_event_candidates: z.array(z.unknown()).optional(),
  })
  .strict();

export const arcRunErrorSchema = z
  .object({
    code: nonEmpty,
    message: nonEmpty,
  })
  .strict();

export const arcRunRecordSchema = z
  .object({
    contract_version: z.literal(ARC_RUN_CONTRACT_VERSION),
    run_id: identifier,
    project_id: identifier,
    project_root: nonEmpty,
    objective: nonEmpty,
    idempotency_key: identifier,
    request_fingerprint: nonEmpty,
    status: arcRunStatusSchema,
    phase: nonEmpty,
    progress: z.number().min(0).max(1),
    artifact_path: nonEmpty,
    output_status: arcResultStatusSchema.nullable(),
    runner_handle: arcExecutionHandleSchema.nullable(),
    error: arcRunErrorSchema.nullable(),
    recovery_generation: z.number().int().nonnegative(),
    created_at: timestamp,
    updated_at: timestamp,
    started_at: timestamp.nullable(),
    finished_at: timestamp.nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type ArcExecutionHandle = z.infer<typeof arcExecutionHandleSchema>;
export type ArcExecutionInput = z.infer<typeof arcExecutionInputSchema>;
export type ArcOutput = z.infer<typeof arcOutputSchema>;
export type ArcResultStatus = z.infer<typeof arcResultStatusSchema>;
export type ArcRunError = z.infer<typeof arcRunErrorSchema>;
export type ArcRunRecord = z.infer<typeof arcRunRecordSchema>;
export type ArcRunStatus = z.infer<typeof arcRunStatusSchema>;

export interface ValidateArcOutputOptions {
  expectedProjectId: string;
  expectedRunId: string;
}

function validationError(kind: string, issues: z.core.$ZodIssue[]): ArcError {
  return new ArcError('invalid_contract', `Invalid ${kind} contract`, {
    details: {
      issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  });
}

export function validateArcExecutionInput(value: unknown): ArcExecutionInput {
  const result = arcExecutionInputSchema.safeParse(value);
  if (!result.success) throw validationError('ARC input', result.error.issues);
  return result.data;
}

export function validateArcOutput(value: unknown, options: ValidateArcOutputOptions): ArcOutput {
  const result = arcOutputSchema.safeParse(value);
  if (!result.success) throw validationError('ARC output', result.error.issues);
  if (result.data.project_id !== options.expectedProjectId) {
    throw new ArcError('invalid_contract', 'ARC output project_id does not match the run', {
      details: { expected: options.expectedProjectId, actual: result.data.project_id },
    });
  }
  if (result.data.run_id !== options.expectedRunId) {
    throw new ArcError('invalid_contract', 'ARC output run_id does not match the run', {
      details: { expected: options.expectedRunId, actual: result.data.run_id },
    });
  }
  return result.data;
}

export function validateArcRunRecord(value: unknown): ArcRunRecord {
  const result = arcRunRecordSchema.safeParse(value);
  if (!result.success) throw validationError('ARC run', result.error.issues);
  return result.data;
}
