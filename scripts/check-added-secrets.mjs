#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SECRET_SCAN_MAX_DIFF_BYTES = 128 * 1024 * 1024;

const PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['aws-temporary-access-key', /\bASIA[0-9A-Z]{16}\b/u],
  ['github-token', /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/u],
  ['openai-token', /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/u],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/iu],
  [
    'assigned-secret-literal',
    /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|feishuAppSecret|slackSigningSecret|telegramBotToken|botToken)\b\s*[:=]\s*(["'])(?!test|fake|dummy|example|placeholder|redacted)(?=[A-Za-z0-9._~+/-]{20,}\1)[A-Za-z0-9._~+/-]+\1/iu,
  ],
  [
    'environment-secret-literal',
    /\b(?:FEISHU_APP_SECRET|SLACK_SIGNING_SECRET|TELEGRAM_BOT_TOKEN|WECHAT_BOT_TOKEN|CODEX_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b\s*=\s*["']?(?!process\.env\b)(?!test|fake|dummy|example|placeholder|redacted)[A-Za-z0-9._~+/-]{20,}["']?/u,
  ],
];

export function findSecretFindings(diff) {
  const findings = [];
  let file = 'unknown';
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    if (/secret-scan:\s*allow\([^)\r\n]{8,}\)/iu.test(added)) continue;
    for (const [kind, pattern] of PATTERNS) {
      if (pattern.test(added)) findings.push({ file, kind });
    }
  }
  return findings;
}

export function readGitDiff(base, head = 'HEAD', git = 'git') {
  return execFileSync(
    git,
    ['diff', '--no-ext-diff', '--unified=0', `${base}...${head}`],
    { encoding: 'utf8', maxBuffer: SECRET_SCAN_MAX_DIFF_BYTES },
  );
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const base = flag('--base');
  const head = flag('--head') ?? 'HEAD';
  if (!base) throw new Error('Usage: check-added-secrets.mjs --base <sha> [--head <sha>]');
  const diff = readGitDiff(base, head);
  const findings = findSecretFindings(diff);
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.file}: added ${finding.kind}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Added-line secret scan passed.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
