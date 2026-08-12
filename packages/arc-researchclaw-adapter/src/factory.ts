import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ArcRunner } from '@xvirobotics/arc-mcp';

import { OfficialResearchClawAdapter, probeOfficialResearchClaw } from './adapter.js';

let probePromise: Promise<unknown> | undefined;

export async function createArcRunner(): Promise<ArcRunner> {
  const env = process.env;
  const stateRoot = path.resolve(
    env.METABOT_STATE_DIR?.trim() || env.METABOT_STATE_ROOT?.trim() || path.join(os.homedir(), '.metabot'),
  );
  const python = path.resolve(
    env.METABOT_ARC_RESEARCHCLAW_PYTHON?.trim() || path.join(stateRoot, 'arc-official', 'venv', 'bin', 'python3'),
  );
  const bridgePath = fileURLToPath(new URL('../python/bridge.py', import.meta.url));
  probePromise ??= probeOfficialResearchClaw(python, bridgePath);
  await probePromise;
  return new OfficialResearchClawAdapter({
    python,
    bridgePath,
    supervisorPath: fileURLToPath(new URL('./supervisor.js', import.meta.url)),
    ...(env.METABOT_ARC_RESEARCHCLAW_CONFIG?.trim()
      ? { defaultConfigPath: env.METABOT_ARC_RESEARCHCLAW_CONFIG.trim() }
      : {}),
    ...(env.METABOT_ARC_DEFAULT_HITL_MODE?.trim()
      ? { defaultHitlMode: env.METABOT_ARC_DEFAULT_HITL_MODE.trim() }
      : {}),
    ...(env.METABOT_ARC_ACP_AGENT?.trim() ? { acpAgent: env.METABOT_ARC_ACP_AGENT.trim() } : {}),
    ...(env.METABOT_ARC_ACPX_COMMAND?.trim() ? { acpxCommand: env.METABOT_ARC_ACPX_COMMAND.trim() } : {}),
    pollIntervalMs: integer(env.METABOT_ARC_POLL_MS, 1_000),
    stopTimeoutMs: integer(env.METABOT_ARC_STOP_TIMEOUT_MS, 10_000),
  });
}

function integer(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('ARC official adapter timing value must be positive');
  return parsed;
}
