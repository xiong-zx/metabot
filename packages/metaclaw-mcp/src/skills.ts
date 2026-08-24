import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { MetaClawError } from './errors.js';
import {
  createLocalReadBudget,
  LocalReadBudget,
  LocalReadLimitError,
  type LocalReadTruncation,
} from './local-read.js';

export const SKILL_FILE_NAME = 'SKILL.md';
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type SkillQuarantineReason =
  | 'symlink'
  | 'not_a_directory'
  | 'missing_skill_file'
  | 'skill_file_not_regular'
  | 'skill_file_symlink'
  | 'oversize'
  | 'half_written'
  | 'unsafe_name'
  | 'escapes_root'
  | 'unreadable'
  | 'changed_during_read';

export interface SkillProvenance {
  readonly name: string;
  readonly writer: 'arc';
  readonly sha256: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
  readonly relativePath: string;
}

export interface SkillListEntry {
  readonly name: string;
  readonly state: 'active' | 'quarantined';
  readonly reason: SkillQuarantineReason | null;
  readonly provenance: SkillProvenance | null;
}

export interface SkillListing {
  readonly entries: readonly SkillListEntry[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly truncation: LocalReadTruncation | null;
  /** Exact only after a complete root scan; `null` is intentionally not a guess. */
  readonly totalEntries: number | null;
  readonly returnedEntryCount: number;
  /** Root entries observed before a bound stopped the scan. */
  readonly observedRootEntryCount: number;
  /** All directory entries charged to the shared local-read budget. */
  readonly observedEntryCount: number;
  readonly bytesRead: number;
}

export interface SkillDocument {
  readonly provenance: SkillProvenance;
  readonly content: string;
  readonly bytesRead: number;
}

export interface SkillsRootOptions {
  readonly root: string;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly deadlineMs: number;
  readonly maxReadEntries?: number;
  readonly now?: () => number;
  readonly budget?: LocalReadBudget;
}

export function isSafeSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

export async function listSkills(options: SkillsRootOptions): Promise<SkillListing> {
  const budget = options.budget ?? createLocalReadBudget({
    maxEntries: options.maxReadEntries ?? Math.max(options.maxEntries * 4 + 1, options.maxEntries + 1),
    maxBytes: options.maxTotalBytes,
    deadlineMs: options.deadlineMs,
    ...(options.now ? { now: options.now } : {}),
  });
  const startedEntries = budget.entries;
  const startedBytes = budget.bytes;
  const names: string[] = [];
  let observedRootEntryCount = 0;
  let truncation: LocalReadTruncation | null = null;
  let root: string;
  try {
    root = await canonicalSkillsRoot(options.root, budget);
  } catch (error) {
    if (error instanceof LocalReadLimitError) {
      return incompleteListing(error, budget, startedEntries, startedBytes);
    }
    throw error;
  }
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await budget.race(opendir(root));
  } catch (error) {
    if (error instanceof LocalReadLimitError) {
      return incompleteListing(error, budget, startedEntries, startedBytes);
    }
    throw skillError('unreadable');
  }
  try {
    for (;;) {
      const entry = await budget.race(directory.read());
      if (entry === null) break;
      try {
        budget.consumeEntry();
        budget.consumeBytes(Buffer.byteLength(entry.name, 'utf8'));
        observedRootEntryCount += 1;
      } catch (error) {
        if (error instanceof LocalReadLimitError) {
          truncation = error.toTruncation();
          break;
        }
        throw error;
      }
      if (names.length >= options.maxEntries) {
        truncation = { reason: 'entry_limit', limit: options.maxEntries };
        break;
      }
      names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof LocalReadLimitError) truncation = error.toTruncation();
    else throw skillError('unreadable');
  } finally {
    await directory.close().catch(() => undefined);
  }

  const entries: SkillListEntry[] = [];
  for (const name of names.sort()) {
      if (!isSafeSkillName(name)) {
        // A raw directory name can contain terminal controls or other display
        // payloads. Preserve stable distinctness without reflecting those bytes
        // into MCP output.
        entries.push({ name: sanitizedUnsafeName(name), state: 'quarantined', reason: 'unsafe_name', provenance: null });
        continue;
      }
      try {
        entries.push({
          name,
          state: 'active',
          reason: null,
          provenance: (await readSkillDocument(root, name, options.maxFileBytes, budget, false)).provenance,
        });
      } catch (error) {
        if (error instanceof LocalReadLimitError) {
          truncation = error.toTruncation();
          break;
        }
        entries.push({ name, state: 'quarantined', reason: quarantineReasonOf(error), provenance: null });
      }
  }

  const complete = truncation === null;
  return {
    entries,
    complete,
    truncated: !complete,
    truncation,
    totalEntries: complete ? observedRootEntryCount : null,
    returnedEntryCount: entries.length,
    observedRootEntryCount,
    observedEntryCount: budget.entries - startedEntries,
    bytesRead: budget.bytes - startedBytes,
  };
}

export async function getSkill(options: SkillsRootOptions, name: string): Promise<SkillDocument> {
  if (!isSafeSkillName(name)) {
    throw new MetaClawError('Skill name is not a safe contained identifier', 'skill_unsafe', {
      reason: 'unsafe_name' satisfies SkillQuarantineReason,
      name,
    });
  }
  const budget = options.budget ?? createLocalReadBudget({
    maxEntries: options.maxReadEntries ?? Math.max(options.maxEntries * 4 + 1, options.maxEntries + 1),
    maxBytes: options.maxTotalBytes,
    deadlineMs: options.deadlineMs,
    ...(options.now ? { now: options.now } : {}),
  });
  const startedBytes = budget.bytes;
  try {
    const root = await canonicalSkillsRoot(options.root, budget);
    const document = await readSkillDocument(root, name, options.maxFileBytes, budget, true);
    return { ...document, bytesRead: budget.bytes - startedBytes };
  } catch (error) {
    if (error instanceof LocalReadLimitError) {
      throw new MetaClawError('Skill read exceeded its local read budget', 'skill_unsafe', {
        reason: error.reason,
        limit: error.limit,
      });
    }
    throw error;
  }
}

async function canonicalSkillsRoot(root: string, budget: LocalReadBudget): Promise<string> {
  if (!path.isAbsolute(root)) throw skillError('escapes_root', 'Shared skills root must be absolute');
  let canonical: string;
  try {
    canonical = await budget.race(realpath(root));
    const info = await budget.race(lstat(canonical));
    if (!info.isDirectory()) throw skillError('not_a_directory');
  } catch (error) {
    if (error instanceof LocalReadLimitError || error instanceof MetaClawError) throw error;
    throw skillError('unreadable', 'Shared skills root is missing or unreadable');
  }
  return canonical;
}

async function readSkillDocument(
  root: string,
  name: string,
  maxFileBytes: number,
  budget: LocalReadBudget,
  includeContent: boolean,
): Promise<{ provenance: SkillProvenance; content: string }> {
  const directoryPath = path.join(root, name);
  const directoryInfo = await statOrFail(directoryPath, 'missing_skill_file', budget);
  if (directoryInfo.isSymbolicLink()) throw quarantine('symlink');
  if (!directoryInfo.isDirectory()) throw quarantine('not_a_directory');
  const canonicalDirectory = await realpathOrFail(directoryPath, budget);
  if (!isWithin(root, canonicalDirectory)) throw quarantine('escapes_root');
  await assertNoInFlightWrite(canonicalDirectory, budget);

  const filePath = path.join(canonicalDirectory, SKILL_FILE_NAME);
  const before = await statOrFail(filePath, 'missing_skill_file', budget);
  if (before.isSymbolicLink()) throw quarantine('skill_file_symlink');
  if (!before.isFile()) throw quarantine('skill_file_not_regular');
  if (before.size > maxFileBytes) throw quarantine('oversize');

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = await budget.race(open(filePath, constants.O_RDONLY | noFollow));
    const opened = await budget.race(descriptor.stat());
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
    ) throw quarantine('changed_during_read');
    if (opened.size > maxFileBytes) throw quarantine('oversize');
    budget.consumeBytes(opened.size);

    // Listing hashes incrementally and retains at most one 64 KiB chunk. A
    // caller asking for the document itself gets the bounded full buffer.
    const content = includeContent ? Buffer.allocUnsafe(opened.size) : undefined;
    const chunk = content ?? Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, opened.size)));
    const hash = createHash('sha256');
    let position = 0;
    while (position < opened.size) {
      budget.checkpoint();
      const offset = content === undefined ? 0 : position;
      const length = Math.min(chunk.length - offset, opened.size - position);
      const result = await budget.race(descriptor.read(chunk, offset, length, position));
      if (result.bytesRead === 0) break;
      hash.update(chunk.subarray(offset, offset + result.bytesRead));
      position += result.bytesRead;
    }
    if (position !== opened.size) throw quarantine('changed_during_read');
    const after = await budget.race(descriptor.stat());
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino) {
      throw quarantine('changed_during_read');
    }
    return {
      provenance: {
        name,
        writer: 'arc',
        sha256: hash.digest('hex'),
        bytes: opened.size,
        modifiedAtMs: after.mtimeMs,
        relativePath: path.join(name, SKILL_FILE_NAME),
      },
      content: content?.toString('utf8') ?? '',
    };
  } catch (error) {
    if (error instanceof MetaClawError || error instanceof LocalReadLimitError) throw error;
    throw quarantine('unreadable');
  } finally {
    await descriptor?.close().catch(() => undefined);
  }
}

async function assertNoInFlightWrite(directory: string, budget: LocalReadBudget): Promise<void> {
  const handle = await budget.race(opendir(directory));
  let hasSkill = false;
  try {
    for (;;) {
      const entry = await budget.race(handle.read());
      if (entry === null) break;
      budget.consumeEntry();
      budget.consumeBytes(Buffer.byteLength(entry.name, 'utf8'));
      if (entry.name === SKILL_FILE_NAME) hasSkill = true;
      if (entry.name.endsWith('.tmp') || entry.name.endsWith('.partial') || entry.name.startsWith('.tmp')) {
        throw quarantine('half_written');
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!hasSkill) throw quarantine('missing_skill_file');
}

async function statOrFail(target: string, reason: SkillQuarantineReason, budget: LocalReadBudget) {
  try {
    return await budget.race(lstat(target));
  } catch (error) {
    if (error instanceof LocalReadLimitError) throw error;
    throw quarantine(reason);
  }
}

async function realpathOrFail(target: string, budget: LocalReadBudget): Promise<string> {
  try {
    return await budget.race(realpath(target));
  } catch (error) {
    if (error instanceof LocalReadLimitError) throw error;
    throw quarantine('unreadable');
  }
}

function skillError(reason: SkillQuarantineReason, message = 'Shared skills root is unreadable'): MetaClawError {
  return new MetaClawError(message, 'skill_unsafe', { reason });
}

function quarantine(reason: SkillQuarantineReason): MetaClawError {
  return new MetaClawError(
    `Skill entry refused: ${reason}`,
    reason === 'missing_skill_file' ? 'skill_not_found' : 'skill_unsafe',
    { reason },
  );
}

function quarantineReasonOf(error: unknown): SkillQuarantineReason {
  if (error instanceof MetaClawError && typeof error.details?.reason === 'string') {
    return error.details.reason as SkillQuarantineReason;
  }
  return 'unreadable';
}

function incompleteListing(
  error: LocalReadLimitError,
  budget: LocalReadBudget,
  startedEntries: number,
  startedBytes: number,
): SkillListing {
  return {
    entries: [],
    complete: false,
    truncated: true,
    truncation: error.toTruncation(),
    totalEntries: null,
    returnedEntryCount: 0,
    observedRootEntryCount: 0,
    observedEntryCount: budget.entries - startedEntries,
    bytesRead: budget.bytes - startedBytes,
  };
}

function sanitizedUnsafeName(name: string): string {
  return `unsafe-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
