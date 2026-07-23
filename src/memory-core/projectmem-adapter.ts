import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryCoreError, validateMemoryEvent } from './event-ledger.js';
import type { MemoryActor, MemoryEvent, MemoryOutcome, MemoryScope } from './types.js';

export const PROJECTMEM_DIR = '.projectmem';
export const PROJECTMEM_EVENTS_FILE = 'events.jsonl';
export const PROJECTMEM_SUMMARY_FILE = 'summary.md';
export const PROJECTMEM_PROJECT_MAP_FILE = 'PROJECT_MAP.md';
export const PROJECTMEM_INSTRUCTIONS_FILE = 'AI_INSTRUCTIONS.md';
export const PROJECTMEM_MISSING_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export const PROJECTMEM_EVENT_TYPES = ['issue', 'hypothesis', 'attempt', 'fix', 'decision', 'note'] as const;

export type ProjectMemEventType = (typeof PROJECTMEM_EVENT_TYPES)[number];
export type ProjectMemOutcome = 'worked' | 'failed' | 'partial';
export type ProjectMemCaptureConfidence = 'high' | 'medium' | 'low';

export interface ProjectMemEvent {
  id?: string;
  timestamp?: string;
  type: ProjectMemEventType;
  issue_id?: string;
  summary: string;
  outcome?: ProjectMemOutcome;
  files?: string[];
  command?: string;
  notes?: string;
  git_commit?: string;
  location?: string;
  auto_captured?: boolean;
  capture_source?: string;
  capture_confidence?: ProjectMemCaptureConfidence;
  git_message?: string;
  supersedes?: string;
  source_line?: number;
  source_hash?: string;
  generated_id?: boolean;
  missing_timestamp?: boolean;
}

export interface ProjectMemAdapterOptions {
  projectMemDirName?: string;
  projectId?: string;
  domain?: string;
  actor?: MemoryActor;
  visibility?: MemoryScope['visibility'];
}

export interface ProjectMemPaths {
  dir: string;
  events: string;
  summary: string;
  projectMap: string;
  instructions: string;
}

export interface ProjectMemBriefing {
  summary?: string;
  projectMap?: string;
  instructions?: string;
}

export class ProjectMemAdapter {
  private readonly projectMemDirName: string;
  private readonly projectId: string;
  private readonly domain: string | undefined;
  private readonly actor: MemoryActor;
  private readonly visibility: MemoryScope['visibility'];

  constructor(
    private readonly rootDir: string,
    options: ProjectMemAdapterOptions = {},
  ) {
    this.projectMemDirName = options.projectMemDirName ?? PROJECTMEM_DIR;
    this.projectId = options.projectId ?? path.basename(rootDir);
    this.domain = options.domain;
    this.actor = options.actor ?? { kind: 'agent', id: 'projectmem' };
    this.visibility = options.visibility ?? 'project';
  }

  get paths(): ProjectMemPaths {
    const dir = path.join(this.rootDir, this.projectMemDirName);
    return {
      dir,
      events: path.join(dir, PROJECTMEM_EVENTS_FILE),
      summary: path.join(dir, PROJECTMEM_SUMMARY_FILE),
      projectMap: path.join(dir, PROJECTMEM_PROJECT_MAP_FILE),
      instructions: path.join(dir, PROJECTMEM_INSTRUCTIONS_FILE),
    };
  }

  isInitialized(): boolean {
    return fs.existsSync(this.paths.dir);
  }

  readEvents(): ProjectMemEvent[] {
    const eventsPath = this.paths.events;
    if (!fs.existsSync(eventsPath)) {
      return [];
    }

    return fs
      .readFileSync(eventsPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseProjectMemEventLine(line, index + 1));
  }

  importEvents(events: ProjectMemEvent[] = this.readEvents()): MemoryEvent[] {
    return events.map((event, index) =>
      projectMemEventToMemoryEvent(ensureNormalizedProjectMemEvent(event, index + 1, JSON.stringify(event)), {
        actor: this.actor,
        projectId: this.projectId,
        domain: this.domain,
        visibility: this.visibility,
      }),
    );
  }

  readBriefing(): ProjectMemBriefing {
    return {
      summary: readOptionalText(this.paths.summary),
      projectMap: readOptionalText(this.paths.projectMap),
      instructions: readOptionalText(this.paths.instructions),
    };
  }
}

export interface ProjectMemImportContext {
  actor: MemoryActor;
  projectId: string;
  domain?: string;
  visibility?: MemoryScope['visibility'];
}

export function projectMemEventToMemoryEvent(event: ProjectMemEvent, context: ProjectMemImportContext): MemoryEvent {
  const normalized = ensureNormalizedProjectMemEvent(event, event.source_line ?? 1, JSON.stringify(event));
  validateProjectMemEvent(normalized);

  const memoryEvent: MemoryEvent = {
    id: normalized.id ?? stableProjectMemFallbackId(normalized, 1, JSON.stringify(normalized)),
    type: normalized.type,
    summary: normalized.summary.trim(),
    body: normalized.notes,
    timestamp: normalizeProjectMemTimestamp(normalized.timestamp),
    actor: context.actor,
    scope: {
      project_id: context.projectId,
      domain: context.domain,
      visibility: context.visibility ?? 'project',
    },
    subject: {
      file_paths: normalized.files,
      command: normalized.command,
      commit: normalized.git_commit,
    },
    outcome: normalized.outcome,
    confidence: confidenceToNumber(normalized.capture_confidence),
    supersedes: normalized.supersedes,
    metadata: {
      projectmem_event_id: normalized.id,
      projectmem_issue_id: normalized.issue_id,
      projectmem_location: normalized.location,
      projectmem_auto_captured: normalized.auto_captured,
      projectmem_capture_source: normalized.capture_source,
      projectmem_capture_confidence: normalized.capture_confidence,
      projectmem_git_message: normalized.git_message,
      projectmem_source_line: normalized.source_line,
      projectmem_source_hash: normalized.source_hash,
      projectmem_generated_id: normalized.generated_id,
      projectmem_missing_timestamp: normalized.missing_timestamp,
    },
  };
  validateMemoryEvent(memoryEvent);
  return memoryEvent;
}

export function memoryEventToProjectMemEvent(event: MemoryEvent): ProjectMemEvent | undefined {
  if (!isProjectMemEventType(event.type)) {
    return undefined;
  }

  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    issue_id: stringMetadata(event, 'projectmem_issue_id'),
    summary: event.summary,
    outcome: toProjectMemOutcome(event.outcome),
    files: event.subject?.file_paths,
    command: event.subject?.command,
    notes: event.body,
    git_commit: event.subject?.commit,
    location: stringMetadata(event, 'projectmem_location'),
    auto_captured: booleanMetadata(event, 'projectmem_auto_captured'),
    capture_source: stringMetadata(event, 'projectmem_capture_source'),
    capture_confidence: toProjectMemCaptureConfidence(stringMetadata(event, 'projectmem_capture_confidence')),
    git_message: stringMetadata(event, 'projectmem_git_message'),
    supersedes: event.supersedes,
  };
}

function parseProjectMemEventLine(line: string, lineNumber: number): ProjectMemEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new MemoryCoreError(
      'invalid_projectmem_jsonl',
      `Invalid ProjectMem JSONL at line ${lineNumber}: ${String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new MemoryCoreError('invalid_projectmem_event', `ProjectMem event at line ${lineNumber} is not an object`);
  }

  const event = normalizeProjectMemEvent(parsed as unknown as ProjectMemEvent, lineNumber, line);
  validateProjectMemEvent(event);
  return event;
}

function validateProjectMemEvent(event: ProjectMemEvent): void {
  validateOptionalString(event.id, 'ProjectMem event id');
  validateOptionalString(event.timestamp, 'ProjectMem event timestamp');
  validateOptionalString(event.issue_id, 'ProjectMem event issue_id');
  validateOptionalString(event.command, 'ProjectMem event command');
  validateOptionalString(event.notes, 'ProjectMem event notes');
  validateOptionalString(event.git_commit, 'ProjectMem event git_commit');
  validateOptionalString(event.location, 'ProjectMem event location');
  validateOptionalString(event.capture_source, 'ProjectMem event capture_source');
  validateOptionalString(event.git_message, 'ProjectMem event git_message');
  validateOptionalString(event.supersedes, 'ProjectMem event supersedes');
  if (event.auto_captured !== undefined && typeof event.auto_captured !== 'boolean') {
    throw new MemoryCoreError('invalid_projectmem_auto_captured', 'ProjectMem event auto_captured must be a boolean');
  }

  if (!isProjectMemEventType(event.type)) {
    throw new MemoryCoreError('invalid_projectmem_type', `Unsupported ProjectMem event type: ${String(event.type)}`);
  }
  if (typeof event.summary !== 'string' || event.summary.trim().length === 0) {
    throw new MemoryCoreError('invalid_projectmem_summary', 'ProjectMem event summary must be a non-empty string');
  }
  if (
    event.outcome !== undefined &&
    event.outcome !== 'worked' &&
    event.outcome !== 'failed' &&
    event.outcome !== 'partial'
  ) {
    throw new MemoryCoreError('invalid_projectmem_outcome', `Unsupported ProjectMem outcome: ${event.outcome}`);
  }
  if (event.files !== undefined && !Array.isArray(event.files)) {
    throw new MemoryCoreError('invalid_projectmem_files', 'ProjectMem event files must be an array');
  }
  if (event.files !== undefined) {
    for (const [index, file] of event.files.entries()) {
      if (typeof file !== 'string' || file.trim().length === 0) {
        throw new MemoryCoreError(
          'invalid_projectmem_files',
          `ProjectMem event files[${index}] must be a non-empty string`,
        );
      }
    }
  }
  if (event.capture_confidence !== undefined && toProjectMemCaptureConfidence(event.capture_confidence) === undefined) {
    throw new MemoryCoreError(
      'invalid_projectmem_capture_confidence',
      `Unsupported ProjectMem capture confidence: ${event.capture_confidence}`,
    );
  }
  if (event.timestamp !== undefined) {
    normalizeProjectMemTimestamp(event.timestamp);
  }
}

function isProjectMemEventType(value: unknown): value is ProjectMemEventType {
  return typeof value === 'string' && (PROJECTMEM_EVENT_TYPES as readonly string[]).includes(value);
}

function toProjectMemOutcome(outcome: MemoryOutcome | undefined): ProjectMemOutcome | undefined {
  if (outcome === 'worked' || outcome === 'failed' || outcome === 'partial') {
    return outcome;
  }
  return undefined;
}

function confidenceToNumber(confidence: ProjectMemCaptureConfidence | undefined): number | undefined {
  switch (confidence) {
    case 'high':
      return 0.9;
    case 'medium':
      return 0.65;
    case 'low':
      return 0.35;
    case undefined:
      return undefined;
  }
}

function normalizeProjectMemEvent(event: ProjectMemEvent, lineNumber: number, rawLine: string): ProjectMemEvent {
  const sourceHash = createHash('sha256').update(rawLine).digest('hex').slice(0, 16);
  const id = normalizeOptionalProjectMemString(event.id, 'ProjectMem event id');
  const timestamp = normalizeOptionalProjectMemString(event.timestamp, 'ProjectMem event timestamp');
  const missingId = id === undefined;
  const missingTimestamp = timestamp === undefined;
  return {
    ...event,
    id: missingId ? stableProjectMemFallbackId(event, lineNumber, rawLine) : id,
    timestamp: missingTimestamp ? PROJECTMEM_MISSING_TIMESTAMP : normalizeProjectMemTimestamp(timestamp),
    source_line: lineNumber,
    source_hash: sourceHash,
    generated_id: missingId,
    missing_timestamp: missingTimestamp,
  };
}

function ensureNormalizedProjectMemEvent(event: ProjectMemEvent, lineNumber: number, rawLine: string): ProjectMemEvent {
  if (event.source_line !== undefined && event.source_hash !== undefined) {
    return event;
  }
  return normalizeProjectMemEvent(event, lineNumber, rawLine);
}

function normalizeOptionalProjectMemString(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new MemoryCoreError('invalid_projectmem_field', `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new MemoryCoreError('invalid_projectmem_field', `${field} must be a string`);
  }
}

function stableProjectMemFallbackId(event: ProjectMemEvent, lineNumber: number, rawLine: string): string {
  const hash = createHash('sha256').update(rawLine).digest('hex').slice(0, 16);
  return `projectmem:${lineNumber}:${event.type}:${hash}`;
}

function normalizeProjectMemTimestamp(timestamp: string | undefined): string {
  if (timestamp === undefined || timestamp.trim().length === 0) {
    return PROJECTMEM_MISSING_TIMESTAMP;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }

  const gitTimestamp = timestamp.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (gitTimestamp !== null) {
    const [, date, time, offsetHour, offsetMinute] = gitTimestamp;
    const gitParsed = Date.parse(`${date}T${time}${offsetHour}:${offsetMinute}`);
    if (!Number.isNaN(gitParsed)) {
      return new Date(gitParsed).toISOString();
    }
  }

  throw new MemoryCoreError('invalid_projectmem_timestamp', `Invalid ProjectMem timestamp: ${timestamp}`);
}

function toProjectMemCaptureConfidence(value: string | undefined): ProjectMemCaptureConfidence | undefined {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return undefined;
}

function stringMetadata(event: MemoryEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanMetadata(event: MemoryEvent, key: string): boolean | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalText(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
