import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const configSchema = z
  .object({
    version: z.literal(1),
    service_url: z.string().url(),
    bearer_file: z.string().min(1),
    data_dir: z.string().min(1),
    allowed_project_roots: z.array(z.string().min(1)).min(1),
    fixed_project_id: z.string().trim().min(1).optional(),
    release_root: z.string().min(1).optional(),
    runner_module: z.string().min(1).optional(),
    official_config_file: z.string().min(1).optional(),
    official_hitl_mode: z.string().min(1).optional(),
    official_acp_agent: z.string().min(1).optional(),
    official_acpx_command: z.string().min(1).optional(),
  })
  .strict();

export type ArcProductConfig = z.infer<typeof configSchema> & {
  config_file: string;
};

export function defaultArcConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.config', 'arc-mcp', 'config.json');
}

export function loadArcProductConfig(env: NodeJS.ProcessEnv = process.env): ArcProductConfig {
  const requested = env.ARC_MCP_CONFIG_FILE?.trim() || defaultArcConfigPath();
  if (!path.isAbsolute(requested)) throw new Error('ARC_MCP_CONFIG_FILE must be absolute');
  const configFile = privateRegularFile(requested, 'ARC MCP config');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `ARC MCP config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error('ARC MCP config does not match version 1');
  if (parsed.data.release_root && parsed.data.runner_module) {
    throw new Error('ARC MCP config must choose release_root or runner_module, not both');
  }
  const serviceUrl = validateArcServiceUrl(parsed.data.service_url).toString();
  return {
    ...parsed.data,
    service_url: serviceUrl,
    bearer_file: absolutePath(parsed.data.bearer_file, 'bearer_file'),
    data_dir: absolutePath(parsed.data.data_dir, 'data_dir'),
    allowed_project_roots: parsed.data.allowed_project_roots.map((value) => absolutePath(value, 'allowed_project_roots')),
    ...(parsed.data.release_root ? { release_root: absolutePath(parsed.data.release_root, 'release_root') } : {}),
    ...(parsed.data.runner_module ? { runner_module: absolutePath(parsed.data.runner_module, 'runner_module') } : {}),
    ...(parsed.data.official_config_file
      ? { official_config_file: absolutePath(parsed.data.official_config_file, 'official_config_file') }
      : {}),
    config_file: configFile,
  };
}

export function readArcProductBearer(config: ArcProductConfig): string {
  const value = readFileSync(privateRegularFile(config.bearer_file, 'ARC MCP bearer file'), 'utf8').trim();
  if (value.length < 32 || value.length > 4096 || /\s/.test(value)) {
    throw new Error('ARC MCP bearer must contain 32-4096 non-whitespace characters');
  }
  return value;
}

export function validateArcServiceUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    !url.pathname ||
    url.pathname === '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('ARC MCP service_url must be dedicated loopback HTTP with an explicit port');
  }
  return url;
}

export function arcRuntimeEnvironment(config: ArcProductConfig): NodeJS.ProcessEnv {
  return {
    ARC_MCP_DATA_DIR: config.data_dir,
    ARC_MCP_PROJECT_ROOTS: JSON.stringify(config.allowed_project_roots),
    ...(config.fixed_project_id ? { ARC_MCP_PROJECT_ID: config.fixed_project_id } : {}),
    ...(config.release_root ? { ARC_MCP_RELEASE_ROOT: config.release_root } : {}),
    ...(config.runner_module ? { ARC_MCP_RUNNER_MODULE: config.runner_module } : {}),
    ...(config.official_config_file ? { ARC_MCP_OFFICIAL_CONFIG_FILE: config.official_config_file } : {}),
    ...(config.official_hitl_mode ? { ARC_MCP_OFFICIAL_HITL_MODE: config.official_hitl_mode } : {}),
    ...(config.official_acp_agent ? { ARC_MCP_OFFICIAL_ACP_AGENT: config.official_acp_agent } : {}),
    ...(config.official_acpx_command ? { ARC_MCP_OFFICIAL_ACPX_COMMAND: config.official_acpx_command } : {}),
  };
}

function privateRegularFile(value: string, label: string): string {
  const absolute = absolutePath(value, label);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group or other access`);
  }
  if (statSync(absolute).size < 1 || statSync(absolute).size > 1_048_576) {
    throw new Error(`${label} has an invalid size`);
  }
  return realpathSync(absolute);
}

function absolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}
