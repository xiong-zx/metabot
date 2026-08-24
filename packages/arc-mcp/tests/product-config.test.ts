import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadArcProductConfig, readArcProductBearer } from '../src/product-config.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDirectory(root);
});

function fixture(): { configFile: string; bearerFile: string; projectRoot: string } {
  const root = temporaryDirectory('arc-product-config-');
  roots.push(root);
  const projectRoot = projectDirectory(root);
  const bearerFile = path.join(root, 'bearer');
  const configFile = path.join(root, 'config.json');
  writeFileSync(bearerFile, 'arc-product-test-bearer-0000000000000001\n', { mode: 0o600 });
  writeFileSync(configFile, JSON.stringify({
    version: 1,
    service_url: 'http://127.0.0.1:9411/mcp',
    bearer_file: bearerFile,
    data_dir: path.join(root, 'data'),
    allowed_project_roots: [projectRoot],
    runner_module: path.join(root, 'runner.mjs'),
  }), { mode: 0o600 });
  return { configFile, bearerFile, projectRoot };
}

describe('ARC product-owned configuration', () => {
  it('loads a private config and bearer without any MetaBot identity', () => {
    const kit = fixture();
    const config = loadArcProductConfig({ ARC_MCP_CONFIG_FILE: kit.configFile });
    expect(config.service_url).toBe('http://127.0.0.1:9411/mcp');
    expect(config.allowed_project_roots).toEqual([kit.projectRoot]);
    expect(readArcProductBearer(config)).toHaveLength(40);
    expect(JSON.stringify(config)).not.toMatch(/botName|chatId|role|capability|audience|public.key/i);
  });

  it('rejects remote endpoints and broadly readable product files', () => {
    const kit = fixture();
    const config = JSON.parse(requireText(kit.configFile)) as Record<string, unknown>;
    config.service_url = 'https://example.com/mcp';
    writeFileSync(kit.configFile, JSON.stringify(config), { mode: 0o600 });
    expect(() => loadArcProductConfig({ ARC_MCP_CONFIG_FILE: kit.configFile })).toThrow(/loopback/i);

    config.service_url = 'http://127.0.0.1:9411/mcp';
    writeFileSync(kit.configFile, JSON.stringify(config), { mode: 0o600 });
    chmodSync(kit.bearerFile, 0o644);
    const loaded = loadArcProductConfig({ ARC_MCP_CONFIG_FILE: kit.configFile });
    expect(() => readArcProductBearer(loaded)).toThrow(/permissions/i);
  });
});

function requireText(file: string): string {
  return readFileSync(file, 'utf8');
}
