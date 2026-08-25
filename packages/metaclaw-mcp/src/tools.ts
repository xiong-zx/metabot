import { z } from 'zod';

import { MetaClawError } from './errors.js';
import { assertToolNotGated, openGatesFor, SERVICE_BEARER_SURFACE } from './gates.js';
import { assertReleaseIntact } from './integrity.js';
import {
  buildProvenance,
  assertReturnedModelProvider,
  extractCompletionText,
  prepareInference,
  STRIPPED_CONTROL_KEYS,
  TURN_TYPE_VALUE,
} from './infer.js';
import { inspectProfilePins } from './profile.js';
import { getSkill, listSkills } from './skills.js';
import { currentIntegrity, type MetaClawRuntime } from './runtime.js';
import type { EndpointIdentity } from './service-client.js';

/**
 * The complete tool surface: five tools, fixed.
 *
 * Everything absent is absent on purpose. There is no start, stop, restart,
 * setup, or uninstall; no config or auth mutation; no memory, training, or
 * evolution route; no record deletion; no skill write; no arbitrary path; and
 * no model or base-URL selection. A tool that does not exist cannot be reached
 * by a prompt-injected caller, which is a stronger guarantee than a scope check
 * on a tool that does.
 */
export const METACLAW_TOOL_NAMES = Object.freeze([
  'metaclaw_health',
  'metaclaw_status',
  'metaclaw_infer',
  'metaclaw_skills_list',
  'metaclaw_skill_get',
] as const);

export type MetaClawToolName = (typeof METACLAW_TOOL_NAMES)[number];

const emptyInput = z.object({}).strict();
const controlsInputSchema = z.record(z.string().min(1).max(100), z.unknown()).superRefine((value, context) => {
  if (Object.keys(value).length > 64) {
    context.addIssue({ code: 'custom', message: 'controls may contain at most 64 keys' });
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) {
      context.addIssue({ code: 'custom', message: 'controls exceeds the 65536 byte bound' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'controls must be JSON serializable' });
  }
});

const inferInputSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    deadlineMs: z.number().int().positive().optional(),
    /**
     * Accepted so a caller that sends a control gets a truthful "this was
     * removed" instead of a schema rejection it cannot interpret. Nothing here
     * reaches the service: the outbound body is built from an allowlist.
     */
    controls: controlsInputSchema.optional(),
  })
  .strict();

const skillGetInputSchema = z
  .object({
    name: z.string().min(1).max(64),
  })
  .strict();

export const METACLAW_TOOL_INPUT_SCHEMAS = Object.freeze({
  metaclaw_health: emptyInput,
  metaclaw_status: emptyInput,
  metaclaw_infer: inferInputSchema,
  metaclaw_skills_list: emptyInput,
  metaclaw_skill_get: skillGetInputSchema,
} satisfies Record<MetaClawToolName, z.ZodType>);

export const METACLAW_TOOL_DESCRIPTIONS: Readonly<Record<MetaClawToolName, string>> = Object.freeze({
  metaclaw_health:
    'Probe the managed official MetaClaw service for reachability within a bounded deadline. Never starts, stops, or repairs it.',
  metaclaw_status:
    'Report pinned release identity and integrity, managed profile pins, dependency gates, skills digests, and the limitations this integration does not yet cover.',
  metaclaw_infer:
    'Run one bounded, non-streaming inference against the profile-pinned model as an isolated side turn. Model, provider, and session identity are not caller-selectable.',
  metaclaw_skills_list:
    'List shared skills with digest and provenance. Read-only; unsafe or half-written entries are reported as quarantined.',
  metaclaw_skill_get:
    'Read one contained SKILL.md with its digest and provenance. Read-only; symlinked, oversized, traversing, or half-written entries fail closed.',
});

/**
 * Limitations are part of the product, not a footnote. The official service
 * fakes streaming, cannot propagate cancellation upstream, and this server
 * never observes a running process, so each is stated rather than implied by
 * omission.
 */
export const METACLAW_LIMITATIONS = Object.freeze([
  {
    id: 'streaming',
    status: 'unsupported',
    detail:
      'The official service forces stream=false upstream and emits a synthetic two-chunk SSE response, so a streaming tool would report progress that does not exist.',
  },
  {
    id: 'upstream_cancellation',
    status: 'unsupported',
    detail:
      "A client disconnect cannot cancel the provider call or its cost. A deadline bounds this server's wait, not the work behind it.",
  },
  {
    id: 'service_lifecycle',
    status: 'out_of_scope',
    detail: 'Starting, stopping, restarting, and repairing the official service belong to the operator.',
  },
  {
    id: 'observed_bind',
    status: 'not_observed',
    detail:
      'Bind host and port are reported from the managed profile. This server never inspects a running process, so they are the pinned intent rather than an observation.',
  },
] as const);

export interface HealthResult {
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  readonly elapsedMs: number | null;
  readonly autoStart: 'never';
  /**
   * Identity as *this build* records it, from the local pinned manifest. It is
   * never what the probed service said about itself.
   */
  readonly release: {
    readonly releaseId: string;
    readonly official: boolean;
    readonly tag: string;
    readonly commit: string;
  };
  /** What the pinned endpoint-identity check concluded about the probed port. */
  readonly serviceIdentity: EndpointIdentity;
  readonly credential: {
    readonly bearerPresented: boolean;
    readonly withheldFor: readonly string[];
  };
  readonly integrity: {
    readonly checked: false;
    readonly reason: 'Use metaclaw_status for bounded release-integrity verification.';
  };
  readonly error: Record<string, unknown> | null;
}

export async function runHealth(runtime: MetaClawRuntime): Promise<HealthResult> {
  runtime.assertConfigurationCurrent();
  // The bearer is a credential for a service whose identity the open gates say
  // is not yet establishable. Sending it to find out whether something is
  // listening spends the secret to learn the one thing a bare TCP connect
  // already tells you.
  const withheldFor = openGatesFor(SERVICE_BEARER_SURFACE, runtime.gates).map((gate) => gate.id);
  const probe = await runtime.client.probeHealth({
    deadlineMs: runtime.profile.limits.deadlineMs,
    withBearer: withheldFor.length === 0,
    identity: runtime.profile.service.identity,
  });
  return {
    reachable: probe.reachable,
    httpStatus: probe.httpStatus,
    elapsedMs: probe.elapsedMs,
    autoStart: 'never',
    release: {
      releaseId: runtime.manifest.releaseId,
      official: runtime.manifest.official,
      tag: runtime.manifest.tag,
      commit: runtime.manifest.commit,
    },
    serviceIdentity: probe.identity,
    credential: { bearerPresented: probe.bearerPresented, withheldFor },
    integrity: {
      checked: false,
      reason: 'Use metaclaw_status for bounded release-integrity verification.',
    },
    error: probe.error as Record<string, unknown> | null,
  };
}

export async function runStatus(runtime: MetaClawRuntime): Promise<Record<string, unknown>> {
  runtime.assertConfigurationCurrent();
  const budget = runtime.createLocalReadBudget();
  const integrity = await currentIntegrity(runtime, budget);
  const skills = await safeSkillDigest(runtime, budget);
  return {
    release: {
      releaseId: integrity.releaseId,
      official: integrity.official,
      state: integrity.state,
      tag: integrity.tag,
      commit: integrity.commit,
      fileCount: integrity.fileCount,
      checkedFileCount: integrity.checkedFileCount,
      observedEntryCount: integrity.observedEntryCount,
      bytesRead: integrity.bytesRead,
      complete: integrity.complete,
      truncation: integrity.truncation,
      integrityOk: integrity.ok,
      drift: integrity.drift.slice(0, 20),
      driftCount: integrity.drift.length,
      driftTruncated: integrity.drift.length > 20,
      integration: runtime.manifest.integration ?? null,
      provenance: runtime.manifest.provenance
        ? {
            official: runtime.manifest.provenance.official,
            class: runtime.manifest.provenance.class,
            upstream: runtime.manifest.provenance.upstream,
            patchCount: runtime.manifest.provenance.patches.length,
            seriesSha256: runtime.manifest.provenance.seriesSha256,
            resultTree: runtime.manifest.provenance.resultTree,
            installedSourceSha256: runtime.manifest.provenance.installedSourceSha256,
          }
        : null,
      build: runtime.manifest.build ?? null,
      dependencies: runtime.manifest.dependencies ?? null,
      immutability: runtime.manifest.immutability ?? null,
      supersedes: runtime.manifest.supersedes
        ? {
            releaseId: runtime.manifest.supersedes.releaseId,
            manifestSha256: runtime.manifest.supersedes.manifestSha256,
            reason: runtime.manifest.supersedes.reason,
          }
        : null,
      priorCandidate: runtime.manifest.priorCandidate
        ? {
            releaseId: runtime.manifest.priorCandidate.releaseId,
            manifestSha256: runtime.manifest.priorCandidate.manifestSha256,
            reason: runtime.manifest.priorCandidate.reason,
          }
        : null,
      limitations: runtime.manifest.limitations ?? [],
    },
    profile: {
      profileId: runtime.profile.profileId,
      activation: runtime.profile.activation,
      managedHome: runtime.profile.managedHome,
      stateRoot: runtime.profile.stateRoot,
      release: runtime.profile.release,
      // Endpoint host and port only: a bearer never appears in status output,
      // and neither does the path of the file holding it.
      bindHost: runtime.profile.endpoint.hostname,
      bindPort: runtime.profile.endpoint.port,
      // The pin itself, not an observation. Reporting what this build was told
      // to expect is safe; reporting what the port said it is, is not.
      endpointIdentityPin: runtime.profile.service.identity,
      allowedHosts: runtime.profile.service.allowedHosts,
      upstreamBounds: runtime.profile.service.upstreamBounds,
      serviceBearerWithheldFor: openGatesFor(SERVICE_BEARER_SURFACE, runtime.gates).map((gate) => gate.id),
      model: runtime.profile.model,
      pins: inspectProfilePins(runtime.profile.pins),
      limits: runtime.profile.limits,
      processIdentity: {
        expectedExecutable: runtime.profile.service.process.executable,
        expectedManagedHome: runtime.profile.service.process.managedHome,
        observed: false,
        reason: 'PID/process identity observation belongs to the operator release doctor.',
      },
      rollback: runtime.profile.rollback,
    },
    skills: {
      root: runtime.profile.skills.root,
      writer: runtime.profile.skills.writer,
      ...skills,
    },
    gates: runtime.gates.map((gate) => ({
      id: gate.id,
      satisfied: gate.satisfied,
      evidence: gate.evidence,
      requirement: gate.requirement,
      consequence: gate.consequence,
      gates: gate.gates,
    })),
    tools: METACLAW_TOOL_NAMES,
    limitations: METACLAW_LIMITATIONS,
    strippedInferenceControls: STRIPPED_CONTROL_KEYS,
    turnType: TURN_TYPE_VALUE,
  };
}

export async function runInfer(
  runtime: MetaClawRuntime,
  input: z.infer<typeof inferInputSchema>,
): Promise<Record<string, unknown>> {
  runtime.assertConfigurationCurrent();
  // Order matters: a gated integration must refuse before it forms a request,
  // so a gate can never be discovered only after a provider was billed.
  assertToolNotGated('metaclaw_infer', runtime.gates);
  const integrity = await currentIntegrity(runtime);
  assertReleaseIntact(integrity);

  const prepared = prepareInference(runtime.profile, input);
  const reservation = runtime.costLedger.reserve(
    prepared.promptBytes,
    prepared.body.max_tokens as number,
  );
  let response: Awaited<ReturnType<typeof runtime.client.createCompletion>>;
  try {
    response = await runtime.client.createCompletion({
      body: prepared.body,
      headers: prepared.headers,
      deadlineMs: prepared.deadlineMs,
    });
    assertReturnedModelProvider(response.json, runtime.profile);
    runtime.costLedger.settle(reservation, 'success', responseUsage(response.json));
  } catch (error) {
    runtime.costLedger.settle(reservation, 'failed');
    throw error;
  }

  return {
    content: extractCompletionText(response.json),
    cost: {
      reservation_id: reservation.id,
      reserved_input_tokens: reservation.inputTokens,
      reserved_output_tokens: reservation.outputTokens,
      reserved_usd_micros: reservation.usdMicros,
      policy: 'worst_case_charged_before_dispatch',
    },
    provenance: buildProvenance({
      profile: runtime.profile,
      prepared,
      releaseId: integrity.releaseId,
      official: integrity.official,
      elapsedMs: response.elapsedMs,
    }),
  };
}

function responseUsage(json: Readonly<Record<string, unknown>>): { inputTokens: number; outputTokens: number } | undefined {
  const usage = json.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const values = usage as Record<string, unknown>;
  const inputTokens = values.prompt_tokens;
  const outputTokens = values.completion_tokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
    throw new MetaClawError('Completion usage is not a valid token settlement', 'contract_violation');
  }
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}

export async function runSkillsList(runtime: MetaClawRuntime): Promise<Record<string, unknown>> {
  runtime.assertConfigurationCurrent();
  const listing = await listSkills(skillOptions(runtime));
  const entries = listing.entries;
  return {
    root: runtime.profile.skills.root,
    writer: runtime.profile.skills.writer,
    readOnly: true,
    entries,
    activeCount: entries.filter((entry) => entry.state === 'active').length,
    quarantinedCount: entries.filter((entry) => entry.state === 'quarantined').length,
    complete: listing.complete,
    truncated: listing.truncated,
    truncation: listing.truncation,
    totalEntries: listing.totalEntries,
    returnedEntryCount: listing.returnedEntryCount,
    observedRootEntryCount: listing.observedRootEntryCount,
    observedEntryCount: listing.observedEntryCount,
    bytesRead: listing.bytesRead,
  };
}

export async function runSkillGet(
  runtime: MetaClawRuntime,
  input: z.infer<typeof skillGetInputSchema>,
): Promise<Record<string, unknown>> {
  runtime.assertConfigurationCurrent();
  const document = await getSkill(skillOptions(runtime), input.name);
  return { readOnly: true, provenance: document.provenance, content: document.content, bytesRead: document.bytesRead };
}

async function safeSkillDigest(
  runtime: MetaClawRuntime,
  budget = runtime.createLocalReadBudget(),
): Promise<Record<string, unknown>> {
  try {
    const listing = await listSkills(skillOptions(runtime, budget));
    const entries = listing.entries;
    return {
      readable: true,
      complete: listing.complete,
      truncated: listing.truncated,
      truncation: listing.truncation,
      totalEntries: listing.totalEntries,
      returnedEntryCount: listing.returnedEntryCount,
      observedRootEntryCount: listing.observedRootEntryCount,
      observedEntryCount: listing.observedEntryCount,
      bytesRead: listing.bytesRead,
      activeDigests: entries
        .filter((entry) => entry.state === 'active' && entry.provenance)
        .map((entry) => ({ name: entry.name, sha256: entry.provenance!.sha256 })),
      quarantined: entries
        .filter((entry) => entry.state === 'quarantined')
        .map((entry) => ({ name: entry.name, reason: entry.reason })),
    };
  } catch (error) {
    // Status must still answer when the skills root is unusable: that fact is
    // exactly what an operator called status to find out.
    return {
      readable: false,
      error:
        error instanceof MetaClawError ? error.toJSON() : { code: 'internal', message: 'unreadable', retryable: false },
    };
  }
}

function skillOptions(runtime: MetaClawRuntime, budget = runtime.createLocalReadBudget()) {
  return {
    ...runtime.profile.skills,
    maxTotalBytes: runtime.profile.limits.maxLocalBytes,
    deadlineMs: runtime.profile.limits.localReadDeadlineMs,
    budget,
  };
}

export { inferInputSchema, skillGetInputSchema, emptyInput };
