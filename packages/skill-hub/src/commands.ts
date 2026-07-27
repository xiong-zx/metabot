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

interface SkillReferenceFile {
  path: string;
  content: string;
}

interface SkillReferencesResponse {
  files?: unknown;
}

const MAX_REFERENCES_DECOMPRESSED_BYTES = 10 * 1024 * 1024;

function collectReferenceFiles(root: string): SkillReferenceFile[] {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`publish: skill source must be a regular directory: ${root}`);
  }
  const files: SkillReferenceFile[] = [];

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(resolvedRoot, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new Error(`publish: symlinks are not supported in skill bundles: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || relativePath === 'SKILL.md') continue;

      const bytes = fs.readFileSync(absolutePath);
      const content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes)) {
        throw new Error(`publish: skill bundle file must be UTF-8 text: ${relativePath}`);
      }
      files.push({ path: relativePath, content });
    }
  }

  visit(resolvedRoot);
  return files;
}

function packReferenceFiles(root: string): string | null {
  const files = collectReferenceFiles(root);
  if (files.length === 0) return null;
  const payload = Buffer.from(JSON.stringify({ files }), 'utf8');
  if (payload.byteLength > MAX_REFERENCES_DECOMPRESSED_BYTES) {
    throw new Error('publish: skill reference files exceed the 10 MiB unpacked limit');
  }
  return zlib.gzipSync(payload).toString('base64');
}

function validateReferenceFiles(value: unknown): SkillReferenceFile[] {
  if (!Array.isArray(value)) throw new Error('install: skill references response has no files array');
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('install: skill reference entry must be an object');
    }
    const reference = candidate as { path?: unknown; content?: unknown };
    if (typeof reference.path !== 'string' || typeof reference.content !== 'string') {
      throw new Error('install: skill reference entry requires string path and content');
    }
    const filePath = reference.path;
    const normalized = path.posix.normalize(filePath);
    if (
      !filePath
      || filePath === 'SKILL.md'
      || filePath.includes('\\')
      || path.posix.isAbsolute(filePath)
      || path.win32.isAbsolute(filePath)
      || normalized !== filePath
      || normalized === '..'
      || normalized.startsWith('../')
    ) {
      throw new Error(`install: unsafe skill reference path: ${filePath}`);
    }
    if (seen.has(filePath)) throw new Error(`install: duplicate skill reference path: ${filePath}`);
    seen.add(filePath);
    return { path: filePath, content: reference.content };
  });
}

function ensureSafeInstallPath(root: string, relativePath: string): string {
  const parts = relativePath.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`install: destination contains a symlink: ${current}`);
    }
    fs.mkdirSync(current, { recursive: true });
  }
  const destination = path.join(root, ...parts);
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error(`install: destination is a symlink: ${destination}`);
  }
  return destination;
}

function assertNoSymlinkAncestors(destination: string): void {
  const absolutePath = path.resolve(destination);
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`install: destination contains a symlink: ${current}`);
    }
  }
}

export async function cmdPublish(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('publish: <skill name> required');

  const from = typeof args.flags.from === 'string' ? args.flags.from : undefined;
  const mdFlag = typeof args.flags.md === 'string' ? args.flags.md : undefined;

  let skillMd: string;
  if (mdFlag) {
    skillMd = fs.readFileSync(mdFlag, 'utf8');
  } else if (from) {
    const p = path.join(from, 'SKILL.md');
    if (!fs.existsSync(p)) throw new Error(`publish: ${p} not found (--from <dir> must contain SKILL.md)`);
    skillMd = fs.readFileSync(p, 'utf8');
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

  const publishBody: Record<string, unknown> = { skillMd, visibility };
  if (from) publishBody.referencesTar = packReferenceFiles(from);
  const result = await request<SkillRecordSnippet>(cfg, {
    method: 'POST',
    path: `/api/skills/${encodeURIComponent(name)}/publish`,
    body: publishBody,
  });
  print(result);
}

export async function cmdInstall(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('install: <skill name> required');
  const to = typeof args.flags.to === 'string' ? args.flags.to : path.join('.claude', 'skills', name);

  const record = await request<SkillRecordSnippet>(cfg, {
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  if (!record.skillMd) {
    throw new Error(`install: ${name} returned no skillMd content`);
  }
  let references: SkillReferenceFile[] = [];
  if (record.hasReferences) {
    const response = await request<SkillReferencesResponse>(cfg, {
      path: `/api/skills/${encodeURIComponent(name)}/references`,
    });
    references = validateReferenceFiles(response.files);
  }

  const installRoot = path.resolve(to);
  assertNoSymlinkAncestors(installRoot);
  fs.mkdirSync(installRoot, { recursive: true });
  const dst = ensureSafeInstallPath(installRoot, 'SKILL.md');
  fs.writeFileSync(dst, record.skillMd);
  for (const reference of references) {
    const referencePath = ensureSafeInstallPath(installRoot, reference.path);
    fs.writeFileSync(referencePath, reference.content);
  }
  print({ name, installedTo: dst, version: record.version, referencesInstalled: references.length });
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
                                      --from <dir>   bundles SKILL.md + text files
                                      --md <file>    reads file
                                      else           reads stdin
                                    Optional: --visibility published|private|shared
  install <name>                    Download the complete skill bundle
                                      [--to <dir>]   default: .claude/skills/<name>
  remove <name>                     Unpublish a skill
  health
  help

Env:
  METABOT_CORE_URL    default http://localhost:9200
  METABOT_CORE_TOKEN  bearer token (or write to ~/.metabot-core/token)
`,
  );
}
