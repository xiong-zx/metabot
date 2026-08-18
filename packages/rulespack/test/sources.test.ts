import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RulesPackError } from '../src/errors.js';
import { MetaMemorySource, StructuredSource, TrustedFileSource } from '../src/sources.js';
import { makeRule, NOW } from './fixtures.js';

test('structured temporary and curated sources enforce lifecycle and approval boundaries', () => {
  assert.throws(
    () => new StructuredSource({
      id: 'temp', kind: 'temporary', revision: '1', rules: [makeRule({ id: 'temp', text: 'No expiry.' })],
    }),
    /expiresAt/u,
  );
  assert.throws(
    () => new StructuredSource({
      id: 'curated', kind: 'curated', revision: '1', rules: [makeRule({ id: 'candidate', text: 'Not approved.' })],
    }),
    /approved/u,
  );
});

test('trusted file source parses structured Rules and blocks symlink path escape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulespack-file-'));
  const root = join(directory, 'root');
  const outside = join(directory, 'outside.json');
  await mkdir(root);
  const rule = makeRule({ id: 'file-rule', text: 'Loaded from a bounded file.' });
  const inside = join(root, 'rules.json');
  await writeFile(inside, JSON.stringify({ schemaVersion: 1, revision: 'rev-1', rules: [rule] }));
  const source = new TrustedFileSource({ id: 'file-source', trustedRoot: root, path: 'rules.json' });
  const snapshot = await source.load({ now: NOW });
  assert.equal(snapshot.rules[0]?.source.adapterId, 'file-source');

  await writeFile(outside, JSON.stringify({ schemaVersion: 1, revision: 'outside', rules: [] }));
  await symlink(outside, join(root, 'escape.json'));
  const escaped = new TrustedFileSource({ id: 'escape', trustedRoot: root, path: 'escape.json' });
  await assert.rejects(
    escaped.load({ now: NOW }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'PATH_ESCAPE',
  );
});

test('MetaMemory adapter is injected, optional, and limited to explicit host-local roots', async () => {
  assert.throws(
    () => new MetaMemorySource({
      id: 'memory',
      paths: ['/remote/rules'],
      allowedRoots: ['/local'],
      reader: { readStructuredRules: async () => ({ revision: '1', rules: [] }) },
    }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'PATH_ESCAPE',
  );
  const memory = new MetaMemorySource({
    id: 'memory',
    paths: ['/local/rules'],
    allowedRoots: ['/local'],
    reader: {
      readStructuredRules: async () => ({
        revision: 'memory-rev',
        rules: [makeRule({ id: 'memory-rule', text: 'Optional memory rule.' })],
      }),
    },
  });
  const snapshot = await memory.load({ now: NOW });
  assert.equal(snapshot.rules[0]?.source.kind, 'metamemory');
});
