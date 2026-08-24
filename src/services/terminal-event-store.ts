import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { TerminalCallbackEnvelope } from '../api/routes/worker-events-routes.js';

export type TerminalEventState = 'received' | 'leased' | 'woken' | 'failed';

export interface TerminalEventRecord {
  eventId: string;
  purpose: TerminalCallbackEnvelope['purpose'];
  botName: string;
  chatId: string;
  envelope: TerminalCallbackEnvelope;
  state: TerminalEventState;
  attempts: number;
  leaseExpiresAt?: number;
  nextAttemptAt: number;
  lastError?: string;
  receivedAt: number;
  updatedAt: number;
  wokenAt?: number;
}

interface TerminalEventRow {
  event_id: string;
  purpose: TerminalCallbackEnvelope['purpose'];
  bot_name: string;
  chat_id: string;
  envelope_json: string;
  state: TerminalEventState;
  attempts: number;
  lease_expires_at: number | null;
  next_attempt_at: number;
  last_error: string | null;
  received_at: number;
  updated_at: number;
  woken_at: number | null;
}

export interface TerminalEventStoreOptions {
  dbPath?: string;
  maxAttempts?: number;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** A transient wake failure that must remain durable until the target is available. */
export class TerminalEventDeferredError extends Error {
  constructor(message: string, readonly retryAfterMs = 30_000) {
    super(message);
    this.name = 'TerminalEventDeferredError';
  }
}

export class TerminalEventStore {
  private readonly db: Database.Database;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(
    private readonly logger: Logger,
    options: TerminalEventStoreOptions = {},
  ) {
    const dbPath = options.dbPath
      ?? process.env.METABOT_BRIDGE_EVENTS_DB?.trim()
      ?? join(process.env.SESSION_STORE_DIR?.trim() || join(homedir(), '.metabot'), 'bridge-events.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.maxAttempts = positiveInteger(options.maxAttempts, 5);
    this.leaseMs = positiveInteger(options.leaseMs, 10 * 60 * 1000);
    this.backoffBaseMs = nonNegativeInteger(options.backoffBaseMs, 1_000);
    this.backoffMaxMs = positiveInteger(options.backoffMaxMs, 60_000);
    this.migrate();
  }

  insert(envelope: TerminalCallbackEnvelope, now = Date.now()): { inserted: boolean; record: TerminalEventRecord } {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO terminal_events
        (event_id, purpose, bot_name, chat_id, envelope_json, state, attempts,
         lease_expires_at, next_attempt_at, last_error, received_at, updated_at, woken_at)
      VALUES (?, ?, ?, ?, ?, 'received', 0, NULL, ?, NULL, ?, ?, NULL)
    `).run(
      envelope.event_id,
      envelope.purpose,
      envelope.bot_name,
      envelope.chat_id,
      JSON.stringify(envelope),
      now,
      now,
      now,
    );
    return { inserted: result.changes === 1, record: this.get(envelope.event_id)! };
  }

  has(eventId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM terminal_events WHERE event_id = ?').get(eventId);
  }

  get(eventId: string): TerminalEventRecord | undefined {
    const row = this.db.prepare('SELECT * FROM terminal_events WHERE event_id = ?').get(eventId) as TerminalEventRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(): TerminalEventRecord[] {
    return (this.db.prepare('SELECT * FROM terminal_events ORDER BY received_at ASC').all() as TerminalEventRow[])
      .map(rowToRecord);
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM terminal_events').get() as { count: number }).count);
  }

  leaseNext(now = Date.now()): TerminalEventRecord | undefined {
    const claim = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE terminal_events
        SET state = 'failed', lease_expires_at = NULL, updated_at = ?,
            last_error = COALESCE(last_error, 'terminal event retry budget exhausted')
        WHERE state IN ('received', 'leased')
          AND attempts >= ?
          AND ((state = 'received' AND next_attempt_at <= ?)
            OR (state = 'leased' AND lease_expires_at <= ?))
      `).run(now, this.maxAttempts, now, now);

      const row = this.db.prepare(`
        SELECT * FROM terminal_events
        WHERE attempts < ?
          AND ((state = 'received' AND next_attempt_at <= ?)
            OR (state = 'leased' AND lease_expires_at <= ?))
        ORDER BY received_at ASC
        LIMIT 1
      `).get(this.maxAttempts, now, now) as TerminalEventRow | undefined;
      if (!row) return undefined;
      this.db.prepare(`
        UPDATE terminal_events
        SET state = 'leased', attempts = attempts + 1,
            lease_expires_at = ?, updated_at = ?
        WHERE event_id = ?
      `).run(now + this.leaseMs, now, row.event_id);
      return this.get(row.event_id);
    });
    return claim.immediate();
  }

  markWoken(eventId: string, now = Date.now()): TerminalEventRecord | undefined {
    this.db.prepare(`
      UPDATE terminal_events
      SET state = 'woken', lease_expires_at = NULL, last_error = NULL,
          woken_at = ?, updated_at = ?
      WHERE event_id = ? AND state = 'leased'
    `).run(now, now, eventId);
    return this.get(eventId);
  }

  failLease(eventId: string, error: unknown, now = Date.now()): TerminalEventRecord | undefined {
    const current = this.get(eventId);
    if (!current || current.state !== 'leased') return current;
    const message = boundedError(error);
    if (current.attempts >= this.maxAttempts) {
      this.db.prepare(`
        UPDATE terminal_events
        SET state = 'failed', lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE event_id = ? AND state = 'leased'
      `).run(message, now, eventId);
    } else {
      const delay = Math.min(
        this.backoffMaxMs,
        this.backoffBaseMs * (2 ** Math.max(0, current.attempts - 1)),
      );
      this.db.prepare(`
        UPDATE terminal_events
        SET state = 'received', lease_expires_at = NULL, next_attempt_at = ?,
            last_error = ?, updated_at = ?
        WHERE event_id = ? AND state = 'leased'
      `).run(now + delay, message, now, eventId);
    }
    return this.get(eventId);
  }

  deferLease(
    eventId: string,
    error: unknown,
    retryAfterMs: number,
    now = Date.now(),
  ): TerminalEventRecord | undefined {
    const message = boundedError(error);
    const delay = Math.max(1, Math.floor(retryAfterMs));
    this.db.prepare(`
      UPDATE terminal_events
      SET state = 'received', attempts = MAX(0, attempts - 1),
          lease_expires_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE event_id = ? AND state = 'leased'
    `).run(now + delay, message, now, eventId);
    return this.get(eventId);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_events (
        event_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('received', 'leased', 'woken', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        woken_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_terminal_events_ready
        ON terminal_events(state, next_attempt_at, lease_expires_at, received_at);
    `);
    this.logger.info({ maxAttempts: this.maxAttempts, leaseMs: this.leaseMs }, 'Terminal callback inbox initialized');
  }
}

export class TerminalEventDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private wakeScheduled = false;
  private sweeping = false;
  private stopped = false;

  constructor(private readonly options: {
    store: TerminalEventStore;
    logger: Logger;
    wake: (envelope: TerminalCallbackEnvelope) => Promise<void>;
    sweepIntervalMs?: number;
  }) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.notify();
    const intervalMs = positiveInteger(this.options.sweepIntervalMs, 30_000);
    this.timer = setInterval(() => this.notify(), intervalMs);
    this.timer.unref?.();
  }

  notify(): void {
    if (this.stopped || this.wakeScheduled) return;
    this.wakeScheduled = true;
    const immediate = setImmediate(() => {
      this.wakeScheduled = false;
      void this.sweep();
    });
    immediate.unref?.();
  }

  async sweep(): Promise<void> {
    if (this.stopped || this.sweeping) return;
    this.sweeping = true;
    try {
      while (!this.stopped) {
        const event = this.options.store.leaseNext();
        if (!event) break;
        try {
          await this.options.wake(event.envelope);
          this.options.store.markWoken(event.eventId);
        } catch (error) {
          if (error instanceof TerminalEventDeferredError) {
            const next = this.options.store.deferLease(event.eventId, error, error.retryAfterMs);
            this.options.logger.info(
              { error, eventId: event.eventId, retryAt: next?.nextAttemptAt },
              'Terminal callback wake deferred until the target chat is available',
            );
            continue;
          }
          const next = this.options.store.failLease(event.eventId, error);
          if (next?.state === 'failed') {
            this.options.logger.error(
              { error, eventId: event.eventId, attempts: next.attempts },
              'Terminal callback wake exhausted its retry budget',
            );
          } else {
            this.options.logger.warn(
              { error, eventId: event.eventId, attempts: next?.attempts },
              'Terminal callback wake failed; event returned to inbox',
            );
          }
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function rowToRecord(row: TerminalEventRow): TerminalEventRecord {
  return {
    eventId: row.event_id,
    purpose: row.purpose,
    botName: row.bot_name,
    chatId: row.chat_id,
    envelope: JSON.parse(row.envelope_json) as TerminalCallbackEnvelope,
    state: row.state,
    attempts: row.attempts,
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ...(row.woken_at !== null ? { wokenAt: row.woken_at } : {}),
  };
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 1_000);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : fallback;
}
