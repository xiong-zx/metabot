import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkerModel, injectWorkerTemplates } from '../src/workers/worker-manager.js';

describe('resolveWorkerModel', () => {
  const DEFAULT = 'gpt-5.4';

  it('defaults to gpt-5.4 on codex when no model given', () => {
    expect(resolveWorkerModel(undefined, undefined, DEFAULT)).toEqual({ model: 'gpt-5.4', engine: 'codex' });
  });

  it('resolves the opus alias to claude-opus-4-8 on claude', () => {
    expect(resolveWorkerModel('opus', undefined, DEFAULT)).toEqual({ model: 'claude-opus-4-8', engine: 'claude' });
  });

  it('resolves the sonnet alias to claude-sonnet-4-6 on claude', () => {
    expect(resolveWorkerModel('sonnet', undefined, DEFAULT)).toEqual({ model: 'claude-sonnet-4-6', engine: 'claude' });
  });

  it('infers codex engine for gpt-* models', () => {
    expect(resolveWorkerModel('gpt-5.5', undefined, DEFAULT)).toEqual({ model: 'gpt-5.5', engine: 'codex' });
    expect(resolveWorkerModel('gpt-5.4-mini', undefined, DEFAULT)).toEqual({ model: 'gpt-5.4-mini', engine: 'codex' });
  });

  it('infers claude engine for claude-* models', () => {
    expect(resolveWorkerModel('claude-sonnet-4-6', undefined, DEFAULT)).toEqual({ model: 'claude-sonnet-4-6', engine: 'claude' });
  });

  it('lets an explicit engine override the inference', () => {
    expect(resolveWorkerModel('gpt-5.4', 'claude', DEFAULT).engine).toBe('claude');
  });

  it('aliases are case-insensitive', () => {
    expect(resolveWorkerModel('Opus', undefined, DEFAULT).model).toBe('claude-opus-4-8');
  });
});

describe('injectWorkerTemplates', () => {
  it('writes the worker spec into BOTH CLAUDE.md (claude) and AGENTS.md (codex)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-inject-'));
    try {
      injectWorkerTemplates(dir);
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toContain('<!-- METABOT-WORKER -->');
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain('<!-- METABOT-WORKER -->');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends once and preserves PM-curated AGENTS.md content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-inject-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# 项目记忆\n- 数据在 /data/foo\n');
      injectWorkerTemplates(dir);
      injectWorkerTemplates(dir); // idempotent
      const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
      expect(agents).toContain('数据在 /data/foo');               // preserved
      expect(agents.match(/<!-- METABOT-WORKER -->/g)!.length).toBe(1); // no duplicates
      expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
