import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

export interface ArtifactDeliveryProjectConfig {
  projectId: string;
  root: string;
  chatIds: string[];
}

export interface ArtifactDeliveryConfig {
  mode?: 'off' | 'enforce';
  projects: ArtifactDeliveryProjectConfig[];
}

export interface PreparedArtifactDelivery {
  filePath: string;
  persistentPath: string;
  projectId: string;
  sha256: string;
}

export class ArtifactDeliveryError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CONFIGURATION'
      | 'INVALID_FILENAME'
      | 'INVALID_SOURCE'
      | 'DESTINATION_CONFLICT'
      | 'ARCHIVE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactDeliveryError';
  }
}

const CANONICAL_FILENAME =
  /^[a-z0-9][a-z0-9-]*_[a-z0-9]+-[a-z0-9-]+_[a-z0-9][a-z0-9-]*(?:_[a-z]+-[a-z0-9-]+)*_[0-9]{8}_v[0-9]{2}\.[a-z0-9]+(?:\.[a-z0-9]+)?$/u;

export function normalizeArtifactDeliveryConfig(config: ArtifactDeliveryConfig): ArtifactDeliveryConfig {
  if (config.mode !== undefined && config.mode !== 'off' && config.mode !== 'enforce') {
    throw new ArtifactDeliveryError('INVALID_CONFIGURATION', 'artifactDelivery.mode must be off or enforce');
  }
  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    throw new ArtifactDeliveryError('INVALID_CONFIGURATION', 'artifactDelivery.projects must be non-empty');
  }
  const chats = new Set<string>();
  const projects = config.projects.map((project) => {
    if (!project.projectId || !/^[a-z0-9][a-z0-9-]*$/u.test(project.projectId)) {
      throw new ArtifactDeliveryError('INVALID_CONFIGURATION', 'artifactDelivery projectId is invalid');
    }
    const root = path.resolve(project.root);
    if (!path.isAbsolute(root)) {
      throw new ArtifactDeliveryError('INVALID_CONFIGURATION', 'artifactDelivery project root must be absolute');
    }
    if (!Array.isArray(project.chatIds) || project.chatIds.length === 0) {
      throw new ArtifactDeliveryError('INVALID_CONFIGURATION', 'artifactDelivery project chatIds must be non-empty');
    }
    for (const chatId of project.chatIds) {
      if (!chatId || chats.has(chatId)) {
        throw new ArtifactDeliveryError(
          'INVALID_CONFIGURATION',
          'artifactDelivery chat IDs must be non-empty and unique',
        );
      }
      chats.add(chatId);
    }
    return { projectId: project.projectId, root, chatIds: [...project.chatIds] };
  });
  return { mode: config.mode ?? 'off', projects };
}

export class ArtifactDeliveryPublisher {
  private readonly config: ArtifactDeliveryConfig;
  private readonly projectByChat = new Map<string, ArtifactDeliveryProjectConfig>();

  constructor(
    config: ArtifactDeliveryConfig,
    private readonly logger: Logger,
  ) {
    this.config = normalizeArtifactDeliveryConfig(config);
    for (const project of this.config.projects) {
      for (const chatId of project.chatIds) this.projectByChat.set(chatId, project);
    }
  }

  prepare(chatId: string, sourcePath: string, fileName: string): PreparedArtifactDelivery | undefined {
    if (this.config.mode !== 'enforce') return undefined;
    const project = this.projectByChat.get(chatId);
    if (!project) return undefined;
    if (path.basename(fileName) !== fileName || !CANONICAL_FILENAME.test(fileName)) {
      throw new ArtifactDeliveryError('INVALID_FILENAME', 'user-facing file must use the canonical artifact filename');
    }

    let sourceStat: fs.Stats;
    try {
      sourceStat = fs.lstatSync(sourcePath);
    } catch {
      throw new ArtifactDeliveryError('INVALID_SOURCE', 'output file is unavailable');
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size <= 0) {
      throw new ArtifactDeliveryError('INVALID_SOURCE', 'output file must be a non-empty regular file');
    }

    const deliverables = path.join(project.root, 'deliverables');
    fs.mkdirSync(deliverables, { recursive: true });
    const realProject = fs.realpathSync(project.root);
    const realDeliverables = fs.realpathSync(deliverables);
    if (realDeliverables !== realProject && !realDeliverables.startsWith(realProject + path.sep)) {
      throw new ArtifactDeliveryError('INVALID_CONFIGURATION', 'deliverables path escapes the configured project root');
    }
    const destination = path.join(realDeliverables, fileName);
    const sourceHash = hashFile(sourcePath);

    if (fs.existsSync(destination)) {
      const destinationStat = fs.lstatSync(destination);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        throw new ArtifactDeliveryError('DESTINATION_CONFLICT', 'deliverable destination is not a regular file');
      }
      if (hashFile(destination) !== sourceHash) {
        throw new ArtifactDeliveryError(
          'DESTINATION_CONFLICT',
          'canonical deliverable exists with different bytes; create a new version',
        );
      }
      return { filePath: destination, persistentPath: destination, projectId: project.projectId, sha256: sourceHash };
    }

    const temporary = path.join(
      realDeliverables,
      `.${fileName}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(temporary, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (hashFile(temporary) !== sourceHash) {
        throw new ArtifactDeliveryError('ARCHIVE_FAILED', 'archived bytes failed SHA-256 verification');
      }
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o644);
      this.logger.info(
        { projectId: project.projectId, chatId, fileName, sha256: sourceHash },
        'Archived user-facing output before delivery',
      );
      return { filePath: destination, persistentPath: destination, projectId: project.projectId, sha256: sourceHash };
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* best effort */
      }
      if (error instanceof ArtifactDeliveryError) throw error;
      throw new ArtifactDeliveryError('ARCHIVE_FAILED', 'failed to archive user-facing output');
    }
  }
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
