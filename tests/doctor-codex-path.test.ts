import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `metabot doctor` resolves the Codex executable the same way the bridge does.
 * When it only looked at PATH it reported `codex_missing` on hosts where Codex
 * lives in ~/.local/bin and the bridge runs it without trouble.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METABOT_BIN = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'metabot'), 'utf-8');
const EXECUTOR_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'src', 'engines', 'codex', 'executor.ts'),
  'utf-8',
);

function extractResolver(): string {
  const start = METABOT_BIN.indexOf('CODEX_FALLBACK_CANDIDATES = (');
  if (start === -1) throw new Error('Missing CODEX_FALLBACK_CANDIDATES in bin/metabot');
  const end = METABOT_BIN.indexOf('\ncodex_path = ', start);
  if (end === -1) throw new Error('Missing codex_path assignment in bin/metabot');
  return METABOT_BIN.slice(start, end);
}

const RESOLVER_SOURCE = extractResolver();

/** Run the shipped resolver with injected `which` / `exists` and a fake HOME. */
function resolve(opts: {
  explicit?: string | null;
  whichResult?: string | null;
  existing?: string[];
  home?: string;
}): string | null {
  const driver = [
    'import json, os, shutil, sys',
    'from pathlib import Path',
    RESOLVER_SOURCE,
    'params = json.loads(sys.argv[1])',
    'existing = set(params["existing"])',
    'result = resolve_codex_executable(',
    '    params["explicit"],',
    '    which=lambda _name: params["whichResult"],',
    '    exists=lambda p: p in existing,',
    ')',
    'print(json.dumps(result))',
  ].join('\n');

  const payload = JSON.stringify({
    explicit: opts.explicit ?? null,
    whichResult: opts.whichResult ?? null,
    existing: opts.existing ?? [],
  });
  const out = execFileSync('python3', ['-c', driver, payload], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: opts.home ?? '/home/tester' },
  });
  return JSON.parse(out) as string | null;
}

describe('metabot doctor codex executable resolution', () => {
  it('honors CODEX_EXECUTABLE_PATH when it exists', () => {
    expect(resolve({ explicit: '/opt/codex/bin/codex', existing: ['/opt/codex/bin/codex'] }))
      .toBe('/opt/codex/bin/codex');
  });

  it('ignores a stale CODEX_EXECUTABLE_PATH and keeps looking', () => {
    expect(resolve({ explicit: '/gone/codex', whichResult: '/usr/bin/codex' }))
      .toBe('/usr/bin/codex');
  });

  it('prefers PATH over the fallback candidates', () => {
    expect(resolve({ whichResult: '/usr/bin/codex', existing: ['/home/tester/.local/bin/codex'] }))
      .toBe('/usr/bin/codex');
  });

  it('finds ~/.local/bin/codex when PATH does not include it', () => {
    // The regression this guards: doctor said codex_missing while the bridge,
    // which has the same fallback list, ran Codex from exactly this path.
    expect(resolve({ whichResult: null, existing: ['/home/tester/.local/bin/codex'] }))
      .toBe('/home/tester/.local/bin/codex');
  });

  it('finds the other install locations the executor knows about', () => {
    for (const candidate of ['/usr/local/bin/codex', '/opt/homebrew/bin/codex', '/home/tester/.npm-global/bin/codex']) {
      expect(resolve({ whichResult: null, existing: [candidate] })).toBe(candidate);
    }
  });

  it('reports nothing when Codex really is absent', () => {
    expect(resolve({ whichResult: null, existing: [] })).toBeNull();
  });

  it('uses the same candidate list as the Codex executor', () => {
    const executorList = EXECUTOR_SOURCE.slice(
      EXECUTOR_SOURCE.indexOf('for (const candidate of ['),
      EXECUTOR_SOURCE.indexOf(']) {', EXECUTOR_SOURCE.indexOf('for (const candidate of [')),
    );
    const executorCandidates = [
      /path\.join\(home, '\.local', 'bin', 'codex'\)/.test(executorList) && '~/.local/bin/codex',
      /'\/usr\/local\/bin\/codex'/.test(executorList) && '/usr/local/bin/codex',
      /'\/usr\/bin\/codex'/.test(executorList) && '/usr/bin/codex',
      /'\/opt\/homebrew\/bin\/codex'/.test(executorList) && '/opt/homebrew/bin/codex',
      /path\.join\(home, '\.npm-global', 'bin', 'codex'\)/.test(executorList) && '~/.npm-global/bin/codex',
    ].filter(Boolean);

    const doctorList = RESOLVER_SOURCE.slice(
      RESOLVER_SOURCE.indexOf('CODEX_FALLBACK_CANDIDATES = ('),
      RESOLVER_SOURCE.indexOf(')', RESOLVER_SOURCE.indexOf('CODEX_FALLBACK_CANDIDATES = (')),
    );
    const doctorCandidates = [...doctorList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(doctorCandidates).toEqual(executorCandidates);
  });
});
