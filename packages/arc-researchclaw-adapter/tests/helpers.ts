import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ArcExecutionInput } from '@xvirobotics/arc-mcp';

export function fixture(): {
  root: string;
  projectRoot: string;
  python: string;
  bridge: string;
  supervisor: string;
} {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = mkdtempSync(path.join(os.tmpdir(), 'arc-official-adapter-'));
  const projectRoot = path.join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const python = path.join(packageRoot, 'tests', 'fixtures', 'fake-python.mjs');
  chmodSync(python, 0o755);
  return {
    root,
    projectRoot,
    python,
    bridge: path.join(packageRoot, 'python', 'bridge.py'),
    supervisor: path.join(packageRoot, 'dist', 'supervisor.js'),
  };
}

export function input(projectRoot: string, runId: string, objective: string): ArcExecutionInput {
  return {
    contract_version: 'autoresearchclaw.input.v1',
    project_id: 'project-1',
    run_id: runId,
    objective,
    project_root: projectRoot,
    artifact_path: `.metabot-arc/runs/${runId}/output.json`,
    requested_at: new Date().toISOString(),
  };
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}
