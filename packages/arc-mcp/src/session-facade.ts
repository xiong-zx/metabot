import type { ArcArtifactStore } from './artifact-store.js';
import type { ArcRunRecord } from './contract.js';
import type { ArcCoordinator } from './coordinator.js';
import { ArcError } from './errors.js';
import {
  arcHitlSubmitRequestSchema,
  listPendingHitlRequests,
  writeHitlResponse,
  type ArcHitlRequestRecord,
  type ArcHitlResponseRecord,
} from './hitl.js';
import { OfficialArcDriver } from './official-driver.js';
import { readSupervisorRequest } from './official-state.js';
import { buildArcResultManifest, type ArcResultManifest } from './provenance.js';
import type { ArcProjectScope } from './scope-policy.js';

/**
 * Narrows the single server-wide coordinator to one authenticated connection
 * for the two surfaces that need an operator identity: HITL decisions and the
 * provenance manifest.
 *
 * The coordinator stays the sole owner of the lifecycle database and of every
 * in-flight collection; this facade only re-checks that the run is inside the
 * server's own project scope before it reads or writes anything beside it.
 */
export class ArcSessionFacade {
  constructor(
    private readonly coordinator: ArcCoordinator,
    private readonly artifacts: ArcArtifactStore,
    private readonly scope: ArcProjectScope,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  submitHitl(request: unknown): { run: ArcRunRecord; response: ArcHitlResponseRecord } {
    const parsed = arcHitlSubmitRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new ArcError('invalid_contract', 'Invalid ARC HITL submit request', {
        details: {
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
    }
    const run = this.authorized(parsed.data.run_id);
    const response = writeHitlResponse(
      this.artifacts,
      { projectRoot: run.project_root, runId: run.run_id },
      parsed.data,
      this.responder(),
      this.now(),
    );
    return { run, response };
  }

  artifactManifest(request: unknown): { manifest: ArcResultManifest; pending_hitl: ArcHitlRequestRecord[] } {
    const runId = (request as { run_id?: unknown } | null)?.run_id;
    if (typeof runId !== 'string' || !runId.trim()) {
      throw new ArcError('invalid_contract', 'run_id is required');
    }
    const run = this.authorized(runId.trim());
    // Provenance may only claim official execution when the driver that
    // actually owns this run re-verified a sealed release.
    const driver = this.coordinator.runner instanceof OfficialArcDriver ? this.coordinator.runner : undefined;
    const release = driver?.release;
    const capturedConfigDigest = officialConfigDigest(run);
    return {
      manifest: buildArcResultManifest({
        run,
        artifacts: this.artifacts,
        ...(release
          ? {
              releaseManifest: release.manifest,
              releaseManifestPath: release.manifestPath,
              driverPairing: release.pairing.driver_pairing ?? 'current',
            }
          : { fallbackReason: 'official external release was not verified for this daemon' }),
        effectiveConfig: {
          project_id: run.project_id,
          project_root: run.project_root,
          artifact_path: run.artifact_path,
          idempotency_key: run.idempotency_key,
          request_fingerprint: run.request_fingerprint,
        },
        ...(capturedConfigDigest ? { effectiveConfigDigest: capturedConfigDigest } : {}),
      }),
      pending_hitl: listPendingHitlRequests(this.artifacts, {
        projectRoot: run.project_root,
        runId: run.run_id,
      }),
    };
  }

  private authorized(runId: string): ArcRunRecord {
    return this.scope.authorizeRun(this.coordinator.get({ run_id: runId }));
  }

  private responder(): { bot_name: string; chat_id: string } {
    // The operator-pinned standalone stdio mode has no per-connection identity;
    // recording it explicitly keeps the decision attributable either way.
    return { bot_name: 'arc-mcp-operator', chat_id: 'local:product-service' };
  }
}

function officialConfigDigest(run: ArcRunRecord): string | undefined {
  const metadata = run.runner_handle?.metadata;
  if (metadata?.runner !== 'official-autoresearchclaw' || typeof metadata.request_path !== 'string') return undefined;
  const request = readSupervisorRequest(metadata.request_path);
  if (request.input.run_id !== run.run_id || request.input.project_root !== run.project_root) {
    throw new ArcError('runner_failure', 'Official ARC supervisor request does not match the durable run');
  }
  return request.config_sha256;
}
