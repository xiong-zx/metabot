#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const IMPLEMENTATION = /^(?:feat|fix|refactor|perf)(?:\([^)]+\))?!?:\s+\S/u;
const INTEGRATION_BRANCH = /^(?:main|dev)$|^(?:integration|sync|release)\//u;

export function checkFeatureHistory({ branch, commits, changedFiles }) {
  if (INTEGRATION_BRANCH.test(branch)) return [];
  const failures = [];
  const normalized = commits.map((commit) => typeof commit === 'string'
    ? { subject: commit.trim(), files: changedFiles }
    : { subject: commit.subject.trim(), files: commit.files ?? [] });
  const subjects = normalized.map((commit) => commit.subject).filter(Boolean);
  const unfinished = subjects.filter((subject) => /^(?:fixup|squash)!/u.test(subject));
  if (unfinished.length) failures.push(`unfinished commits are forbidden: ${unfinished.join(', ')}`);
  if (normalized.length !== 1) {
    failures.push(`feature branches require exactly one final commit; found ${normalized.length}`);
  }
  const finalCommit = normalized.length === 1 ? normalized[0] : undefined;
  if (finalCommit?.files.some(isProductionPath) && !IMPLEMENTATION.test(finalCommit.subject)) {
    failures.push('the production-code commit must use feat, fix, refactor, or perf conventional syntax');
  }
  return failures;
}

function isProductionPath(file) {
  return !(
    /^(?:docs|test|tests)\//u.test(file) ||
    /\/(?:test|tests)\//u.test(file) ||
    /(?:^|\/)fixtures?\//u.test(file) ||
    /\.test\.[cm]?[jt]sx?$/u.test(file) ||
    /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE)\.md$/u.test(file) ||
    /\.md$/u.test(file)
  );
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function lines(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean);
}

function main() {
  const base = flag('--base');
  const head = flag('--head') ?? 'HEAD';
  const branch = flag('--branch') ?? process.env.GITHUB_HEAD_REF ?? '';
  if (!base || !branch) {
    throw new Error('Usage: check-feature-history.mjs --base <sha> --branch <name> [--head <sha>]');
  }
  const commitIds = lines(['log', '--format=%H', '--no-merges', `${base}..${head}`]);
  const commits = commitIds.map((commit) => ({
    subject: lines(['show', '-s', '--format=%s', commit])[0] ?? '',
    files: lines(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]),
  }));
  const failures = checkFeatureHistory({
    branch,
    commits,
    changedFiles: lines(['diff', '--name-only', `${base}...${head}`]),
  });
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Feature history gate passed.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
