import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUPPORT_FILES = new Set(['README.md', 'INDEX.md']);
const SAFE_HOST = /^[a-zA-Z0-9._-]+$/u;
const SAFE_PROJECT = /^[a-z0-9][a-z0-9-]*$/u;
const SAFE_REMOTE_PATH = /^\/[a-zA-Z0-9._/-]+$/u;
const CANONICAL_FILENAME =
  /^[a-z0-9][a-z0-9-]*_[a-z0-9]+(?:-[a-z0-9-]+)?_[a-z0-9][a-z0-9-]*(?:_[a-z]+-[a-z0-9-]+)*_[0-9]{8}_v[0-9]{2}\.[a-z0-9]+(?:\.[a-z0-9]+)?$/u;

export interface ArtifactMirrorProjectConfig {
  projectId: string;
  sourceRoot: string;
  targetRoot: string;
  annotationsRoot: string;
}

export interface ArtifactMirrorConfig {
  schemaVersion: 1;
  sshHost?: string;
  backupRoot: string;
  stateRoot: string;
  catalogTool?: string;
  projects: ArtifactMirrorProjectConfig[];
}

interface FileRecord {
  bytes: number;
  sha256: string;
}
type Manifest = Record<string, FileRecord>;

interface MirrorState {
  schemaVersion: 1;
  projectId: string;
  sourceManifest: Manifest;
  seenManifest?: Manifest;
  syncedAt: string;
}

export interface MirrorResult {
  projectId: string;
  applied: boolean;
  sourceFiles: number;
  targetFilesBefore: number;
  added: string[];
  replaced: string[];
  deleted: string[];
  recoveredAnnotations: string[];
  backupPath?: string;
  sourceDigest: string;
}

export async function run(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage());
    return;
  }
  if (command !== 'status' && command !== 'sync' && command !== 'publish') {
    throw new Error(`metabot artifacts: unknown subcommand '${command}'`);
  }
  const flags = parseFlags(argv.slice(1));
  const config = loadArtifactMirrorConfig(requiredFlag(flags, 'config'));
  if (command === 'publish') {
    if (flags.apply !== true) throw new Error('metabot artifacts publish requires --apply');
    const projectId = requiredFlag(flags, 'project');
    const project = config.projects.find((candidate) => candidate.projectId === projectId);
    if (!project) throw new Error('metabot artifacts: requested project is not configured');
    const published = publishAnnotation(
      config,
      project,
      requiredFlag(flags, 'file'),
      typeof flags.name === 'string' ? flags.name : path.basename(requiredFlag(flags, 'file')),
    );
    if (flags.json === true) process.stdout.write(JSON.stringify({ ok: true, published }, null, 2) + '\n');
    else process.stdout.write(`${projectId}: published ${published.fileName} (${published.sha256})\n`);
    return;
  }
  const apply = command === 'sync' && flags.apply === true;
  const selected =
    typeof flags.project === 'string'
      ? config.projects.filter((project) => project.projectId === flags.project)
      : config.projects;
  if (selected.length === 0) throw new Error('metabot artifacts: requested project is not configured');
  const results = selected.map((project) => mirrorProject(config, project, apply));
  if (flags.json === true) process.stdout.write(JSON.stringify({ ok: true, apply, results }, null, 2) + '\n');
  else
    for (const result of results) {
      process.stdout.write(
        `${result.projectId}: ${result.applied ? 'synced' : 'dry-run'}; source=${result.sourceFiles} ` +
          `add=${result.added.length} replace=${result.replaced.length} delete=${result.deleted.length} ` +
          `recover=${result.recoveredAnnotations.length}\n`,
      );
    }
}

export function publishAnnotation(
  config: ArtifactMirrorConfig,
  project: ArtifactMirrorProjectConfig,
  inputPath: string,
  fileName: string,
): { projectId: string; fileName: string; sha256: string; reused: boolean } {
  if (!CANONICAL_FILENAME.test(fileName) || path.basename(fileName) !== fileName) {
    throw new Error('published annotation must use a canonical artifact filename');
  }
  const annotations = fs.realpathSync(project.annotationsRoot);
  const input = fs.realpathSync(path.resolve(inputPath));
  if (input !== annotations && !input.startsWith(annotations + path.sep)) {
    throw new Error('published annotation must be inside the configured annotations root');
  }
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error('published annotation must be a non-empty regular file');
  }
  const expectedHash = sha256(input);
  let reused = false;
  if (!config.sshHost) {
    fs.mkdirSync(project.sourceRoot, { recursive: true });
    const destination = path.join(project.sourceRoot, fileName);
    if (fs.existsSync(destination)) {
      if (sha256(destination) !== expectedHash)
        throw new Error('authoritative deliverable name already has different bytes');
      reused = true;
    } else atomicCopy(input, destination);
  } else {
    const result = spawnSync(
      'rsync',
      [
        '-a',
        '--checksum',
        '--ignore-existing',
        '--itemize-changes',
        input,
        `${config.sshHost}:${project.sourceRoot}/${fileName}`,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`annotation publication failed: ${safeProcessError(result.stderr)}`);
    const fetched = fetchSource(config, project);
    try {
      const remote = manifestFor(fetched.root)[fileName];
      if (!remote || remote.sha256 !== expectedHash) {
        throw new Error('authoritative deliverable name already has different bytes');
      }
      reused = result.stdout.trim().length === 0;
    } finally {
      fetched.cleanup();
    }
  }
  return { projectId: project.projectId, fileName, sha256: expectedHash, reused };
}

export function loadArtifactMirrorConfig(filePath: string): ArtifactMirrorConfig {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as ArtifactMirrorConfig;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new Error('artifact mirror config must use schemaVersion 1 and contain projects');
  }
  if (raw.sshHost && !SAFE_HOST.test(raw.sshHost)) throw new Error('artifact mirror sshHost is invalid');
  const seen = new Set<string>();
  const projects = raw.projects.map((project) => {
    if (!SAFE_PROJECT.test(project.projectId) || seen.has(project.projectId)) {
      throw new Error('artifact mirror project IDs must be valid and unique');
    }
    seen.add(project.projectId);
    const normalized = {
      projectId: project.projectId,
      sourceRoot: absolutePath(project.sourceRoot, 'sourceRoot'),
      targetRoot: absolutePath(project.targetRoot, 'targetRoot'),
      annotationsRoot: absolutePath(project.annotationsRoot, 'annotationsRoot'),
    };
    if (
      path.basename(normalized.sourceRoot) !== 'deliverables' ||
      path.basename(normalized.targetRoot) !== 'deliverables'
    ) {
      throw new Error('artifact mirror sourceRoot and targetRoot must name deliverables directories');
    }
    if (raw.sshHost && !SAFE_REMOTE_PATH.test(normalized.sourceRoot)) {
      throw new Error('artifact mirror remote sourceRoot contains unsupported characters');
    }
    const targetProject = path.dirname(normalized.targetRoot);
    if (normalized.annotationsRoot !== path.join(targetProject, 'annotations')) {
      throw new Error('artifact mirror annotationsRoot must be the target project annotations directory');
    }
    return normalized;
  });
  const backupRoot = absolutePath(raw.backupRoot, 'backupRoot');
  const stateRoot = absolutePath(raw.stateRoot, 'stateRoot');
  for (const project of projects) {
    const targetProject = path.dirname(project.targetRoot);
    for (const [label, root] of [
      ['backupRoot', backupRoot],
      ['stateRoot', stateRoot],
    ] as const) {
      if (root === targetProject || root.startsWith(targetProject + path.sep)) {
        throw new Error(`artifact mirror ${label} must stay outside the synchronized project`);
      }
    }
  }
  return {
    schemaVersion: 1,
    ...(raw.sshHost ? { sshHost: raw.sshHost } : {}),
    backupRoot,
    stateRoot,
    ...(raw.catalogTool ? { catalogTool: absolutePath(raw.catalogTool, 'catalogTool') } : {}),
    projects,
  };
}

export function mirrorProject(
  config: ArtifactMirrorConfig,
  project: ArtifactMirrorProjectConfig,
  apply: boolean,
): MirrorResult {
  const fetched = fetchSource(config, project);
  try {
    const sourceManifest = manifestFor(fetched.root);
    const targetManifest = fs.existsSync(project.targetRoot) ? manifestFor(project.targetRoot) : {};
    const statePath = path.join(config.stateRoot, `${project.projectId}.json`);
    const previous = readState(statePath, project.projectId);
    assertSourceImmutable(previous?.seenManifest ?? previous?.sourceManifest, sourceManifest);

    const added = Object.keys(sourceManifest)
      .filter((name) => !targetManifest[name])
      .sort();
    const replaced = Object.keys(sourceManifest)
      .filter((name) => targetManifest[name] && targetManifest[name].sha256 !== sourceManifest[name].sha256)
      .sort();
    const deleted = Object.keys(targetManifest)
      .filter((name) => !sourceManifest[name])
      .sort();
    const recovered = [...replaced, ...deleted]
      .filter((name) => {
        const previousHash = previous?.sourceManifest[name]?.sha256;
        const localHash = targetManifest[name]?.sha256;
        return !previousHash || (localHash !== undefined && localHash !== previousHash);
      })
      .sort();
    const result: MirrorResult = {
      projectId: project.projectId,
      applied: apply,
      sourceFiles: Object.keys(sourceManifest).length,
      targetFilesBefore: Object.keys(targetManifest).length,
      added,
      replaced,
      deleted,
      recoveredAnnotations: recovered,
      sourceDigest: manifestDigest(sourceManifest),
    };
    if (!apply || (added.length === 0 && replaced.length === 0 && deleted.length === 0)) {
      if (apply) writeState(statePath, project.projectId, sourceManifest, previous?.seenManifest);
      return result;
    }

    const runId = new Date().toISOString().replace(/[-:.]/gu, '') + '-' + crypto.randomBytes(4).toString('hex');
    const backupPath = path.join(config.backupRoot, project.projectId, runId);
    result.backupPath = backupPath;
    snapshotBefore(project, backupPath);
    try {
      fs.mkdirSync(project.targetRoot, { recursive: true });
      if (recovered.length > 0) recoverLocalEdits(project, recovered, runId);
      for (const name of deleted) fs.unlinkSync(path.join(project.targetRoot, name));
      for (const name of [...added, ...replaced])
        atomicCopy(path.join(fetched.root, name), path.join(project.targetRoot, name));
      updateCatalog(config, project, added, deleted);
      if (manifestDigest(manifestFor(project.targetRoot)) !== manifestDigest(sourceManifest)) {
        throw new Error('artifact mirror post-sync manifest mismatch');
      }
      writeState(statePath, project.projectId, sourceManifest, previous?.seenManifest);
      return result;
    } catch (error) {
      restoreSnapshot(project, backupPath);
      throw error;
    }
  } finally {
    fetched.cleanup();
  }
}

function fetchSource(
  config: ArtifactMirrorConfig,
  project: ArtifactMirrorProjectConfig,
): { root: string; cleanup: () => void } {
  if (!config.sshHost) return { root: project.sourceRoot, cleanup: () => {} };
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `metabot-artifact-${project.projectId}-`));
  const result = spawnSync(
    'rsync',
    [
      '-a',
      '--delete',
      '--checksum',
      '--exclude',
      'README.md',
      '--exclude',
      'INDEX.md',
      `${config.sshHost}:${project.sourceRoot}/`,
      `${stage}/`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`artifact source fetch failed for ${project.projectId}: ${safeProcessError(result.stderr)}`);
  }
  return { root: stage, cleanup: () => fs.rmSync(stage, { recursive: true, force: true }) };
}

function manifestFor(root: string): Manifest {
  if (!fs.existsSync(root)) throw new Error(`artifact directory does not exist: ${root}`);
  const manifest: Manifest = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SUPPORT_FILES.has(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name.startsWith('.')) {
      throw new Error(`artifact directory must be flat regular files: ${entry.name}`);
    }
    const filePath = path.join(root, entry.name);
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) throw new Error(`artifact file is empty: ${entry.name}`);
    manifest[entry.name] = { bytes: stat.size, sha256: sha256(filePath) };
  }
  return manifest;
}

function assertSourceImmutable(previous: Manifest | undefined, current: Manifest): void {
  if (!previous) return;
  for (const [name, old] of Object.entries(previous)) {
    const next = current[name];
    if (next && next.sha256 !== old.sha256) {
      throw new Error(`authoritative deliverable changed in place: ${name}; publish a new version instead`);
    }
  }
}

function snapshotBefore(project: ArtifactMirrorProjectConfig, backupPath: string): void {
  const payload = path.join(backupPath, 'deliverables-before');
  fs.mkdirSync(payload, { recursive: true });
  if (fs.existsSync(project.targetRoot)) {
    for (const entry of fs.readdirSync(project.targetRoot, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(project.targetRoot, entry.name), path.join(payload, entry.name));
    }
  }
  const catalog = path.join(path.dirname(project.targetRoot), '.metabot', 'catalog');
  if (fs.existsSync(catalog)) fs.cpSync(catalog, path.join(backupPath, 'catalog-before'), { recursive: true });
}

function restoreSnapshot(project: ArtifactMirrorProjectConfig, backupPath: string): void {
  fs.mkdirSync(project.targetRoot, { recursive: true });
  for (const entry of fs.readdirSync(project.targetRoot, { withFileTypes: true })) {
    if (entry.isFile()) fs.unlinkSync(path.join(project.targetRoot, entry.name));
  }
  const payload = path.join(backupPath, 'deliverables-before');
  if (fs.existsSync(payload))
    for (const entry of fs.readdirSync(payload, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(payload, entry.name), path.join(project.targetRoot, entry.name));
    }
  const catalog = path.join(path.dirname(project.targetRoot), '.metabot', 'catalog');
  const catalogBefore = path.join(backupPath, 'catalog-before');
  fs.rmSync(catalog, { recursive: true, force: true });
  if (fs.existsSync(catalogBefore)) fs.cpSync(catalogBefore, catalog, { recursive: true });
}

function recoverLocalEdits(project: ArtifactMirrorProjectConfig, names: string[], runId: string): void {
  const destination = path.join(project.annotationsRoot, 'recovered', runId);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of names) {
    const source = path.join(project.targetRoot, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, name));
  }
}

function updateCatalog(
  config: ArtifactMirrorConfig,
  project: ArtifactMirrorProjectConfig,
  added: string[],
  deleted: string[],
): void {
  if (!config.catalogTool) return;
  const projectRoot = path.dirname(project.targetRoot);
  for (const name of added) {
    if (catalogCovers(projectRoot, name)) continue;
    runCatalog(config.catalogTool, ['--project', projectRoot, 'record', '--file', `deliverables/${name}`, '--write']);
    annotateCatalogSource(projectRoot, name);
  }
  if (deleted.length > 0) markCatalogFilesMissing(projectRoot, deleted);
  runCatalog(config.catalogTool, ['--project', projectRoot, 'index', '--write']);
  runCatalog(config.catalogTool, ['--project', projectRoot, 'verify']);
  runCatalog(config.catalogTool, ['--project', projectRoot, 'validate']);
}

function annotateCatalogSource(projectRoot: string, name: string): void {
  const catalog = path.join(projectRoot, '.metabot', 'catalog', 'artifacts');
  const wanted = `deliverables/${name}`;
  for (const entry of fs.readdirSync(catalog).filter((candidate) => candidate.endsWith('.json'))) {
    const filePath = path.join(catalog, entry);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown> & {
      files?: Array<{ path?: string }>;
    };
    if (!record.files?.some((file) => file.path === wanted)) continue;
    record.source = { host: 'savio', path: wanted, mutable: false };
    record.notes = [typeof record.notes === 'string' ? record.notes : '', 'Strict mirror of the Savio authority.']
      .filter(Boolean)
      .join(' ');
    atomicWriteJson(filePath, record);
    return;
  }
  throw new Error(`new mirrored artifact record was not found for ${name}`);
}

function catalogCovers(projectRoot: string, name: string): boolean {
  const catalog = path.join(projectRoot, '.metabot', 'catalog', 'artifacts');
  if (!fs.existsSync(catalog)) return false;
  const wanted = `deliverables/${name}`;
  return fs
    .readdirSync(catalog)
    .filter((entry) => entry.endsWith('.json'))
    .some((entry) => {
      const record = JSON.parse(fs.readFileSync(path.join(catalog, entry), 'utf8')) as {
        files?: Array<{ path?: string }>;
      };
      return record.files?.some((file) => file.path === wanted) === true;
    });
}

function markCatalogFilesMissing(projectRoot: string, names: string[]): void {
  const catalog = path.join(projectRoot, '.metabot', 'catalog', 'artifacts');
  if (!fs.existsSync(catalog)) return;
  const removed = new Set(names.map((name) => `deliverables/${name}`));
  for (const entry of fs.readdirSync(catalog).filter((name) => name.endsWith('.json'))) {
    const filePath = path.join(catalog, entry);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown> & {
      files?: Array<{ path?: string }>;
    };
    const before = record.files ?? [];
    const files = before.filter((file) => !removed.has(file.path ?? ''));
    if (files.length === before.length) continue;
    record.files = files;
    if (files.length === 0) {
      record.availability = 'missing';
      record.classification = 'missing-local-copy';
      record.notes = [
        typeof record.notes === 'string' ? record.notes : '',
        'Removed from the Savio authoritative deliverables mirror.',
      ]
        .filter(Boolean)
        .join(' ');
    }
    atomicWriteJson(filePath, record);
  }
}

function runCatalog(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`artifact catalog failed: ${safeProcessError(result.stdout || result.stderr)}`);
}

function readState(filePath: string, projectId: string): MirrorState | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MirrorState;
  if (parsed.schemaVersion !== 1 || parsed.projectId !== projectId || !parsed.sourceManifest) {
    throw new Error(`invalid artifact mirror state for ${projectId}`);
  }
  return parsed;
}

function writeState(filePath: string, projectId: string, manifest: Manifest, priorSeen?: Manifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteJson(filePath, {
    schemaVersion: 1,
    projectId,
    sourceManifest: manifest,
    seenManifest: { ...(priorSeen ?? {}), ...manifest },
    syncedAt: new Date().toISOString(),
  });
}

function atomicCopy(source: string, destination: string): void {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.mirror-tmp`);
  fs.copyFileSync(source, temporary);
  const fd = fs.openSync(temporary, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, destination);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function manifestDigest(manifest: Manifest): string {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function absolutePath(value: string, field: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value))
    throw new Error(`artifact mirror ${field} must be absolute`);
  return path.normalize(value);
}

function safeProcessError(value: string): string {
  return value
    .replace(/(authorization|token|secret|password|cookie)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .trim()
    .slice(0, 800);
}

function parseFlags(args: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`metabot artifacts: unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (name === 'apply' || name === 'json') flags[name] = true;
    else {
      const value = args[++i];
      if (!value) throw new Error(`metabot artifacts: --${name} requires a value`);
      flags[name] = value;
    }
  }
  return flags;
}

function requiredFlag(flags: Record<string, string | true>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string') throw new Error(`metabot artifacts: --${name} is required`);
  return value;
}

function usage(): string {
  return (
    `metabot artifacts — strict Savio deliverables mirror\n\n` +
    `Usage:\n` +
    `  metabot artifacts status --config <file> [--project <id>] [--json]\n` +
    `  metabot artifacts sync --config <file> --apply [--project <id>] [--json]\n\n` +
    `  metabot artifacts publish --config <file> --project <id> --file <annotation> --name <canonical> --apply\n\n` +
    `status is read-only. sync requires --apply and preserves rollback bytes outside Workspaces.\n`
  );
}
