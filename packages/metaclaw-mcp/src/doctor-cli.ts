#!/usr/bin/env node
import { assertReleaseIntact } from './integrity.js';
import { createMetaClawRuntime, currentIntegrity } from './runtime.js';

try {
  const runtime = createMetaClawRuntime();
  const integrity = await currentIntegrity(runtime);
  assertReleaseIntact(integrity);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    server: 'metaclaw-mcp',
    profile_id: runtime.profile.profileId,
    release_id: integrity.releaseId,
    release_integrity: integrity.ok,
    open_gates: runtime.gates.filter((gate) => !gate.satisfied).map((gate) => gate.id),
    model: runtime.profile.model.id,
    provider: runtime.profile.model.provider,
    endpoint: runtime.profile.endpoint.origin,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
