import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { makeRule, subject } from './fixtures.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' });
}

test('operator CLI exposes the documented compact surface', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const command of ['validate', 'compile', 'explain', 'import', 'revoke', 'cache-clear', 'receipts', 'feedback-add']) {
    assert.match(result.stdout, new RegExp(command, 'u'));
  }
});

test('operator CLI imports, compiles, explains, and revokes against its isolated database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulespack-cli-'));
  const database = join(directory, 'state.sqlite');
  const rulesFile = join(directory, 'rules.json');
  const subjectFile = join(directory, 'subject.json');
  await writeFile(rulesFile, JSON.stringify([
    makeRule({ id: 'cli-rule', text: 'Rule imported through the operator surface.' }),
  ]));
  await writeFile(subjectFile, JSON.stringify(subject));

  const imported = runCli(['--db', database, 'import', rulesFile]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).imported, 1);

  const compiled = runCli([
    '--db', database,
    '--mode', 'enforce',
    '--subject', subjectFile,
    'compile',
  ]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.deepEqual(JSON.parse(compiled.stdout).pack.rules.map((rule: { id: string }) => rule.id), ['cli-rule']);

  const revoked = runCli(['--db', database, '--reason', 'operator test', 'revoke', 'cli-rule']);
  assert.equal(revoked.status, 0, revoked.stderr);

  const explained = runCli([
    '--db', database,
    '--mode', 'enforce',
    '--subject', subjectFile,
    'explain',
  ]);
  assert.equal(explained.status, 0, explained.stderr);
  assert.equal(JSON.parse(explained.stdout).pack.rules.length, 0);
});
