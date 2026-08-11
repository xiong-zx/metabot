import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { request } from './client.js';
import type { Config } from './config.js';
import { print } from '@xvirobotics/cli-core/print';
import type { ParsedArgs } from '@xvirobotics/cli-core/args';

export { parseArgs } from '@xvirobotics/cli-core/args';
export type { ParsedArgs } from '@xvirobotics/cli-core/args';

// ---- Commands ----

export async function cmdList(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/api/skills' });
  print(body);
}

export async function cmdSearch(cfg: Config, args: ParsedArgs): Promise<void> {
  const q = args.positional[0];
  if (!q) throw new Error('search: <query> required');
  const body = await request(cfg, {
    path: '/api/skills/search',
    query: { q },
  });
  print(body);
}

export async function cmdGet(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('get: <skill name> required');
  const body = await request(cfg, {
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  print(body);
}

interface SkillRecordSnippet {
  name?: string;
  version?: number;
  skillMd?: string;
  hasReferences?: boolean;
}

interface SkillBundleFile {
  path: string;
  content: string;
  encoding?: 'base64' | 'utf8';
  mode?: number;
}

interface SkillReferencesResponse {
  name?: string;
  version?: number;
  files?: unknown;
}

const DEFAULT_SKILL_INSTALL_ROOT = path.join('.metabot', 'skills');
const ENGINE_SKILL_DIRS = new Set(['.claude/skills', '.codex/skills', '.agents/skills']);

function flagEnabled(value: string | true | undefined): boolean {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

const SKIPPED_BUNDLE_DIRS = new Set(['.git', 'node_modules']);

function collectBundleFiles(root: string): SkillBundleFile[] {
  const files: SkillBundleFile[] = [];

  function visit(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_BUNDLE_DIRS.has(entry.name)) continue;
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (relativePath === 'SKILL.md') continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`publish: symbolic links are not supported in skill bundles (${relativePath})`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`publish: unsupported bundle entry (${relativePath})`);
      }
      const stat = fs.statSync(absolutePath);
      files.push({
        path: relativePath,
        content: fs.readFileSync(absolutePath).toString('base64'),
        encoding: 'base64',
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
      });
    }
  }

  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function packBundleFiles(files: SkillBundleFile[]): string | null {
  if (files.length === 0) return null;
  const payload = Buffer.from(JSON.stringify({ files }), 'utf8');
  return zlib.gzipSync(payload).toString('base64');
}

function validateBundlePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('install: bundle contains an invalid file path');
  }
  const portable = value.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) {
    throw new Error(`install: bundle contains an absolute file path (${value})`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== portable) {
    throw new Error(`install: bundle contains an unsafe file path (${value})`);
  }
  if (normalized === 'SKILL.md') {
    throw new Error('install: bundle references must not replace SKILL.md');
  }
  return normalized;
}

function parseBundleFiles(value: unknown): Array<{ path: string; content: Buffer; mode: number }> {
  if (!Array.isArray(value)) throw new Error('install: references response contains no file list');
  const files: Array<{ path: string; content: Buffer; mode: number }> = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') throw new Error('install: bundle contains an invalid file entry');
    const entry = raw as Partial<SkillBundleFile>;
    const relativePath = validateBundlePath(entry.path);
    const portableKey = relativePath.toLocaleLowerCase('en-US');
    if (seen.has(portableKey)) throw new Error(`install: bundle contains a duplicate file path (${relativePath})`);
    seen.add(portableKey);
    if (typeof entry.content !== 'string') {
      throw new Error(`install: bundle file has invalid content (${relativePath})`);
    }
    let content: Buffer;
    if (entry.encoding === undefined || entry.encoding === 'utf8') {
      content = Buffer.from(entry.content, 'utf8');
    } else if (entry.encoding === 'base64') {
      content = Buffer.from(entry.content, 'base64');
    } else {
      throw new Error(`install: bundle file has unsupported encoding (${relativePath})`);
    }
    const mode = entry.mode === 0o755 ? 0o755 : 0o644;
    files.push({ path: relativePath, content, mode });
  }

  const filePaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== '.') {
      if (filePaths.has(parent)) {
        throw new Error(`install: bundle path is both a file and a directory (${parent})`);
      }
      parent = path.posix.dirname(parent);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function installBundleAtomically(
  targetDir: string,
  skillMd: string,
  files: Array<{ path: string; content: Buffer; mode: number }>,
): void {
  const target = path.resolve(targetDir);
  if (target === path.parse(target).root) throw new Error('install: refusing to replace a filesystem root');
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.install-`));
  let backup: string | undefined;

  try {
    fs.writeFileSync(path.join(stage, 'SKILL.md'), skillMd, { mode: 0o644 });
    for (const file of files) {
      const destination = path.join(stage, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, { mode: file.mode });
    }

    if (fs.existsSync(target)) {
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error(`install: refusing to replace symbolic link target (${targetDir})`);
      }
      backup = `${target}.previous-${process.pid}-${Date.now()}`;
      fs.renameSync(target, backup);
    }
    try {
      fs.renameSync(stage, target);
    } catch (error) {
      if (backup && fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
      throw error;
    }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function defaultInstallDir(name: string): string {
  return path.join(DEFAULT_SKILL_INSTALL_ROOT, name);
}

export function targetsEngineAutoloadDir(dir: string): boolean {
  const normalized = path.normalize(dir).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (ENGINE_SKILL_DIRS.has(`${parts[i]}/${parts[i + 1]}`)) return true;
  }
  return false;
}

export async function cmdPublish(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('publish: <skill name> required');

  const from = typeof args.flags.from === 'string' ? args.flags.from : undefined;
  const mdFlag = typeof args.flags.md === 'string' ? args.flags.md : undefined;

  let skillMd: string;
  let referencesTar: string | null | undefined;
  if (mdFlag) {
    skillMd = fs.readFileSync(mdFlag, 'utf8');
  } else if (from) {
    const p = path.join(from, 'SKILL.md');
    if (!fs.existsSync(p)) throw new Error(`publish: ${p} not found (--from <dir> must contain SKILL.md)`);
    skillMd = fs.readFileSync(p, 'utf8');
    referencesTar = packBundleFiles(collectBundleFiles(from));
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    skillMd = await new Promise<string>((resolve, reject) => {
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
      process.stdin.on('error', reject);
    });
  } else {
    throw new Error('publish: provide --from <dir> with SKILL.md, --md <file>, or pipe to stdin');
  }

  const visibility =
    typeof args.flags.visibility === 'string' ? args.flags.visibility : undefined;

  const body = await request<SkillRecordSnippet>(cfg, {
    method: 'POST',
    path: `/api/skills/${encodeURIComponent(name)}/publish`,
    body: { skillMd, visibility, ...(from ? { referencesTar } : {}) },
  });
  print(body);
}

export async function cmdInstall(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('install: <skill name> required');
  const to = typeof args.flags.to === 'string' ? args.flags.to : defaultInstallDir(name);
  const trust = flagEnabled(args.flags.trust) || flagEnabled(args.flags.yes) || flagEnabled(args.flags.y);
  if (targetsEngineAutoloadDir(to) && !trust) {
    throw new Error(
      'install: refusing to write into an engine auto-load skills directory without --trust; '
      + 'install to .metabot/skills first, review SKILL.md, then rerun with --trust if you want the engine to auto-load it',
    );
  }

  const record = await request<SkillRecordSnippet>(cfg, {
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  if (!record.skillMd) {
    throw new Error(`install: ${name} returned no skillMd content`);
  }
  let files: Array<{ path: string; content: Buffer; mode: number }> = [];
  if (record.hasReferences) {
    const references = await request<SkillReferencesResponse>(cfg, {
      path: `/api/skills/${encodeURIComponent(name)}/references`,
    });
    files = parseBundleFiles(references.files);
  }
  installBundleAtomically(to, record.skillMd, files);
  const dst = path.join(to, 'SKILL.md');
  print({
    name,
    installedTo: dst,
    version: record.version,
    filesInstalled: files.length + 1,
    trusted: targetsEngineAutoloadDir(to),
  });
}

export async function cmdRemove(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('remove: <skill name> required');
  const body = await request(cfg, {
    method: 'DELETE',
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  print(body);
}

export async function cmdHealth(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/health' });
  print(body);
}

export function printHelp(): void {
  process.stdout.write(
    `metabot skills — metabot-core skill-hub CLI

Usage: metabot skills <command> [args]

Commands:
  list                              List all visible skills
  search <query>                    FTS search over published skills
  get <name>                        Get one skill (includes SKILL.md)
  publish <name>                    Publish a skill. Source order:
                                      --from <dir>   uploads the complete bundle
                                      --md <file>    reads file
                                      else           reads stdin
                                    Optional: --visibility published|private|shared
  install <name>                    Download the complete bundle to a local review dir
                                      [--to <dir>]   default: .metabot/skills/<name>
                                      [--trust]      required when --to points at .claude/.codex/.agents skills
  remove <name>                     Unpublish a skill
  health
  help

Env:
  METABOT_CORE_URL    default http://localhost:9200
  METABOT_CORE_TOKEN  bearer token (or write to ~/.metabot-core/token)
`,
  );
}
