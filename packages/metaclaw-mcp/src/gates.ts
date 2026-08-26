import { MetaClawError } from './errors.js';

/**
 * Dependency gates.
 *
 * This package can be written, reviewed, and tested before the official
 * MetaClaw service is safe to talk to. It cannot be *correct* to talk to that
 * service before four separate pieces of work land, and none of them are in
 * this repository. Encoding them here — rather than shipping a working client
 * and trusting an operator to remember — is the difference between a gate and
 * a note in a document.
 *
 * A gate is satisfied only when the managed profile carries explicit evidence
 * for it. Absent evidence is an unsatisfied gate, never a satisfied one.
 */

export interface GateDefinition {
  readonly id: string;
  /** What must be true upstream before the gated surface is honest. */
  readonly requirement: string;
  /** What breaks if the surface is used while the gate is open. */
  readonly consequence: string;
  /**
   * Surfaces refused while this gate is open. A surface is usually a tool, but
   * it can be narrower — `metaclaw_health:service_bearer` gates *sending the
   * service bearer*, not the health probe itself, because the useful part of a
   * reachability check survives without a credential and the credential does
   * not survive being sent to an unauthenticated port.
   */
  readonly gates: readonly string[];
  /** Profile prose cannot satisfy a gate that requires local enforcement. */
  readonly profileEvidenceAccepted?: boolean;
}

/**
 * Presenting the service bearer to whatever is listening on the managed port.
 *
 * Until the security series lands, the official service has no supported bearer
 * mapping and no loopback-safe startup, so the process answering that port is
 * not known to be the one the bearer was minted for — and anything on this host
 * can bind a port a managed service has not claimed yet.
 */
export const SERVICE_BEARER_SURFACE = 'metaclaw_health:service_bearer';

export const METACLAW_GATES: readonly GateDefinition[] = Object.freeze([
  {
    id: 'MCLAW-COST-LEDGER',
    requirement:
      'A pre-dispatch policy must atomically reserve call count, input tokens, output tokens, and worst-case USD in a durable ledger before any provider request can form.',
    consequence:
      'A bounded deadline does not bound provider spend, and a retry after timeout can duplicate cost without an atomic reservation and settlement record.',
    gates: ['metaclaw_infer'],
    profileEvidenceAccepted: false,
  },
  {
    id: 'MCLAW-011',
    requirement:
      'Official MetaClaw ships the security series: openclaw.autoconfigure defaulting false, proxy bearer mapping with a constant-time check, authenticated admin routes, loopback-safe startup, bounded bodies, and record policy.',
    consequence:
      'Starting the managed service mutates global OpenClaw config, disables its sandbox, and restarts its gateway; admin routes stay unauthenticated, and the port answering a probe is not known to be the service the bearer was minted for.',
    gates: ['metaclaw_infer', SERVICE_BEARER_SURFACE],
  },
  {
    id: 'MCLAW-010',
    requirement:
      'A non-editable release with a per-file digest manifest, an actual dependency freeze, a read-only source and venv, and an independent managed HOME.',
    consequence:
      'Release identity cannot be verified, so integrity drift is undetectable and provenance claims are unfounded.',
    gates: ['metaclaw_infer'],
  },
  {
    id: 'MCLAW-012',
    requirement:
      'A sealed, clearly labelled official=false downstream security candidate built from MCLAW-011 on top of MCLAW-010.',
    consequence:
      'There is no runnable build containing the security fixes, so any inference call would reach an unfixed service.',
    gates: ['metaclaw_infer'],
  },
  {
    id: 'MCLAW-014',
    requirement:
      'Official AutoResearchClaw wires MetaClawSession.get_headers into every bridged request, authenticates session-end, and stops treating 401/403 as a transport outage.',
    consequence:
      'ARC requests collapse into a shared tui-<model> main session, so this server cannot claim its side turns stay isolated from ARC.',
    gates: ['metaclaw_infer'],
  },
  {
    id: 'MCLAW-015',
    requirement:
      'A disposable candidate profile, exact provider/model, call/token/cost ceilings, and explicit billable-call authorization must be accepted before inference can form.',
    consequence:
      'Closing the ARC isolation gate would otherwise make a non-activated placeholder profile capable of forming provider traffic before the bounded acceptance decision.',
    gates: ['metaclaw_infer'],
    profileEvidenceAccepted: false,
  },
]);

export interface GateEvidence {
  readonly satisfied: boolean;
  /** Free-form operator evidence; recorded verbatim in status. */
  readonly evidence?: string;
}

export interface GateStatus extends GateDefinition {
  readonly satisfied: boolean;
  readonly evidence: string | null;
}

export function evaluateGates(
  declared: Readonly<Record<string, GateEvidence>> | undefined,
  definitions: readonly GateDefinition[] = METACLAW_GATES,
): GateStatus[] {
  return definitions.map((definition) => {
    const entry = declared?.[definition.id];
    // Satisfied requires both the flag and the evidence string. A bare `true`
    // with nothing behind it is exactly the claim this gate exists to refuse.
    const satisfied = definition.profileEvidenceAccepted !== false
      && entry?.satisfied === true
      && typeof entry.evidence === 'string'
      && entry.evidence.trim().length > 0;
    return {
      ...definition,
      satisfied,
      evidence: satisfied ? entry!.evidence!.trim() : null,
    };
  });
}

export function openGatesFor(tool: string, statuses: readonly GateStatus[]): GateStatus[] {
  return statuses.filter((status) => !status.satisfied && status.gates.includes(tool));
}

/**
 * Refuse a gated tool with the full reason rather than a generic denial. An
 * operator reading this must be able to act on it without opening the plan.
 */
export function assertToolNotGated(tool: string, statuses: readonly GateStatus[]): void {
  const open = openGatesFor(tool, statuses);
  if (open.length === 0) return;
  throw new MetaClawError(
    `${tool} is gated on ${open.map((status) => status.id).join(', ')}`,
    'limitation_gated',
    {
      tool,
      openGates: open.map((status) => ({
        id: status.id,
        requirement: status.requirement,
        consequence: status.consequence,
      })),
    },
  );
}
