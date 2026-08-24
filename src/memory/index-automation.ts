import { createHash } from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from '../api/bot-registry.js';
import {
  type DocumentChangeEvent,
  type FullDocument,
  type MemoryClient,
  MemoryClientRequestError,
} from './memory-client.js';

export type MemoryIndexAutomationMode = 'off' | 'events' | 'dry-run' | 'routing' | 'full';

export interface MemoryIndexAutomationConfig {
  mode: MemoryIndexAutomationMode;
  pollMs?: number;
  reconcileMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  consumer?: string;
  targetBot?: string;
  root?: string;
  statusPath?: string;
  qualityApproved?: boolean;
  autoApplyEnabled?: boolean;
}

export interface StatusPatchProposal {
  decision: 'skip' | 'propose';
  project: string | null;
  replacement_row: string | null;
  rationale: string;
  source_event_ids: number[];
  expected_version: number;
}

export const P5_QUALITY_CONTRACT = Object.freeze({
  minimum_labeled_samples: 30,
  minimum_material_samples: 10,
  minimum_auto_apply_samples: 5,
  minimum_decision_accuracy: 0.95,
  minimum_auto_apply_precision: 1,
  maximum_correction_rate: 0.05,
  maximum_critical_errors: 0,
  maximum_structural_failures: 0,
});

export type P5QualityOutcome = 'apply' | 'review' | 'skip';

export interface P5QualitySample {
  expected: P5QualityOutcome;
  actual: P5QualityOutcome;
  corrected?: boolean;
  critical_error?: boolean;
  structural_failure?: boolean;
}

export interface P5QualityEvaluation {
  passed: boolean;
  sample_count: number;
  material_sample_count: number;
  auto_apply_sample_count: number;
  decision_accuracy: number;
  auto_apply_precision: number;
  correction_rate: number;
  critical_errors: number;
  structural_failures: number;
  failures: string[];
}

export interface StatusAutoApplyPlan {
  outcome: P5QualityOutcome;
  reason: string;
  content?: string;
  previous_row?: string;
  changed_columns?: string[];
  unsupported_tokens?: string[];
}

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_RECONCILE_MS = 15 * 60_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_PROMPT_EVENTS = 12;
const MAX_PROMPT_EXCERPT_BYTES = 512;
const AUTO_APPLY_HEADERS = new Set([
  'status',
  'currentstate',
  'nextaction',
  '状态',
  '当前状态',
  '当前进展',
  '下一步',
  '下一步行动',
]);
const EVIDENCE_STOP_WORDS = new Set([
  'a', 'an', 'the',
]);
const PROJECT_STOP_WORDS = new Set([
  'project', 'system', 'platform', 'service', 'tasks',
]);

export class MemoryIndexAutomation {
  private timer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;
  private running = false;
  private lastReconciledAt = 0;

  private readonly pollMs: number;
  private readonly reconcileMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly consumer: string;
  private readonly targetBot: string;
  private readonly root: string;
  private readonly statusPath: string;

  constructor(
    private readonly config: MemoryIndexAutomationConfig,
    private readonly memoryClient: MemoryClient,
    private readonly registry: BotRegistry,
    private readonly logger: Logger,
  ) {
    if (config.mode === 'full' && !config.qualityApproved) {
      throw new Error('METABOT_MEMORY_INDEX_AUTOMATION=full requires METABOT_MEMORY_INDEX_QUALITY_APPROVED=true');
    }
    if (config.mode === 'full' && !config.autoApplyEnabled) {
      throw new Error('METABOT_MEMORY_INDEX_AUTOMATION=full requires METABOT_MEMORY_INDEX_AUTO_APPLY_ENABLED=true');
    }
    this.pollMs = positiveInt(config.pollMs, DEFAULT_POLL_MS);
    this.reconcileMs = positiveInt(config.reconcileMs, DEFAULT_RECONCILE_MS);
    this.batchSize = positiveInt(config.batchSize, DEFAULT_BATCH_SIZE);
    this.maxAttempts = positiveInt(config.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.consumer = config.consumer || (config.mode === 'full' ? 'memory-status-full' : 'memory-status-dry-run');
    this.targetBot = config.targetBot || 'memory';
    this.root = normalizeRoot(config.root || process.env.METABOT_CORE_MEMORY_SERVER_ROOT || '/cargo1');
    this.statusPath = config.statusPath || `${this.root}/status/project-progress-status`;
  }

  start(): void {
    if (this.timer || this.destroyed || !this.shouldPoll()) return;
    this.timer = setInterval(() => {
      void this.checkNow('poll');
    }, this.pollMs);
    this.timer.unref?.();
    void this.checkNow('startup');
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkNow(reason = 'manual'): Promise<void> {
    if (this.destroyed || this.running || !this.shouldPoll()) return;
    this.running = true;
    try {
      await this.maybeReconcile(reason);
      await this.consumeBatch(reason);
      if (this.config.mode === 'routing' || this.config.mode === 'full') {
        await this.refreshRoutingIndex(reason, this.config.mode === 'routing');
      }
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error), reason },
        'Memory index automation check failed',
      );
    } finally {
      this.running = false;
    }
  }

  private shouldPoll(): boolean {
    return this.config.mode === 'dry-run' || this.config.mode === 'routing' || this.config.mode === 'full';
  }

  private async maybeReconcile(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastReconciledAt < this.reconcileMs) return;
    const report = await this.memoryClient.reconcileIndexes(this.root);
    this.lastReconciledAt = now;
    this.logger.info(
      { reason, mode: this.config.mode, summary: report.summary },
      'Memory index reconciliation completed',
    );
  }

  private async consumeBatch(reason: string): Promise<void> {
    const state = await this.memoryClient.getDocumentChangeConsumerState(this.consumer);
    if (this.config.mode === 'full' && state.initialized === undefined) {
      throw new Error('Full memory automation requires a metabot-core consumer API with initialization metadata');
    }
    if (this.config.mode === 'full' && !state.initialized) {
      await this.memoryClient.advanceDocumentChangeConsumer(this.consumer, state.latest_event_id);
      this.logger.info(
        { reason, consumer: this.consumer, throughEventId: state.latest_event_id },
        'Initialized full memory automation at the current event head without replaying historical changes',
      );
      return;
    }
    const feed = await this.memoryClient.listDocumentChangeEvents(state.last_event_id, this.batchSize, this.root);
    if (feed.events.length === 0) {
      if (feed.next_after > state.last_event_id) {
        await this.memoryClient.advanceDocumentChangeConsumer(this.consumer, feed.next_after);
      }
      return;
    }

    const groups = coalesceAdjacentDocumentEvents(feed.events);
    for (const [groupIndex, group] of groups.entries()) {
      const lastEventId = group[group.length - 1].id;
      const throughEventId = groupIndex === groups.length - 1 ? Math.max(lastEventId, feed.next_after) : lastEventId;
      if (!isSemanticStatusCandidate(group, this.root)) {
        await this.memoryClient.recordDocumentChangeProcessing({
          consumer: this.consumer,
          event_ids: group.map((event) => event.id),
          through_event_id: throughEventId,
          status: 'skipped',
          proposal: { reason: 'deterministic_filter' },
        });
        continue;
      }
      if (group.length > MAX_PROMPT_EVENTS) {
        await this.memoryClient.recordDocumentChangeProcessing({
          consumer: this.consumer,
          event_ids: group.map((event) => event.id),
          through_event_id: throughEventId,
          status: 'proposed',
          proposal_ref: `${this.consumer}:${lastEventId}`,
          proposal: {
            decision: 'review',
            reason: 'event_group_exceeds_prompt_limit',
            event_count: group.length,
            prompt_event_limit: MAX_PROMPT_EVENTS,
            source_event_ids: group.map((event) => event.id),
          },
          review_outcome: 'pending',
        });
        continue;
      }

      let statusWriteMayHaveCompleted = false;
      try {
        if (this.config.mode === 'full' && await this.recoverPendingAutoApply(group, throughEventId)) {
          continue;
        }
        const { proposal, prompt, response, latencyMs, statusDocument } = await this.proposeStatusPatch(group);
        if (this.config.mode === 'full' && proposal.decision === 'propose') {
          const plan = planStatusAutoApply(statusDocument, proposal, group);
          const audit = statusAutoApplyAudit(statusDocument, proposal, plan, group);
          if (plan.outcome === 'apply' && plan.content) {
            await this.memoryClient.recordDocumentChangeProcessing({
              consumer: this.consumer,
              event_ids: group.map((event) => event.id),
              through_event_id: throughEventId,
              status: 'pending',
              proposal_ref: `${this.consumer}:${lastEventId}`,
              proposal: { ...proposal, ...audit, automation_outcome: 'apply_pending' },
              tokens_in: estimateTokens(prompt),
              tokens_out: estimateTokens(response),
              latency_ms: latencyMs,
              advance_cursor: false,
              increment_attempts: false,
            });
            const updated = await this.memoryClient.updateDocument(statusDocument.id, {
              content: plan.content,
              expected_version: statusDocument.version,
              change_origin: 'reconciler',
            });
            statusWriteMayHaveCompleted = true;
            assertAppliedDocument(updated, statusDocument, plan.content);
            await this.memoryClient.recordDocumentChangeProcessing({
              consumer: this.consumer,
              event_ids: group.map((event) => event.id),
              through_event_id: throughEventId,
              status: 'applied',
              proposal_ref: `${this.consumer}:${lastEventId}`,
              proposal: {
                ...proposal,
                ...audit,
                automation_outcome: 'applied',
                applied_version: updated.version,
              },
              tokens_in: estimateTokens(prompt),
              tokens_out: estimateTokens(response),
              latency_ms: latencyMs,
              review_outcome: 'accepted',
              increment_attempts: false,
            });
            continue;
          }
          await this.memoryClient.recordDocumentChangeProcessing({
            consumer: this.consumer,
            event_ids: group.map((event) => event.id),
            through_event_id: throughEventId,
            status: plan.outcome === 'skip' ? 'skipped' : 'proposed',
            proposal_ref: plan.outcome === 'review' ? `${this.consumer}:${lastEventId}` : undefined,
            proposal: { ...proposal, ...audit },
            tokens_in: estimateTokens(prompt),
            tokens_out: estimateTokens(response),
            latency_ms: latencyMs,
            review_outcome: plan.outcome === 'review' ? 'pending' : undefined,
          });
          continue;
        }
        await this.memoryClient.recordDocumentChangeProcessing({
          consumer: this.consumer,
          event_ids: group.map((event) => event.id),
          through_event_id: throughEventId,
          status: proposal.decision === 'propose' ? 'proposed' : 'skipped',
          proposal_ref: proposal.decision === 'propose' ? `${this.consumer}:${lastEventId}` : undefined,
          proposal: { ...proposal },
          tokens_in: estimateTokens(prompt),
          tokens_out: estimateTokens(response),
          latency_ms: latencyMs,
          review_outcome: proposal.decision === 'propose' ? 'pending' : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (statusWriteMayHaveCompleted) {
          this.logger.warn(
            { reason, eventIds: group.map((event) => event.id), err: message },
            'Memory status write completed but final audit failed; preserving pending audit for recovery',
          );
          break;
        }
        if (error instanceof MemoryClientRequestError && isTransientMemoryClientError(error)) {
          this.logger.warn(
            {
              reason,
              eventIds: group.map((event) => event.id),
              statusCode: error.statusCode,
              err: message,
            },
            'Memory status proposal paused after metabot-core request failure',
          );
          break;
        }
        const processing = await this.memoryClient.listDocumentChangeProcessing(
          this.consumer,
          state.last_event_id,
          this.batchSize,
        );
        const previousAttempts = processing.find((item) => item.event_id === group[0].id)?.attempts ?? 0;
        const attemptNumber = previousAttempts + 1;
        const dead = attemptNumber >= this.maxAttempts;
        await this.memoryClient.recordDocumentChangeProcessing({
          consumer: this.consumer,
          event_ids: group.map((event) => event.id),
          through_event_id: throughEventId,
          status: dead ? 'dead' : 'failed',
          error: message,
          advance_cursor: dead,
          increment_attempts: true,
        });
        this.logger.warn(
          {
            reason,
            eventIds: group.map((event) => event.id),
            attempts: attemptNumber,
            dead,
            err: message,
          },
          'Memory status proposal failed',
        );
        if (!dead) break;
      }
    }
  }

  private async recoverPendingAutoApply(
    events: DocumentChangeEvent[],
    throughEventId: number,
  ): Promise<boolean> {
    const eventIds = events.map((event) => event.id);
    const processing = await this.memoryClient.listDocumentChangeProcessing(
      this.consumer,
      Math.max(0, eventIds[0] - 1),
      Math.max(this.batchSize, eventIds.length),
    );
    const pending = processing.find((item) => item.event_id === eventIds[0] && item.status === 'pending');
    const audit = pending?.proposal_json;
    if (
      !audit
      || audit.automation_outcome !== 'apply_pending'
      || !Array.isArray(audit.source_event_ids)
      || JSON.stringify(audit.source_event_ids) !== JSON.stringify(eventIds)
      || typeof audit.content_after_sha256 !== 'string'
      || typeof audit.expected_version !== 'number'
    ) {
      return false;
    }
    const documentId = typeof audit.status_document_id === 'string'
      ? audit.status_document_id
      : this.statusPath;
    const current = await this.memoryClient.getDocument(documentId);
    const currentHash = current ? sha256(current.content) : null;
    if (
      current
      && current.version === audit.expected_version
      && currentHash === audit.content_before_sha256
    ) {
      return false;
    }
    if (
      !current
      || current.version !== audit.expected_version + 1
      || currentHash !== audit.content_after_sha256
    ) {
      await this.memoryClient.recordDocumentChangeProcessing({
        consumer: this.consumer,
        event_ids: eventIds,
        through_event_id: throughEventId,
        status: 'proposed',
        proposal_ref: pending.proposal_ref ?? `${this.consumer}:${eventIds.at(-1)}`,
        proposal: {
          ...audit,
          automation_outcome: 'recovery_requires_review',
          automation_reason: 'pending_write_state_is_ambiguous',
          recovery_observed_version: current?.version ?? null,
          recovery_observed_sha256: currentHash,
        },
        review_outcome: 'pending',
        increment_attempts: false,
      });
      this.logger.warn(
        { eventIds, documentId, version: current?.version ?? null },
        'Memory status pending write is ambiguous and requires manual review',
      );
      return true;
    }
    await this.memoryClient.recordDocumentChangeProcessing({
      consumer: this.consumer,
      event_ids: eventIds,
      through_event_id: throughEventId,
      status: 'applied',
      proposal_ref: pending.proposal_ref ?? `${this.consumer}:${eventIds.at(-1)}`,
      proposal: {
        ...audit,
        automation_outcome: 'applied_recovered',
        applied_version: current.version,
      },
      review_outcome: 'accepted',
      increment_attempts: false,
    });
    this.logger.info(
      { eventIds, documentId: current.id, version: current.version },
      'Recovered a completed memory status write from its pending audit record',
    );
    return true;
  }

  private async proposeStatusPatch(events: DocumentChangeEvent[]): Promise<{
    proposal: StatusPatchProposal;
    prompt: string;
    response: string;
    latencyMs: number;
    statusDocument: FullDocument;
  }> {
    const bot = this.registry.get(this.targetBot);
    if (!bot) throw new Error(`Memory index target bot not found: ${this.targetBot}`);
    const status = await this.memoryClient.getDocument(this.statusPath);
    if (!status) throw new Error(`Project status document not found: ${this.statusPath}`);
    const candidateRows = selectCandidateProjectRows(status.content, events);
    const prompt = buildStatusPatchPrompt(events, status.version, candidateRows);
    const result = await bot.bridge.executeApiTask({
      prompt,
      chatId: `system:memory-index:${this.consumer}`,
      userId: 'memory-index-automation',
      sendCards: false,
      maxTurns: 1,
      allowedTools: [],
    });
    if (!result.success) throw new Error(result.error || 'Memory bot proposal failed');
    return {
      proposal: parseStatusPatchProposal(result.responseText, events, status.version, candidateRows),
      prompt,
      response: result.responseText,
      latencyMs: Math.max(0, Math.floor(result.durationMs ?? 0)),
      statusDocument: status,
    };
  }

  private async refreshRoutingIndex(reason: string, required: boolean): Promise<void> {
    const preview = await this.memoryClient.previewRoutingIndex(this.root);
    if (!preview.changed) return;
    if (!preview.rebuild_enabled) {
      if (required) {
        throw new Error('Routing mode requires METABOT_MEMORY_ROUTING_REBUILD_ENABLED=true on metabot-core');
      }
      this.logger.info(
        { reason, targetVersion: preview.target_version },
        'Memory routing index rebuild skipped because the independent server gate is disabled',
      );
      return;
    }
    const result = await this.memoryClient.rebuildRoutingIndex(this.root, preview.target_version);
    this.logger.info(
      {
        reason,
        sourceDocumentCount: preview.source_document_count,
        targetVersion: result.target_version,
        snapshotId: result.snapshot_id,
      },
      'Memory routing index materialized view rebuilt',
    );
  }
}

export function parseMemoryIndexAutomationMode(value: string | undefined): MemoryIndexAutomationMode {
  const normalized = (value || 'off').trim().toLowerCase();
  if (
    normalized === 'off' ||
    normalized === 'events' ||
    normalized === 'dry-run' ||
    normalized === 'routing' ||
    normalized === 'full'
  )
    return normalized;
  throw new Error(
    `Invalid METABOT_MEMORY_INDEX_AUTOMATION '${value}'. Expected off, events, dry-run, routing, or full.`,
  );
}

export function shouldInitializeMemoryIndexAutomation(mode: MemoryIndexAutomationMode): boolean {
  return mode === 'dry-run' || mode === 'routing' || mode === 'full';
}

export function isSemanticStatusCandidate(events: DocumentChangeEvent[], root: string): boolean {
  return events.some((event) => {
    if (event.origin === 'indexer' || event.origin === 'reconciler' || event.origin === 't5t') {
      return false;
    }
    const paths = [event.old_path, event.new_path].filter((path): path is string => !!path);
    if (paths.length === 0 || !paths.some((path) => isUnder(path, root))) return false;
    if (paths.some((path) => isAutomationTarget(path, root))) return false;
    if (event.content_changed) return true;
    return event.changed_fields.some((field) => ['title', 'tags', 'shared'].includes(field));
  });
}

export function coalesceAdjacentDocumentEvents(events: DocumentChangeEvent[]): DocumentChangeEvent[][] {
  const groups: DocumentChangeEvent[][] = [];
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const current = groups[groups.length - 1];
    if (
      current &&
      (current[current.length - 1].doc_id === event.doc_id ||
        (event.cascade_of !== null && current[current.length - 1].cascade_of === event.cascade_of))
    ) {
      current.push(event);
    } else {
      groups.push([event]);
    }
  }
  return groups;
}

export function selectCandidateProjectRows(markdown: string, events: DocumentChangeEvent[], limit = 3): string[] {
  const rows = currentProjectRows(markdown);
  if (rows.length <= limit) return rows;
  const terms = new Set(
    events
      .flatMap((event) => [
        event.old_path,
        event.new_path,
        event.old_title,
        event.new_title,
        ...event.old_tags,
        ...event.new_tags,
      ])
      .filter((value): value is string => !!value)
      .flatMap(tokenize),
  );
  return rows
    .map((row, index) => ({
      row,
      index,
      score: tokenize(row).reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.row);
}

export function buildStatusPatchPrompt(
  events: DocumentChangeEvent[],
  expectedVersion: number,
  candidateRows: string[],
): string {
  return [
    'You are producing a bounded proposal for one project-status Markdown row.',
    'Do not call tools, write files, update MetaMemory, dispatch work, or add commentary.',
    'Use only the bounded event data and candidate rows below.',
    'Return exactly one JSON object with this schema:',
    '{"decision":"skip|propose","project":"string|null","replacement_row":"single Markdown table row|null","rationale":"short string","source_event_ids":[1],"expected_version":1}',
    'Rules:',
    '- Use decision=skip when the event does not materially change a project current state, blocker, or next action.',
    '- For propose, replacement_row must be exactly one line beginning and ending with | and must preserve the existing table column count.',
    '- Never invent completion, deployment, validation, ownership, or dates not supported by the event.',
    `- expected_version must equal ${expectedVersion}.`,
    `Candidate rows:\n${candidateRows.length > 0 ? candidateRows.join('\n') : '(none)'}`,
    `All source event IDs: ${JSON.stringify(events.map((event) => event.id))}`,
    `Events shown: ${Math.min(events.length, MAX_PROMPT_EVENTS)} of ${events.length}`,
    `Events:\n${JSON.stringify(events.slice(0, MAX_PROMPT_EVENTS).map(compactEventForPrompt), null, 2)}`,
  ].join('\n');
}

export function planStatusAutoApply(
  document: FullDocument,
  proposal: StatusPatchProposal,
  events: DocumentChangeEvent[],
): StatusAutoApplyPlan {
  if (proposal.decision === 'skip') return { outcome: 'skip', reason: 'model_skip' };
  if (proposal.expected_version !== document.version) {
    return { outcome: 'review', reason: 'expected_version_mismatch' };
  }
  if (!proposal.project || !proposal.replacement_row) {
    return { outcome: 'review', reason: 'missing_project_or_replacement' };
  }
  const table = currentProjectsTable(document.content);
  if (!table) return { outcome: 'review', reason: 'current_projects_table_not_found' };
  const matches = table.rows.filter((row) => firstTableCell(row.line) === proposal.project);
  if (matches.length !== 1) {
    return { outcome: 'review', reason: 'project_row_not_unique' };
  }
  const match = matches[0];
  const replacementCells = splitMarkdownTableRow(proposal.replacement_row);
  if (replacementCells.length !== table.headers.length || match.cells.length !== table.headers.length) {
    return { outcome: 'review', reason: 'column_count_changed', previous_row: match.line };
  }
  if (firstTableCell(proposal.replacement_row) !== proposal.project) {
    return { outcome: 'review', reason: 'project_identity_changed', previous_row: match.line };
  }
  const associationEvidence = new Set(evidenceTokens(projectAssociationText(events)));
  const projectTokens = evidenceTokens(proposal.project)
    .filter((token) => !PROJECT_STOP_WORDS.has(token));
  if (projectTokens.length === 0 || !projectTokens.some((token) => associationEvidence.has(token))) {
    return {
      outcome: 'review',
      reason: 'project_not_bound_to_source_events',
      previous_row: match.line,
    };
  }

  const changedIndexes = replacementCells
    .map((cell, index) => (normalizeCell(cell) === normalizeCell(match.cells[index]) ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) {
    return { outcome: 'skip', reason: 'no_status_change', previous_row: match.line };
  }
  const changedColumns = changedIndexes.map((index) => table.headers[index]);
  const forbidden = changedIndexes.filter(
    (index) => !AUTO_APPLY_HEADERS.has(normalizeHeader(table.headers[index])),
  );
  if (forbidden.length > 0) {
    return {
      outcome: 'review',
      reason: 'non_status_column_changed',
      previous_row: match.line,
      changed_columns: changedColumns,
    };
  }

  const evidenceClauses = statusEvidenceClauses(events);
  const unsupported = new Set<string>();
  for (const index of changedIndexes) {
    if (containsNegation(match.cells[index]) && !containsNegation(replacementCells[index])) {
      return {
        outcome: 'review',
        reason: 'negation_removed',
        previous_row: match.line,
        changed_columns: changedColumns,
      };
    }
    const oldSequence = evidenceTokens(match.cells[index]);
    const newSequence = evidenceTokens(replacementCells[index]);
    const oldTokens = new Set(oldSequence);
    const newTokens = new Set(newSequence);
    const addedTokens = [...newTokens].filter((token) => !oldTokens.has(token));
    const removedTokens = [...oldTokens].filter((token) => !newTokens.has(token));
    const commonTokens = new Set([...oldTokens].filter((token) => newTokens.has(token)));
    const oldCommonSequence = oldSequence.filter((token) => commonTokens.has(token));
    const newCommonSequence = newSequence.filter((token) => commonTokens.has(token));
    if (
      JSON.stringify(oldCommonSequence) !== JSON.stringify(newCommonSequence)
      && !hasPositiveEvidence(evidenceClauses, newSequence)
    ) {
      return {
        outcome: 'review',
        reason: 'relational_rewrite_not_in_evidence',
        previous_row: match.line,
        changed_columns: changedColumns,
      };
    }
    if (removedTokens.length > 0 && addedTokens.length === 0) {
      return {
        outcome: 'review',
        reason: 'unsupported_fact_removal',
        previous_row: match.line,
        changed_columns: changedColumns,
      };
    }
    const requiredAddedTokens = addedTokens.filter((token) => !EVIDENCE_STOP_WORDS.has(token));
    if (requiredAddedTokens.length > 0 && !hasPositiveEvidence(evidenceClauses, requiredAddedTokens)) {
      for (const token of requiredAddedTokens) unsupported.add(token);
    }
  }
  if (unsupported.size > 0) {
    return {
      outcome: 'review',
      reason: 'unsupported_status_facts',
      previous_row: match.line,
      changed_columns: changedColumns,
      unsupported_tokens: [...unsupported].sort(),
    };
  }

  const lines = document.content.split(/\r?\n/);
  lines[match.lineIndex] = proposal.replacement_row;
  return {
    outcome: 'apply',
    reason: 'single_row_evidence_bound_change',
    content: lines.join(document.content.includes('\r\n') ? '\r\n' : '\n'),
    previous_row: match.line,
    changed_columns: changedColumns,
  };
}

export function evaluateP5QualityContract(samples: P5QualitySample[]): P5QualityEvaluation {
  const sampleCount = samples.length;
  const materialSampleCount = samples.filter((sample) => sample.expected !== 'skip').length;
  const autoApplySamples = samples.filter((sample) => sample.actual === 'apply');
  const correct = samples.filter((sample) => sample.actual === sample.expected).length;
  const correctAutoApply = autoApplySamples.filter((sample) => sample.expected === 'apply').length;
  const corrections = samples.filter((sample) => sample.corrected).length;
  const criticalErrors = samples.filter((sample) => sample.critical_error).length;
  const structuralFailures = samples.filter((sample) => sample.structural_failure).length;
  const decisionAccuracy = sampleCount === 0 ? 0 : correct / sampleCount;
  const autoApplyPrecision = autoApplySamples.length === 0 ? 0 : correctAutoApply / autoApplySamples.length;
  const correctionRate = sampleCount === 0 ? 0 : corrections / sampleCount;
  const failures: string[] = [];
  if (sampleCount < P5_QUALITY_CONTRACT.minimum_labeled_samples) failures.push('insufficient_labeled_samples');
  if (materialSampleCount < P5_QUALITY_CONTRACT.minimum_material_samples) failures.push('insufficient_material_samples');
  if (autoApplySamples.length < P5_QUALITY_CONTRACT.minimum_auto_apply_samples) {
    failures.push('insufficient_auto_apply_samples');
  }
  if (decisionAccuracy < P5_QUALITY_CONTRACT.minimum_decision_accuracy) failures.push('decision_accuracy_below_threshold');
  if (autoApplyPrecision < P5_QUALITY_CONTRACT.minimum_auto_apply_precision) failures.push('auto_apply_precision_below_threshold');
  if (correctionRate > P5_QUALITY_CONTRACT.maximum_correction_rate) failures.push('correction_rate_above_threshold');
  if (criticalErrors > P5_QUALITY_CONTRACT.maximum_critical_errors) failures.push('critical_errors_present');
  if (structuralFailures > P5_QUALITY_CONTRACT.maximum_structural_failures) failures.push('structural_failures_present');
  return {
    passed: failures.length === 0,
    sample_count: sampleCount,
    material_sample_count: materialSampleCount,
    auto_apply_sample_count: autoApplySamples.length,
    decision_accuracy: decisionAccuracy,
    auto_apply_precision: autoApplyPrecision,
    correction_rate: correctionRate,
    critical_errors: criticalErrors,
    structural_failures: structuralFailures,
    failures,
  };
}

export function parseStatusPatchProposal(
  response: string,
  events: DocumentChangeEvent[],
  expectedVersion: number,
  candidateRows: string[],
): StatusPatchProposal {
  const parsed = parseJsonObject(response);
  const decision = parsed.decision === 'propose' ? 'propose' : parsed.decision === 'skip' ? 'skip' : null;
  if (!decision) throw new Error('Proposal decision must be skip or propose');
  const sourceEventIds = Array.isArray(parsed.source_event_ids)
    ? parsed.source_event_ids.filter((value): value is number => Number.isInteger(value))
    : [];
  const expectedIds = events.map((event) => event.id);
  if (JSON.stringify(sourceEventIds) !== JSON.stringify(expectedIds)) {
    throw new Error('Proposal source_event_ids do not match the processed events');
  }
  if (parsed.expected_version !== expectedVersion) {
    throw new Error('Proposal expected_version does not match the status document');
  }
  const project = typeof parsed.project === 'string' ? parsed.project.trim() : null;
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  const replacementRow = typeof parsed.replacement_row === 'string' ? parsed.replacement_row.trim() : null;
  if (!rationale) throw new Error('Proposal rationale is required');
  if (decision === 'skip') {
    return {
      decision,
      project,
      replacement_row: null,
      rationale,
      source_event_ids: sourceEventIds,
      expected_version: expectedVersion,
    };
  }
  if (
    !replacementRow ||
    replacementRow.includes('\n') ||
    !replacementRow.startsWith('|') ||
    !replacementRow.endsWith('|')
  ) {
    throw new Error('Proposal replacement_row must be one Markdown table row');
  }
  const candidate = candidateRows.find((row) => firstTableCell(row) === project);
  if (!candidate) throw new Error('Proposal project is not one of the candidate rows');
  if (splitMarkdownTableRow(candidate).length !== splitMarkdownTableRow(replacementRow).length) {
    throw new Error('Proposal replacement_row changed the table column count');
  }
  return {
    decision,
    project,
    replacement_row: replacementRow,
    rationale,
    source_event_ids: sourceEventIds,
    expected_version: expectedVersion,
  };
}

function compactEventForPrompt(event: DocumentChangeEvent) {
  return {
    id: event.id,
    op: event.op,
    doc_id: event.doc_id,
    old_path: event.old_path,
    new_path: event.new_path,
    old_title: event.old_title,
    new_title: event.new_title,
    old_tags: event.old_tags,
    new_tags: event.new_tags,
    old_version: event.old_version,
    new_version: event.new_version,
    changed_fields: event.changed_fields,
    old_excerpt: boundedPromptExcerpt(event.old_excerpt),
    new_excerpt: boundedPromptExcerpt(event.new_excerpt),
    old_routing: event.old_routing,
    new_routing: event.new_routing,
  };
}

function boundedPromptExcerpt(value: string | null): string | null {
  if (value === null || Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_EXCERPT_BYTES) {
    return value;
  }
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > MAX_PROMPT_EXCERPT_BYTES) {
    end = Math.floor(end * 0.8);
  }
  while (Buffer.byteLength(value.slice(0, end + 1), 'utf8') <= MAX_PROMPT_EXCERPT_BYTES) {
    end += 1;
  }
  return value.slice(0, end);
}

function statusAutoApplyAudit(
  document: FullDocument,
  proposal: StatusPatchProposal,
  plan: StatusAutoApplyPlan,
  events: DocumentChangeEvent[],
): Record<string, unknown> {
  return {
    automation_outcome: plan.outcome,
    automation_reason: plan.reason,
    source_event_ids: events.map((event) => event.id),
    source_events: events.map(compactEventForPrompt),
    source_document_ids: [...new Set(events.map((event) => event.doc_id))],
    status_document_id: document.id,
    status_document_path: document.path,
    expected_version: document.version,
    previous_row: plan.previous_row ?? null,
    replacement_row: proposal.replacement_row,
    changed_columns: plan.changed_columns ?? [],
    unsupported_tokens: plan.unsupported_tokens ?? [],
    content_before_sha256: sha256(document.content),
    content_after_sha256: plan.content ? sha256(plan.content) : null,
  };
}

function assertAppliedDocument(updated: FullDocument, previous: FullDocument, expectedContent: string): void {
  if (updated.id !== previous.id) throw new Error('Status auto-apply returned a different document');
  if (updated.version !== previous.version + 1) {
    throw new Error('Status auto-apply returned an unexpected document version');
  }
  if (updated.content !== expectedContent) {
    throw new Error('Status auto-apply verification failed: returned content differs');
  }
}

function currentProjectsTable(markdown: string): {
  headers: string[];
  rows: Array<{ line: string; lineIndex: number; cells: string[] }>;
} | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## Current Projects');
  if (start < 0) return null;
  let headers: string[] | null = null;
  const rows: Array<{ line: string; lineIndex: number; cells: string[] }> = [];
  for (let lineIndex = start + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    if (/^##\s+/.test(line)) break;
    if (!line.startsWith('|')) continue;
    const cells = splitMarkdownTableRow(line);
    if (!headers) {
      headers = cells;
      continue;
    }
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push({ line, lineIndex, cells });
  }
  return headers ? { headers, rows } : null;
}

function normalizeCell(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function evidenceTokens(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
    .filter((token) => token.length >= 2);
}

function containsNegation(value: string): boolean {
  return /\b(?:no|not|never|without)\b|尚未|并未|没有|未|不|无/iu.test(value);
}

function containsTokenSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  let matched = 0;
  for (const token of haystack) {
    if (token === needle[matched]) matched += 1;
    if (matched === needle.length) return true;
  }
  return false;
}

function statusEvidenceClauses(events: DocumentChangeEvent[]): Array<{ tokens: string[]; negated: boolean }> {
  return events
    .flatMap((event) => [
      boundedPromptExcerpt(event.new_excerpt),
      event.new_routing?.index_summary ?? null,
    ])
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(/[\n.!?;:。！？；：]+/u))
    .map((value) => ({ tokens: evidenceTokens(value), negated: containsNegation(value) }))
    .filter((clause) => clause.tokens.length > 0);
}

function hasPositiveEvidence(
  clauses: Array<{ tokens: string[]; negated: boolean }>,
  requiredTokens: string[],
): boolean {
  const relevant = clauses.filter((clause) => containsTokenSubsequence(clause.tokens, requiredTokens));
  return relevant.length > 0 && relevant.every((clause) => !clause.negated);
}

function projectAssociationText(events: DocumentChangeEvent[]): string {
  return events.map((event) => JSON.stringify({
    old_path: event.old_path,
    new_path: event.new_path,
    old_title: event.old_title,
    new_title: event.new_title,
    old_tags: event.old_tags,
    new_tags: event.new_tags,
    old_project_key: event.old_routing?.project_key ?? null,
    new_project_key: event.new_routing?.project_key ?? null,
    new_excerpt: boundedPromptExcerpt(event.new_excerpt),
  })).join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isTransientMemoryClientError(error: MemoryClientRequestError): boolean {
  return error.statusCode === null
    || error.statusCode === 408
    || error.statusCode === 425
    || error.statusCode === 429
    || error.statusCode >= 500;
}

function currentProjectRows(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## Current Projects');
  if (start < 0) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    if (!line.trim().startsWith('|')) continue;
    const first = firstTableCell(line);
    if (!first || first === 'Project' || /^-+$/.test(first)) continue;
    rows.push(line.trim());
  }
  return rows;
}

function firstTableCell(row: string): string {
  return splitMarkdownTableRow(row)[0]?.replace(/`/g, '').trim() || '';
}

function splitMarkdownTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  let code = false;
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
      escaped = true;
    } else if (char === '`') {
      current += char;
      code = !code;
    } else if (char === '|' && !code) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseJsonObject(response: string): Record<string, unknown> {
  const trimmed = response.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced ? fenced[1] : trimmed;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Proposal response must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= 2);
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isAutomationTarget(path: string, root: string): boolean {
  return [`${root}/index`, `${root}/status`].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function normalizeRoot(value: string): string {
  const rooted = value.trim().startsWith('/') ? value.trim() : `/${value.trim()}`;
  return rooted.length > 1 ? rooted.replace(/\/+$/, '') : rooted;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
}
