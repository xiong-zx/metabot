import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { ArcOutput } from './contract.js';
import { validateArcOutput } from './contract.js';
import { ArcError } from './errors.js';

export interface ReadArcOutputOptions {
  projectId: string;
  projectRoot: string;
  runId: string;
}

export interface WaitForArcOutputOptions extends ReadArcOutputOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface ArcArtifactStoreOptions {
  maxArtifactBytes?: number;
}

const DEFAULT_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function externalUri(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export class ArcArtifactStore {
  readonly maxArtifactBytes: number;

  constructor(options: ArcArtifactStoreOptions = {}) {
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }

  canonicalProjectRoot(projectRoot: string): string {
    let canonical: string;
    try {
      canonical = realpathSync.native(projectRoot);
    } catch (error) {
      throw new ArcError('project_root_invalid', 'Project root does not exist', {
        cause: error,
        details: { projectRoot },
      });
    }
    if (!statSync(canonical).isDirectory()) {
      throw new ArcError('project_root_invalid', 'Project root must be a directory', {
        details: { projectRoot },
      });
    }
    return canonical;
  }

  outputRelativePath(runId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) {
      throw new ArcError('invalid_contract', 'run_id is not safe for an artifact path');
    }
    return path.posix.join('.metabot-arc', 'runs', runId, 'output.json');
  }

  resolveLocalPath(
    projectRoot: string,
    uriOrPath: string,
    options: { mustExist?: boolean; rejectSymlinks?: boolean } = {},
  ): string {
    const root = this.canonicalProjectRoot(projectRoot);
    if (externalUri(uriOrPath)) {
      throw new ArcError('invalid_contract', 'External URI does not identify a local artifact path');
    }

    let localPath = uriOrPath;
    if (uriOrPath.startsWith('file:')) {
      try {
        localPath = fileURLToPath(uriOrPath);
      } catch (error) {
        throw new ArcError('invalid_contract', 'Invalid file artifact URI', { cause: error });
      }
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uriOrPath)) {
      throw new ArcError('invalid_contract', 'Only local paths, file URIs, and HTTP(S) evidence are supported');
    }

    const candidate = path.resolve(root, localPath);
    if (!isInside(root, candidate)) {
      throw new ArcError('path_outside_project', 'Artifact path escapes the project root', {
        details: { projectRoot: root, path: uriOrPath },
      });
    }

    const relative = path.relative(root, candidate);
    let cursor = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (!existsSync(cursor)) break;
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() && options.rejectSymlinks !== false) {
        throw new ArcError('symlink_not_allowed', 'Artifact path contains a symbolic link', {
          details: { path: cursor },
        });
      }
      const canonical = realpathSync.native(cursor);
      if (!isInside(root, canonical)) {
        throw new ArcError('path_outside_project', 'Artifact path resolves outside the project root', {
          details: { projectRoot: root, path: uriOrPath },
        });
      }
    }

    if (options.mustExist && !existsSync(candidate)) {
      throw new ArcError('artifact_missing', 'Referenced local artifact does not exist', {
        details: { path: uriOrPath },
      });
    }
    if (options.mustExist && !statSync(candidate).isFile()) {
      throw new ArcError('artifact_invalid', 'Referenced local artifact must be a file', {
        details: { path: uriOrPath },
      });
    }
    return candidate;
  }

  validateOutputReferences(output: ArcOutput, projectRoot: string): void {
    const uris = [
      ...output.artifacts.map((artifact) => artifact.uri),
      ...output.findings.flatMap((finding) => finding.evidence.map((evidence) => evidence.uri)),
      ...output.negative_results.flatMap((result) => (result.evidence ?? []).map((evidence) => evidence.uri)),
    ];
    for (const uri of uris) {
      if (externalUri(uri)) continue;
      this.resolveLocalPath(projectRoot, uri, { mustExist: true, rejectSymlinks: true });
    }
  }

  writeOutput(options: ReadArcOutputOptions, value: unknown): string {
    const root = this.canonicalProjectRoot(options.projectRoot);
    const output = validateArcOutput(value, {
      expectedProjectId: options.projectId,
      expectedRunId: options.runId,
    });
    this.validateOutputReferences(output, root);
    const relativePath = this.outputRelativePath(options.runId);
    const target = this.resolveLocalPath(root, relativePath, { rejectSymlinks: true });
    this.ensureSafeDirectory(root, path.dirname(target));

    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > this.maxArtifactBytes) {
      throw new ArcError('artifact_invalid', 'ARC output exceeds the configured size limit');
    }

    const temporary = path.join(path.dirname(target), `.output-${process.pid}-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.ensureSafeDirectory(root, path.dirname(target));
      renameSync(temporary, target);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error instanceof ArcError
        ? error
        : new ArcError('artifact_invalid', 'Could not atomically write ARC output', { cause: error });
    }
    return relativePath;
  }

  readOutput(options: ReadArcOutputOptions): ArcOutput {
    const relativePath = this.outputRelativePath(options.runId);
    const target = this.resolveLocalPath(options.projectRoot, relativePath, {
      mustExist: true,
      rejectSymlinks: true,
    });
    const info = statSync(target);
    if (info.size > this.maxArtifactBytes) {
      throw new ArcError('artifact_invalid', 'ARC output exceeds the configured size limit');
    }

    let value: unknown;
    try {
      value = JSON.parse(readFileSync(target, 'utf8'));
    } catch (error) {
      throw new ArcError('artifact_invalid', 'ARC output is not valid JSON', { cause: error });
    }
    const output = validateArcOutput(value, {
      expectedProjectId: options.projectId,
      expectedRunId: options.runId,
    });
    this.validateOutputReferences(output, options.projectRoot);
    return output;
  }

  async waitForOutput(options: WaitForArcOutputOptions): Promise<ArcOutput> {
    const timeoutMs = options.timeoutMs ?? 2_000;
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        return this.readOutput(options);
      } catch (error) {
        if (!(error instanceof ArcError) || error.code !== 'artifact_missing' || Date.now() >= deadline) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  private ensureSafeDirectory(projectRoot: string, directory: string): void {
    if (!isInside(projectRoot, directory)) {
      throw new ArcError('path_outside_project', 'Artifact directory escapes the project root');
    }
    const relative = path.relative(projectRoot, directory);
    let cursor = projectRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) {
        throw new ArcError('symlink_not_allowed', 'Artifact directory contains a symbolic link', {
          details: { path: cursor },
        });
      }
      if (!info.isDirectory()) {
        throw new ArcError('artifact_invalid', 'Artifact parent path must be a directory', {
          details: { path: cursor },
        });
      }
      if (!isInside(projectRoot, realpathSync.native(cursor))) {
        throw new ArcError('path_outside_project', 'Artifact directory resolves outside the project root');
      }
    }
  }
}
