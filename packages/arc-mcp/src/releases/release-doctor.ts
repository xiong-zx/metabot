import type { ResolvedOfficialRelease, ResolveOfficialReleaseOptions } from '../official-driver.js';
import { resolveOfficialRelease } from '../official-driver.js';
import {
  externalReleaseId,
  listSealedReleaseIds,
  readCurrentReleaseId,
  type CommandResult,
} from './release-manager.js';
import {
  EXTERNAL_RELEASE_SPECS,
  OFFICIAL_RESEARCHCLAW_COMPAT_SPEC,
  OFFICIAL_RESEARCHCLAW_TAG_SPEC,
  specProvenanceClass,
  specRole,
} from './spec.js';

export interface ReleaseDoctorOptions {
  releaseRoot: string;
  execute(command: string, args: string[]): CommandResult;
  resolve?: (options: ResolveOfficialReleaseOptions) => Promise<ResolvedOfficialRelease>;
}

/**
 * Read-only release doctor.
 *
 * Kept outside the CLI entry point so the default pin and fail-closed result
 * are directly testable. It never installs, repairs, selects, or chmods a
 * release; resolution performs the same verification used before launch.
 */
export async function inspectReleaseDoctor(options: ReleaseDoctorOptions): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    release_root: options.releaseRoot,
    sealed_releases: safely(() => listSealedReleaseIds(options.releaseRoot)),
    current_selector: safely(() => readCurrentReleaseId(options.releaseRoot)),
    mcp_execution_pin: describe(OFFICIAL_RESEARCHCLAW_COMPAT_SPEC),
    direct_cli_pin: describe(OFFICIAL_RESEARCHCLAW_TAG_SPEC),
    selectable_specs: Object.entries(EXTERNAL_RELEASE_SPECS).map(([name, value]) => ({
      name,
      release_id: externalReleaseId(value),
      role: specRole(value),
      provenance_class: specProvenanceClass(value),
      official: !value.patch,
      revision: value.revision,
      eligible: !value.supersededBy,
      ...(value.supersedes
        ? { supersedes: { release_id: value.supersedes.releaseId, reason: value.supersedes.reason } }
        : {}),
      ...(value.supersededBy
        ? {
            superseded_by: {
              spec_name: value.supersededBy.specName,
              release_id: value.supersededBy.releaseId,
              reason: value.supersededBy.reason,
            },
          }
        : {}),
    })),
  };
  try {
    const resolved = await (options.resolve ?? resolveOfficialRelease)({
      releaseRoot: options.releaseRoot,
      execute: options.execute,
      spec: OFFICIAL_RESEARCHCLAW_COMPAT_SPEC,
    });
    report.verified = true;
    report.release_id = resolved.releaseId;
    report.driver_pairing = resolved.pairing.driver_pairing;
    report.source_dir = resolved.sourceDir;
    report.commit = resolved.manifest.commit;
    report.acpx = resolved.pairing.acpx;
    report.immutability = resolved.pairing.immutability;
  } catch (error) {
    report.verified = false;
    report.error = message(error);
  }
  return report;
}

function describe(spec: typeof OFFICIAL_RESEARCHCLAW_COMPAT_SPEC): Record<string, unknown> {
  return {
    repository: spec.repository,
    tag: spec.tag,
    revision: spec.revision,
    version: spec.version,
    release_id: externalReleaseId(spec),
    requires_sealed_trees: spec.requiresSealedTrees === true,
    ...(spec.supersedes
      ? { supersedes: { release_id: spec.supersedes.releaseId, reason: spec.supersedes.reason } }
      : {}),
  };
}

function safely<T>(read: () => T): T | { error: string } {
  try {
    return read();
  } catch (error) {
    return { error: message(error) };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
