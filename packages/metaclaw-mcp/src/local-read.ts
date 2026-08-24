import { MetaClawError } from './errors.js';

export type LocalReadLimitReason = 'entry_limit' | 'byte_limit' | 'deadline';

export interface LocalReadTruncation {
  readonly reason: LocalReadLimitReason;
  readonly limit: number;
}

export interface LocalReadBudgetOptions {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly deadlineMs: number;
  readonly now?: () => number;
}

/**
 * One budget can be shared by every filesystem read needed for a tool call.
 * Status uses one instance for release integrity and skills, so each subsystem
 * cannot independently spend the whole advertised ceiling.
 */
export class LocalReadBudget {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly expiresAt: number;
  private entriesValue = 0;
  private bytesValue = 0;

  constructor(options: LocalReadBudgetOptions) {
    for (const [name, value] of [
      ['maxEntries', options.maxEntries],
      ['maxBytes', options.maxBytes],
      ['deadlineMs', options.deadlineMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new MetaClawError(`${name} must be a positive integer`, 'profile_invalid', { field: name });
      }
    }
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.deadlineMs = options.deadlineMs;
    this.now = options.now ?? (() => Date.now());
    this.expiresAt = this.now() + options.deadlineMs;
  }

  get entries(): number {
    return this.entriesValue;
  }

  get bytes(): number {
    return this.bytesValue;
  }

  checkpoint(): void {
    if (this.now() >= this.expiresAt) throw new LocalReadLimitError('deadline', this.deadlineMs);
  }

  consumeEntry(): void {
    this.checkpoint();
    if (this.entriesValue >= this.maxEntries) {
      throw new LocalReadLimitError('entry_limit', this.maxEntries);
    }
    this.entriesValue += 1;
  }

  consumeBytes(bytes: number): void {
    this.checkpoint();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytesValue + bytes > this.maxBytes) {
      throw new LocalReadLimitError('byte_limit', this.maxBytes);
    }
    this.bytesValue += bytes;
  }

  async race<T>(work: Promise<T>): Promise<T> {
    try {
      this.checkpoint();
    } catch (error) {
      // The promise argument is created before this method is entered. If the
      // budget was already expired, attach a rejection handler before refusing
      // so a late filesystem error cannot escape as an unhandled rejection.
      void work.catch(() => undefined);
      throw error;
    }
    const remaining = Math.max(0, this.expiresAt - this.now());
    if (remaining === 0) {
      void work.catch(() => undefined);
      throw new LocalReadLimitError('deadline', this.deadlineMs);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LocalReadLimitError('deadline', this.deadlineMs)), remaining);
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export class LocalReadLimitError extends Error {
  constructor(
    readonly reason: LocalReadLimitReason,
    readonly limit: number,
  ) {
    super(`Local read stopped at ${reason} ${limit}`);
    this.name = 'LocalReadLimitError';
  }

  toTruncation(): LocalReadTruncation {
    return { reason: this.reason, limit: this.limit };
  }
}

export function createLocalReadBudget(options: LocalReadBudgetOptions): LocalReadBudget {
  return new LocalReadBudget(options);
}
