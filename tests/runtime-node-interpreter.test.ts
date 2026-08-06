import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIGS = ['ecosystem.config.cjs', 'ecosystem.core.config.cjs'];

function load(config: string, interpreter?: string): Array<{ interpreter: string }> {
  const script = [
    `const config = require(${JSON.stringify(join(ROOT, config))});`,
    'process.stdout.write(JSON.stringify(config.apps));',
  ].join('');
  const env = { ...process.env };
  if (interpreter === undefined) delete env.METABOT_NODE_INTERPRETER;
  else env.METABOT_NODE_INTERPRETER = interpreter;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env }));
}

describe('PM2 runtime Node interpreter', () => {
  it('pins the current supported Node executable by absolute path', () => {
    for (const config of CONFIGS) {
      expect(load(config).every((app) => app.interpreter === process.execPath)).toBe(true);
    }
  });

  it('pins an explicit supported absolute interpreter for every app', () => {
    for (const config of CONFIGS) {
      expect(load(config, process.execPath).every((app) => app.interpreter === process.execPath)).toBe(true);
    }
  });

  it('rejects relative and unsupported interpreters before PM2 state changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'metabot-old-node-'));
    const oldNode = join(directory, 'node');
    writeFileSync(oldNode, '#!/usr/bin/env bash\necho v20.20.2\n');
    chmodSync(oldNode, 0o755);

    for (const config of CONFIGS) {
      for (const [interpreter, expected] of [
        ['node', 'existing absolute path'],
        [oldNode, 'requires Node.js >=22.19.0'],
      ] as const) {
        const script = `require(${JSON.stringify(join(ROOT, config))})`;
        const result = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          env: { ...process.env, METABOT_NODE_INTERPRETER: interpreter },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expected);
      }
    }
  });
});
