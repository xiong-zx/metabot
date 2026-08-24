import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkDownstreamBoundaries } from '../../../scripts/check-downstream-boundaries.mjs';
import { METACLAW_GATES } from '../src/gates.js';
import { METACLAW_TOOL_NAMES } from '../src/tools.js';

const SOURCE_DIR = path.join(import.meta.dirname, '..', 'src');
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

function sourceFiles(): Array<{ file: string; text: string }> {
  return readdirSync(SOURCE_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(path.join(SOURCE_DIR, file), 'utf8') }));
}

describe('package boundaries', () => {
  it('runs the AST import boundary over both source and test files', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'config/downstream-features.json'), 'utf8'));
    const feature = manifest.features.find((entry: { id: string }) => entry.id === 'metaclaw-mcp');
    expect(feature.importRoots).toEqual(['packages/metaclaw-mcp']);

    const failures = checkDownstreamBoundaries(REPOSITORY_ROOT).failures
      .filter((failure: string) => failure.startsWith('metaclaw-mcp:'));
    expect(failures).toEqual([]);
  });

  it('imports no ARC, Worker Runner, Bridge, Memory, or database module', () => {
    const forbidden = [
      '@xvirobotics/arc-mcp',
      '@xvirobotics/arc-researchclaw-adapter',
      '@xvirobotics/arc-worker-runner-adapter',
      '@xvirobotics/worker-runner-mcp',
      '@xvirobotics/metabot-core-server',
      '@xvirobotics/metamemory',
      '@xvirobotics/skill-hub',
      '@anthropic-ai/',
      'better-sqlite3',
      '../../../src/',
      '../../arc-mcp/',
      '../../server/',
    ];
    for (const { file, text } of sourceFiles()) {
      for (const specifier of forbidden) {
        expect(text.includes(`'${specifier}`), `${file} must not import ${specifier}`).toBe(false);
      }
    }
  });

  it('never gains the ability to spawn or signal a process', () => {
    // No lifecycle control means no process handle: this server cannot start,
    // stop, restart, or repair the official service even by accident.
    const forbidden = ['child_process', 'node:child_process', 'spawnSync', 'execSync', 'process.kill'];
    for (const { file, text } of sourceFiles()) {
      for (const specifier of forbidden) {
        expect(text.includes(specifier), `${file} must not reference ${specifier}`).toBe(false);
      }
    }
  });

  it('reads no operator home state directly', () => {
    // Every path comes from the profile or an explicit absolute environment
    // variable, so the direct CLI's default ~/.metaclaw stays untouched.
    for (const { file, text } of sourceFiles()) {
      for (const specifier of ['homedir', 'os.homedir', '~/.metaclaw', '~/.openclaw', '~/.metabot']) {
        expect(text.includes(specifier), `${file} must not reference ${specifier}`).toBe(false);
      }
    }
  });

  it('keeps the declared tool surface at exactly five read-or-infer tools', () => {
    expect(METACLAW_TOOL_NAMES).toHaveLength(5);
    expect([...METACLAW_TOOL_NAMES]).toEqual([
      'metaclaw_health',
      'metaclaw_status',
      'metaclaw_infer',
      'metaclaw_skills_list',
      'metaclaw_skill_get',
    ]);
  });

  it('declares every upstream dependency this integration is waiting on', () => {
    expect(METACLAW_GATES.map((gate) => gate.id)).toEqual([
      'MCLAW-COST-LEDGER', 'MCLAW-011', 'MCLAW-010', 'MCLAW-012', 'MCLAW-014',
    ]);
    for (const gate of METACLAW_GATES) {
      expect(gate.requirement.length, gate.id).toBeGreaterThan(20);
      expect(gate.consequence.length, gate.id).toBeGreaterThan(20);
      expect(gate.gates, gate.id).toContain('metaclaw_infer');
    }
  });
});
