import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { digestObject, eventId, stableStringify } from './canonical.js';
import { verifyCompiledPack } from './compiler.js';
import { RulesPackError } from './errors.js';
import type {
  AuditEvent,
  CompiledRulesPack,
  DeliveryReceipt,
  RuleV1,
  RulesFeedback,
  SourceGeneration,
  SourceSnapshot,
} from './model.js';
import {
  redactDiagnostic,
  validateDeliveryReceipt,
  validateFeedback,
  validateRule,
  validateSourceGeneration,
} from './validate.js';

const SCHEMA_VERSION = 1;

function parseJson<T>(value: unknown, label: string): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch (error) {
    throw new RulesPackError('STORE_ERROR', `Invalid JSON in ${label}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function safeAuditData(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const redact = (input: unknown, key = ''): unknown => {
    if (/secret|password|credential|authorization|private.?key|rule.?text|content/iu.test(key)) {
      return '[REDACTED]';
    }
    if (typeof input === 'string') return redactDiagnostic(input);
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => redact(item));
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .slice(0, 100)
          .map(([childKey, child]) => [childKey, redact(child, childKey)]),
      );
    }
    return input;
  };
  return redact(value) as Readonly<Record<string, unknown>>;
}

export interface StoreCounts {
  currentRules: number;
  revokedRules: number;
  persistentCacheEntries: number;
}

export class RulesStore {
  readonly filename: string;
  readonly #db: DatabaseSync;

  constructor(filename: string) {
    this.filename = filename;
    this.#db = new DatabaseSync(filename);
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (filename !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rule_versions (
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        digest TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved', 'revoked')),
        rule_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version, digest)
      );
      CREATE TABLE IF NOT EXISTS current_rules (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        digest TEXT NOT NULL,
        source_id TEXT NOT NULL,
        rule_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS current_rules_source_idx ON current_rules(source_id);
      CREATE TABLE IF NOT EXISTS revocations (
        rule_id TEXT NOT NULL,
        version TEXT NOT NULL,
        digest TEXT NOT NULL,
        source_id TEXT NOT NULL,
        revoked_at TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (rule_id, version, digest)
      );
      CREATE TABLE IF NOT EXISTS source_generations (
        source_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        generation TEXT NOT NULL,
        revision TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        fresh_until TEXT,
        health TEXT NOT NULL,
        error TEXT,
        rule_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pack_cache (
        cache_key TEXT PRIMARY KEY,
        pack_digest TEXT NOT NULL,
        subject_fingerprint TEXT NOT NULL,
        source_snapshot_digest TEXT NOT NULL,
        pack_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        valid_until TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pack_cache_sources (
        cache_key TEXT NOT NULL REFERENCES pack_cache(cache_key) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        PRIMARY KEY (cache_key, source_id)
      );
      CREATE INDEX IF NOT EXISTS pack_cache_source_idx ON pack_cache_sources(source_id);
      CREATE TABLE IF NOT EXISTS cache_metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS last_known_good (
        subject_fingerprint TEXT PRIMARY KEY,
        pack_digest TEXT NOT NULL,
        source_snapshot_digest TEXT NOT NULL,
        pack_json TEXT NOT NULL,
        stored_at TEXT NOT NULL,
        valid_until TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        subject_fingerprint TEXT,
        pack_digest TEXT,
        rule_id TEXT,
        source_id TEXT,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_occurred_idx ON audit_events(occurred_at DESC);
      CREATE TABLE IF NOT EXISTS delivery_receipts (
        receipt_id TEXT PRIMARY KEY,
        pack_digest TEXT NOT NULL,
        subject_fingerprint TEXT NOT NULL,
        target_json TEXT NOT NULL,
        status TEXT NOT NULL,
        channel TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        issuer TEXT,
        audience TEXT,
        replay_id TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS receipt_pack_idx ON delivery_receipts(pack_digest, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS feedback (
        feedback_id TEXT PRIMARY KEY,
        pack_digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        rule_id TEXT,
        actor TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS feedback_pack_idx ON feedback(pack_digest, created_at DESC);
    `);
    this.#db
      .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertRule(ruleValue: RuleV1, now = new Date().toISOString(), updateGeneration = true): RuleV1 {
    const rule = validateRule(ruleValue);
    if (updateGeneration) {
      return this.transaction(() => {
        const stored = this.upsertRule(rule, now, false);
        const currentRules = this.listRules(rule.source.adapterId);
        const snapshotDigest = digestObject(
          currentRules.map(({ id, version, digest }) => ({ id, version, digest })),
        );
        const manualGeneration = `manual:${snapshotDigest.replace(/^sha256:/u, '')}`;
        this.upsertSourceGeneration({
          sourceId: rule.source.adapterId,
          kind: rule.source.kind,
          generation: manualGeneration,
          revision: rule.source.revision,
          snapshotDigest,
          observedAt: now,
          health: 'fresh',
          ruleCount: currentRules.length,
        });
        this.invalidateSourceCache(rule.source.adapterId);
        return stored;
      });
    }
    const existing = this.#db.prepare('SELECT source_id FROM current_rules WHERE id = ?').get(rule.id) as
      | { source_id: string }
      | undefined;
    if (existing && existing.source_id !== rule.source.adapterId) {
      throw new RulesPackError('STORE_ERROR', `Rule ID ${rule.id} is already owned by source ${existing.source_id}`);
    }
    this.#db
      .prepare(`INSERT OR IGNORE INTO rule_versions(id, version, digest, source_id, status, rule_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(rule.id, rule.version, rule.digest, rule.source.adapterId, rule.lifecycle.status, stableStringify(rule), now);
    this.#db
      .prepare(`INSERT INTO current_rules(id, version, digest, source_id, rule_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version, digest=excluded.digest,
          source_id=excluded.source_id, rule_json=excluded.rule_json, updated_at=excluded.updated_at`)
      .run(rule.id, rule.version, rule.digest, rule.source.adapterId, stableStringify(rule), now);
    if (rule.lifecycle.status === 'revoked') {
      this.#db
        .prepare(`INSERT OR REPLACE INTO revocations(rule_id, version, digest, source_id, revoked_at, reason)
          VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          rule.id,
          rule.version,
          rule.digest,
          rule.source.adapterId,
          rule.lifecycle.revokedAt ?? now,
          rule.lifecycle.revokeReason ?? null,
        );
    }
    return rule;
  }

  replaceSourceSnapshot(snapshot: SourceSnapshot): void {
    const sourceId = snapshot.source.sourceId;
    const rules = snapshot.rules.map(validateRule);
    if (rules.some((rule) => rule.source.adapterId !== sourceId)) {
      throw new RulesPackError('STORE_ERROR', 'Snapshot contains a rule owned by another source', { sourceId });
    }
    this.transaction(() => {
      const keep = new Set(rules.map((rule) => rule.id));
      const existing = this.#db.prepare('SELECT id FROM current_rules WHERE source_id = ?').all(sourceId) as Array<{ id: string }>;
      for (const row of existing) {
        if (!keep.has(row.id)) this.#db.prepare('DELETE FROM current_rules WHERE id = ?').run(row.id);
      }
      for (const rule of rules) this.upsertRule(rule, snapshot.source.observedAt, false);
      this.upsertSourceGeneration(snapshot.source);
      this.invalidateSourceCache(sourceId);
    });
  }

  upsertSourceGeneration(source: SourceGeneration): void {
    source = validateSourceGeneration(source);
    if (source.error) source = { ...source, error: redactDiagnostic(source.error) };
    this.#db
      .prepare(`INSERT INTO source_generations(
        source_id, kind, generation, revision, snapshot_digest, observed_at, fresh_until, health, error, rule_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET kind=excluded.kind, generation=excluded.generation,
        revision=excluded.revision, snapshot_digest=excluded.snapshot_digest,
        observed_at=excluded.observed_at, fresh_until=excluded.fresh_until,
        health=excluded.health, error=excluded.error, rule_count=excluded.rule_count`)
      .run(
        source.sourceId,
        source.kind,
        source.generation,
        source.revision,
        source.snapshotDigest,
        source.observedAt,
        source.freshUntil ?? null,
        source.health,
        source.error ?? null,
        source.ruleCount,
      );
  }

  getRule(id: string): RuleV1 | undefined {
    const row = this.#db.prepare('SELECT rule_json FROM current_rules WHERE id = ?').get(id) as
      | { rule_json: string }
      | undefined;
    return row ? validateRule(parseJson(row.rule_json, `current rule ${id}`)) : undefined;
  }

  listRules(sourceId?: string): readonly RuleV1[] {
    const rows = (sourceId
      ? this.#db.prepare('SELECT rule_json FROM current_rules WHERE source_id = ? ORDER BY id').all(sourceId)
      : this.#db.prepare('SELECT rule_json FROM current_rules ORDER BY id').all()) as Array<{ rule_json: string }>;
    return rows.map((row) => validateRule(parseJson(row.rule_json, 'current_rules.rule_json')));
  }

  listSourceGenerations(): readonly SourceGeneration[] {
    const rows = this.#db.prepare('SELECT * FROM source_generations ORDER BY source_id').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sourceId: String(row.source_id),
      kind: row.kind as SourceGeneration['kind'],
      generation: String(row.generation),
      revision: String(row.revision),
      snapshotDigest: String(row.snapshot_digest),
      observedAt: String(row.observed_at),
      ...(row.fresh_until ? { freshUntil: String(row.fresh_until) } : {}),
      health: row.health as SourceGeneration['health'],
      ...(row.error ? { error: String(row.error) } : {}),
      ruleCount: Number(row.rule_count),
    }));
  }

  revokeRule(id: string, reason: string, revokedAt = new Date().toISOString()): RuleV1 {
    const current = this.getRule(id);
    if (!current) throw new RulesPackError('VALIDATION_ERROR', `Unknown Rule ${id}`);
    const revoked = validateRule({
      ...current,
      digest: undefined,
      lifecycle: { status: 'revoked', revokedAt, revokeReason: reason },
    });
    this.upsertRule(revoked, revokedAt);
    this.invalidateAllPacksContaining(id);
    return revoked;
  }

  isPackSafe(pack: CompiledRulesPack, now = new Date().toISOString()): boolean {
    const nowMs = Date.parse(now);
    if (pack.expiresAt && Date.parse(pack.expiresAt) <= nowMs) return false;
    for (const selected of pack.rules) {
      const current = this.getRule(selected.id);
      if (!current || current.digest !== selected.digest || current.lifecycle.status === 'revoked') return false;
      if (current.lifecycle.expiresAt && Date.parse(current.lifecycle.expiresAt) <= nowMs) return false;
    }
    return true;
  }

  putCachedPack(cacheKey: string, pack: CompiledRulesPack, validUntil: string): void {
    this.transaction(() => {
      this.#db
        .prepare(`INSERT INTO pack_cache(cache_key, pack_digest, subject_fingerprint, source_snapshot_digest, pack_json, created_at, valid_until)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET pack_digest=excluded.pack_digest,
            subject_fingerprint=excluded.subject_fingerprint, source_snapshot_digest=excluded.source_snapshot_digest,
            pack_json=excluded.pack_json, created_at=excluded.created_at, valid_until=excluded.valid_until`)
        .run(cacheKey, pack.packDigest, pack.subjectFingerprint, pack.sourceSnapshotDigest, stableStringify(pack), pack.compiledAt, validUntil);
      this.#db.prepare('DELETE FROM pack_cache_sources WHERE cache_key = ?').run(cacheKey);
      const insert = this.#db.prepare('INSERT INTO pack_cache_sources(cache_key, source_id) VALUES (?, ?)');
      for (const source of pack.sourceGenerations) insert.run(cacheKey, source.sourceId);
    });
  }

  getCachedPack(cacheKey: string, now = new Date().toISOString()): CompiledRulesPack | undefined {
    const row = this.#db.prepare('SELECT pack_json, valid_until FROM pack_cache WHERE cache_key = ?').get(cacheKey) as
      | { pack_json: string; valid_until: string }
      | undefined;
    if (!row || Date.parse(row.valid_until) <= Date.parse(now)) return undefined;
    const pack = parseJson<CompiledRulesPack>(row.pack_json, 'pack_cache.pack_json');
    try {
      verifyCompiledPack(pack, now);
      return this.isPackSafe(pack, now) ? pack : undefined;
    } catch {
      this.#db.prepare('DELETE FROM pack_cache WHERE cache_key = ?').run(cacheKey);
      return undefined;
    }
  }

  putLastKnownGood(pack: CompiledRulesPack, validUntil: string): void {
    this.#db
      .prepare(`INSERT INTO last_known_good(subject_fingerprint, pack_digest, source_snapshot_digest, pack_json, stored_at, valid_until)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(subject_fingerprint) DO UPDATE SET pack_digest=excluded.pack_digest,
          source_snapshot_digest=excluded.source_snapshot_digest, pack_json=excluded.pack_json,
          stored_at=excluded.stored_at, valid_until=excluded.valid_until`)
      .run(pack.subjectFingerprint, pack.packDigest, pack.sourceSnapshotDigest, stableStringify(pack), pack.compiledAt, validUntil);
  }

  getLastKnownGood(subjectFingerprint: string, now = new Date().toISOString()): CompiledRulesPack | undefined {
    const row = this.#db
      .prepare('SELECT pack_json, valid_until FROM last_known_good WHERE subject_fingerprint = ?')
      .get(subjectFingerprint) as { pack_json: string; valid_until: string } | undefined;
    if (!row || Date.parse(row.valid_until) <= Date.parse(now)) return undefined;
    const pack = parseJson<CompiledRulesPack>(row.pack_json, 'last_known_good.pack_json');
    try {
      verifyCompiledPack(pack, now);
      return this.isPackSafe(pack, now) ? pack : undefined;
    } catch {
      this.#db.prepare('DELETE FROM last_known_good WHERE subject_fingerprint = ?').run(subjectFingerprint);
      return undefined;
    }
  }

  invalidateSourceCache(sourceId: string): number {
    const result = this.#db
      .prepare('DELETE FROM pack_cache WHERE cache_key IN (SELECT cache_key FROM pack_cache_sources WHERE source_id = ?)')
      .run(sourceId);
    return Number(result.changes);
  }

  invalidateAllPacksContaining(ruleId: string): number {
    const rows = this.#db.prepare('SELECT cache_key, pack_json FROM pack_cache').all() as Array<{ cache_key: string; pack_json: string }>;
    let removed = 0;
    for (const row of rows) {
      const pack = parseJson<CompiledRulesPack>(row.pack_json, 'pack_cache.pack_json');
      if (pack.rules.some((rule) => rule.id === ruleId)) {
        this.#db.prepare('DELETE FROM pack_cache WHERE cache_key = ?').run(row.cache_key);
        removed += 1;
      }
    }
    const lkgRows = this.#db.prepare('SELECT subject_fingerprint, pack_json FROM last_known_good').all() as Array<{
      subject_fingerprint: string;
      pack_json: string;
    }>;
    for (const row of lkgRows) {
      const pack = parseJson<CompiledRulesPack>(row.pack_json, 'last_known_good.pack_json');
      if (pack.rules.some((rule) => rule.id === ruleId)) {
        this.#db.prepare('DELETE FROM last_known_good WHERE subject_fingerprint = ?').run(row.subject_fingerprint);
      }
    }
    return removed;
  }

  clearCache(): number {
    const count = Number((this.#db.prepare('SELECT COUNT(*) AS count FROM pack_cache').get() as { count: number }).count);
    this.transaction(() => {
      this.#db.exec('DELETE FROM pack_cache; DELETE FROM last_known_good;');
    });
    return count;
  }

  recordAudit(event: AuditEvent): void {
    this.#db
      .prepare(`INSERT INTO audit_events(event_id, type, occurred_at, subject_fingerprint, pack_digest, rule_id, source_id, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.eventId,
        event.type,
        event.occurredAt,
        event.subjectFingerprint ?? null,
        event.packDigest ?? null,
        event.ruleId ?? null,
        event.sourceId ?? null,
        stableStringify(safeAuditData(event.data)),
      );
  }

  audit(type: AuditEvent['type'], data: AuditEvent['data'], fields: Partial<Omit<AuditEvent, 'eventId' | 'type' | 'occurredAt' | 'data'>> = {}): void {
    this.recordAudit({ eventId: eventId('audit'), type, occurredAt: new Date().toISOString(), data, ...fields });
  }

  listAudit(limit = 100): readonly AuditEvent[] {
    const rows = this.#db.prepare('SELECT * FROM audit_events ORDER BY occurred_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: String(row.event_id),
      type: row.type as AuditEvent['type'],
      occurredAt: String(row.occurred_at),
      ...(row.subject_fingerprint ? { subjectFingerprint: String(row.subject_fingerprint) } : {}),
      ...(row.pack_digest ? { packDigest: String(row.pack_digest) } : {}),
      ...(row.rule_id ? { ruleId: String(row.rule_id) } : {}),
      ...(row.source_id ? { sourceId: String(row.source_id) } : {}),
      data: parseJson(row.data_json, 'audit_events.data_json'),
    }));
  }

  recordReceipt(receipt: DeliveryReceipt): void {
    receipt = validateDeliveryReceipt(receipt);
    this.#db
      .prepare(`INSERT INTO delivery_receipts(receipt_id, pack_digest, subject_fingerprint, target_json, status,
        channel, occurred_at, issuer, audience, replay_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        receipt.receiptId,
        receipt.packDigest,
        receipt.subjectFingerprint,
        stableStringify(receipt.target),
        receipt.status,
        receipt.channel,
        receipt.occurredAt,
        receipt.issuer ?? null,
        receipt.audience ?? null,
        receipt.replayId ?? null,
        receipt.details ? stableStringify(safeAuditData(receipt.details)) : null,
      );
    this.audit('receipt', { status: receipt.status, receiptId: receipt.receiptId }, {
      subjectFingerprint: receipt.subjectFingerprint,
      packDigest: receipt.packDigest,
    });
  }

  listReceipts(packDigest?: string, limit = 100): readonly DeliveryReceipt[] {
    const rows = (packDigest
      ? this.#db.prepare('SELECT * FROM delivery_receipts WHERE pack_digest = ? ORDER BY occurred_at DESC LIMIT ?').all(packDigest, limit)
      : this.#db.prepare('SELECT * FROM delivery_receipts ORDER BY occurred_at DESC LIMIT ?').all(limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      receiptId: String(row.receipt_id),
      packDigest: String(row.pack_digest),
      subjectFingerprint: String(row.subject_fingerprint),
      target: parseJson(row.target_json, 'delivery_receipts.target_json'),
      status: row.status as DeliveryReceipt['status'],
      channel: row.channel as DeliveryReceipt['channel'],
      occurredAt: String(row.occurred_at),
      ...(row.issuer ? { issuer: String(row.issuer) } : {}),
      ...(row.audience ? { audience: String(row.audience) } : {}),
      ...(row.replay_id ? { replayId: String(row.replay_id) } : {}),
      ...(row.details_json ? { details: parseJson(row.details_json, 'delivery_receipts.details_json') } : {}),
    }));
  }

  recordFeedback(feedback: RulesFeedback): void {
    feedback = validateFeedback(feedback);
    if (feedback.message.length === 0 || feedback.message.length > 4_096) {
      throw new RulesPackError('VALIDATION_ERROR', 'Feedback message must contain 1 to 4096 characters');
    }
    this.#db
      .prepare(`INSERT INTO feedback(feedback_id, pack_digest, kind, message, rule_id, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        feedback.feedbackId,
        feedback.packDigest,
        feedback.kind,
        feedback.message,
        feedback.ruleId ?? null,
        feedback.actor ?? null,
        feedback.createdAt,
      );
    this.audit(
      'feedback',
      { feedbackId: feedback.feedbackId, kind: feedback.kind },
      { packDigest: feedback.packDigest, ...(feedback.ruleId ? { ruleId: feedback.ruleId } : {}) },
    );
  }

  listFeedback(packDigest?: string, limit = 100): readonly RulesFeedback[] {
    const rows = (packDigest
      ? this.#db.prepare('SELECT * FROM feedback WHERE pack_digest = ? ORDER BY created_at DESC LIMIT ?').all(packDigest, limit)
      : this.#db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?').all(limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      feedbackId: String(row.feedback_id),
      packDigest: String(row.pack_digest),
      kind: row.kind as RulesFeedback['kind'],
      message: String(row.message),
      ...(row.rule_id ? { ruleId: String(row.rule_id) } : {}),
      ...(row.actor ? { actor: String(row.actor) } : {}),
      createdAt: String(row.created_at),
    }));
  }

  counts(): StoreCounts {
    const currentRules = Number((this.#db.prepare('SELECT COUNT(*) AS count FROM current_rules').get() as { count: number }).count);
    const revokedRules = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM current_rules WHERE json_extract(rule_json, '$.lifecycle.status') = 'revoked'").get() as { count: number }).count);
    const persistentCacheEntries = Number((this.#db.prepare('SELECT COUNT(*) AS count FROM pack_cache').get() as { count: number }).count);
    return { currentRules, revokedRules, persistentCacheEntries };
  }

  setCacheMetadata(key: string, value: unknown): void {
    this.#db.prepare(`INSERT INTO cache_metadata(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, stableStringify(value) as SQLInputValue, new Date().toISOString());
  }
}
