import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('adapter package boundary', () => {
  it('has no production Worker Runner, Bridge, Memory, Agent Team, WorkerManager, or Claude-specific import', () => {
    const source = readdirSync(sourceRoot)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(path.join(sourceRoot, name), 'utf8'))
      .join('\n');
    for (const forbidden of [
      '@xvirobotics/worker-runner-mcp',
      'src/bridge',
      'memory-core',
      'metamemory',
      'agent-team',
      'WorkerManager',
      'claude-agent-sdk',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
