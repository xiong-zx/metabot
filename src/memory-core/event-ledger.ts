import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MEMORY_EVENT_STATUSES,
  MEMORY_EVENT_TYPES,
  MEMORY_OUTCOMES,
  MEMORY_VISIBILITIES,
  type AppendMemoryEventInput,
  type MemoryActor,
  type MemoryEvent,
  type MemoryScope,
} from './types.js';

export const DEFAULT_MEMORY_DIR = '.metabot-memory';
export const DEFAULT_EVENTS_FILE = 'events.jsonl';

export class MemoryCoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryCoreError';
  }
}

export interface MemoryEventLedgerOptions {
  memoryDirName?: string;
  eventsFileName?: string;
}

export class MemoryEventLedger {
  private readonly memoryDirName: string;
  private readonly eventsFileName: string;

  constructor(
    private readonly rootDir: string,
    options: MemoryEventLedgerOptions = {},
  ) {
    this.memoryDirName = options.memoryDirName ?? DEFAULT_MEMORY_DIR;
    this.eventsFileName = options.eventsFileName ?? DEFAULT_EVENTS_FILE;
  }

  get memoryDir(): string {
    return path.join(this.rootDir, this.memoryDirName);
  }

  get eventsPath(): string {
    return path.join(this.memoryDir, this.eventsFileName);
  }

  initialize(): void {
    fs.mkdirSync(this.memoryDir, { recursive: true });
    if (!fs.existsSync(this.eventsPath)) {
      fs.writeFileSync(this.eventsPath, '');
    }
  }

  append(input: AppendMemoryEventInput): MemoryEvent {
    this.initialize();
    const event = normalizeMemoryEvent(input);
    validateMemoryEvent(event);

    if (this.readAll().some((existing) => existing.id === event.id)) {
      throw new MemoryCoreError('duplicate_event_id', `Memory event already exists: ${event.id}`);
    }

    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
    return event;
  }

  readAll(): MemoryEvent[] {
    if (!fs.existsSync(this.eventsPath)) {
      return [];
    }

    const content = fs.readFileSync(this.eventsPath, 'utf8');
    if (content.trim().length === 0) {
      return [];
    }

    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseEventLine(line, index + 1));
  }

  findById(id: string): MemoryEvent | undefined {
    return this.readAll().find((event) => event.id === id);
  }
}

export function normalizeMemoryEvent(input: AppendMemoryEventInput): MemoryEvent {
  return {
    ...input,
    id: normalizeOptionalString(input.id) ?? `mem_evt_${randomUUID()}`,
    summary: input.summary.trim(),
    body: normalizeOptionalString(input.body),
    timestamp: normalizeOptionalString(input.timestamp) ?? new Date().toISOString(),
    status: input.status ?? 'live',
  };
}

export function validateMemoryEvent(event: MemoryEvent): void {
  ensureNonEmptyString(event.id, 'id');
  ensureArrayIncludes(MEMORY_EVENT_TYPES, event.type, 'type');
  ensureNonEmptyString(event.summary, 'summary');
  ensureIsoTimestamp(event.timestamp, 'timestamp');
  validateActor(event.actor);
  validateScope(event.scope);

  if (event.status !== undefined) {
    ensureArrayIncludes(MEMORY_EVENT_STATUSES, event.status, 'status');
  }

  if (event.outcome !== undefined) {
    ensureArrayIncludes(MEMORY_OUTCOMES, event.outcome, 'outcome');
  }

  if (event.confidence !== undefined && (event.confidence < 0 || event.confidence > 1)) {
    throw new MemoryCoreError('invalid_confidence', 'confidence must be between 0 and 1');
  }

  if (event.evidence_event_ids !== undefined) {
    validateStringArray(event.evidence_event_ids, 'evidence_event_ids');
  }

  if (event.subject?.file_paths !== undefined) {
    validateStringArray(event.subject.file_paths, 'subject.file_paths');
  }

  if (event.subject?.artifact_ids !== undefined) {
    validateStringArray(event.subject.artifact_ids, 'subject.artifact_ids');
  }

  if (event.subject?.source_uris !== undefined) {
    validateStringArray(event.subject.source_uris, 'subject.source_uris');
  }
}

function parseEventLine(line: string, lineNumber: number): MemoryEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new MemoryCoreError('invalid_jsonl', `Invalid memory event JSONL at line ${lineNumber}: ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new MemoryCoreError('invalid_event', `Memory event at line ${lineNumber} is not an object`);
  }

  const event = parsed as unknown as MemoryEvent;
  try {
    validateMemoryEvent(event);
  } catch (error) {
    if (error instanceof MemoryCoreError) {
      throw new MemoryCoreError(error.code, `Invalid memory event at line ${lineNumber}: ${error.message}`);
    }
    throw error;
  }
  return event;
}

function validateActor(actor: MemoryActor): void {
  if (!isRecord(actor)) {
    throw new MemoryCoreError('invalid_actor', 'actor must be an object');
  }

  ensureArrayIncludes(['user', 'bot', 'agent', 'worker', 'system'] as const, actor.kind, 'actor.kind');
  ensureNonEmptyString(actor.id, 'actor.id');
}

function validateScope(scope: MemoryScope): void {
  if (!isRecord(scope)) {
    throw new MemoryCoreError('invalid_scope', 'scope must be an object');
  }

  ensureArrayIncludes(MEMORY_VISIBILITIES, scope.visibility, 'scope.visibility');
}

function ensureNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryCoreError('invalid_field', `${field} must be a non-empty string`);
  }
}

function ensureIsoTimestamp(value: unknown, field: string): void {
  ensureNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new MemoryCoreError('invalid_timestamp', `${field} must be an ISO timestamp`);
  }
}

function ensureArrayIncludes<T extends string>(
  allowed: readonly T[],
  value: unknown,
  field: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new MemoryCoreError('invalid_enum', `${field} has unsupported value: ${String(value)}`);
  }
}

function validateStringArray(value: unknown[], field: string): void {
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new MemoryCoreError('invalid_field', `${field}[${index}] must be a non-empty string`);
    }
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
