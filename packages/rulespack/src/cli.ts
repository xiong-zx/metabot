#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { digestObject, eventId } from './canonical.js';
import { RulesPackEngine } from './engine.js';
import { RulesPackError } from './errors.js';
import type {
  DeliveryReceipt,
  RuleV1,
  RulesFeedback,
  RulesMode,
  SourceSnapshot,
} from './model.js';
import { RulesStore } from './store.js';
import {
  parseRuleArray,
  normalizeRule,
  validateDeliveryReceipt,
  validateExecutionSubject,
  validateRule,
  validateSourceGeneration,
} from './validate.js';

const HELP = `rulespack [--db PATH] [--mode off|shadow|enforce] COMMAND

Commands:
  validate FILE                         Validate a Rule, Rule array, or SourceSnapshot
  import FILE                           Import/upsert a Rule, Rule array, or SourceSnapshot
  upsert FILE                           Alias for import
  revoke RULE_ID --reason TEXT          Revoke the current Rule version
  compile --subject FILE [budget flags] Compile the current indexed Rules
  explain --subject FILE [budget flags] Compile with complete decisions
  status                                Show rules, sources, cache, mode, and last compile status
  cache-status                          Show cache and source status
  cache-clear                           Clear recomputable pack cache and LKG records
  receipts [--digest DIGEST]            List delivery receipts
  receipt-add FILE                      Record a delivery/consumption receipt
  feedback [--digest DIGEST]            List feedback
  feedback-add --digest D --kind K --message TEXT [--rule RULE_ID]
  audit [--limit N]                     List bounded, redacted audit events

Budget flags: --max-tokens N --max-characters N
Trusted compiler-owned imports only: --trusted-authority
The CLI never loads MetaMemory or calls an LLM. Source refresh belongs to an adapter process.`;

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function jsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new RulesPackError('VALIDATION_ERROR', `Unable to parse JSON file ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseMode(value: string | undefined): RulesMode {
  const mode = value ?? 'off';
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
    throw new RulesPackError('VALIDATION_ERROR', `Invalid mode ${mode}`);
  }
  return mode;
}

function operatorRule(value: unknown, trustedAuthority: boolean): RuleV1 {
  const validated = validateRule(value);
  const { digest: _digest, tokenEstimate: _tokenEstimate, ...withoutComputed } = validated;
  const { trustedAuthority: _claimedTrust, ...source } = validated.source;
  return normalizeRule({
    ...withoutComputed,
    source: { ...source, ...(trustedAuthority ? { trustedAuthority: true } : {}) },
  });
}

function asSnapshot(value: unknown, trustedAuthority: boolean): SourceSnapshot | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SourceSnapshot>;
  if (!candidate.source || !candidate.rules) return undefined;
  if (typeof candidate.source.sourceId !== 'string' || !Array.isArray(candidate.rules)) return undefined;
  const rules = parseRuleArray(candidate.rules).map((rule) => operatorRule(rule, trustedAuthority));
  if (rules.some((rule) => rule.source.adapterId !== candidate.source?.sourceId)) {
    throw new RulesPackError('VALIDATION_ERROR', 'Snapshot Rule source IDs must match source.sourceId');
  }
  const source = validateSourceGeneration(candidate.source);
  const snapshotDigest = digestObject(
    [...rules]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, version, digest }) => ({ id, version, digest })),
  );
  if (snapshotDigest !== source.snapshotDigest) {
    throw new RulesPackError('VALIDATION_ERROR', 'Snapshot digest does not match normalized Rules');
  }
  return { source, rules };
}

function rulesFromValue(value: unknown, trustedAuthority: boolean): readonly RuleV1[] {
  return (Array.isArray(value) ? value : [value]).map((entry) => operatorRule(entry, trustedAuthority));
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: 'string', default: process.env.RULESPACK_DB ?? './rules-state.sqlite' },
      mode: { type: 'string', default: process.env.RULESPACK_MODE ?? 'off' },
      subject: { type: 'string' },
      reason: { type: 'string' },
      digest: { type: 'string' },
      kind: { type: 'string' },
      message: { type: 'string' },
      rule: { type: 'string' },
      actor: { type: 'string' },
      limit: { type: 'string', default: '100' },
      'max-tokens': { type: 'string', default: '2000' },
      'max-characters': { type: 'string', default: '8000' },
      help: { type: 'boolean', short: 'h' },
      'trusted-authority': { type: 'boolean', default: false },
    },
  });
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const command = parsed.positionals[0];
  const argument = parsed.positionals[1];
  const mode = parseMode(parsed.values.mode);
  if (command === 'validate') {
    if (!argument) throw new RulesPackError('VALIDATION_ERROR', 'validate requires FILE');
    const value = await jsonFile(argument);
    const trustedAuthority = parsed.values['trusted-authority'] ?? false;
    const snapshot = asSnapshot(value, trustedAuthority);
    output(snapshot ?? rulesFromValue(value, trustedAuthority));
    return;
  }

  const store = new RulesStore(parsed.values.db ?? './rules-state.sqlite');
  try {
    const engine = new RulesPackEngine({ store, mode });
    switch (command) {
      case 'import':
      case 'upsert': {
        if (!argument) throw new RulesPackError('VALIDATION_ERROR', `${command} requires FILE`);
        const value = await jsonFile(argument);
        const trustedAuthority = parsed.values['trusted-authority'] ?? false;
        const snapshot = asSnapshot(value, trustedAuthority);
        if (snapshot) {
          store.replaceSourceSnapshot(snapshot);
          store.audit('source-refresh', { health: snapshot.source.health, generation: snapshot.source.generation, ruleCount: snapshot.rules.length }, { sourceId: snapshot.source.sourceId });
          output({ imported: snapshot.rules.length, source: snapshot.source });
        } else {
          const rules = rulesFromValue(value, trustedAuthority);
          for (const rule of rules) {
            store.upsertRule(rule);
            store.audit('rule-upsert', { version: rule.version, digest: rule.digest }, { ruleId: rule.id, sourceId: rule.source.adapterId });
          }
          output({ imported: rules.length, rules: rules.map(({ id, version, digest }) => ({ id, version, digest })) });
        }
        break;
      }
      case 'revoke': {
        if (!argument || !parsed.values.reason) {
          throw new RulesPackError('VALIDATION_ERROR', 'revoke requires RULE_ID and --reason');
        }
        const rule = store.revokeRule(argument, parsed.values.reason);
        store.audit('rule-revoke', { version: rule.version, digest: rule.digest, reason: parsed.values.reason }, { ruleId: rule.id, sourceId: rule.source.adapterId });
        output(rule);
        break;
      }
      case 'compile':
      case 'explain': {
        if (!parsed.values.subject) throw new RulesPackError('VALIDATION_ERROR', `${command} requires --subject FILE`);
        const subject = validateExecutionSubject(await jsonFile(parsed.values.subject));
        const maxTokens = Number(parsed.values['max-tokens']);
        const maxCharacters = Number(parsed.values['max-characters']);
        const result = engine.compile({ subject, budget: { maxTokens, maxCharacters }, mode });
        output(command === 'explain' ? result : { pack: result.pack, telemetry: result.telemetry, injectionText: result.injectionText });
        break;
      }
      case 'status':
      case 'cache-status':
        output(engine.status());
        break;
      case 'cache-clear':
        output({ cleared: engine.clearCache(), status: engine.status() });
        break;
      case 'receipts':
        output(store.listReceipts(parsed.values.digest, Number(parsed.values.limit)));
        break;
      case 'receipt-add': {
        if (!argument) throw new RulesPackError('VALIDATION_ERROR', 'receipt-add requires FILE');
        const receipt = validateDeliveryReceipt(await jsonFile(argument));
        store.recordReceipt(receipt);
        output(receipt);
        break;
      }
      case 'feedback':
        output(store.listFeedback(parsed.values.digest, Number(parsed.values.limit)));
        break;
      case 'feedback-add': {
        if (!parsed.values.digest || !parsed.values.kind || !parsed.values.message) {
          throw new RulesPackError('VALIDATION_ERROR', 'feedback-add requires --digest, --kind, and --message');
        }
        if (!['wrong', 'missing', 'unhelpful', 'helpful'].includes(parsed.values.kind)) {
          throw new RulesPackError('VALIDATION_ERROR', 'feedback kind must be wrong|missing|unhelpful|helpful');
        }
        const feedback: RulesFeedback = {
          feedbackId: eventId('feedback'),
          packDigest: parsed.values.digest,
          kind: parsed.values.kind as RulesFeedback['kind'],
          message: parsed.values.message,
          ...(parsed.values.rule ? { ruleId: parsed.values.rule } : {}),
          ...(parsed.values.actor ? { actor: parsed.values.actor } : {}),
          createdAt: new Date().toISOString(),
        };
        store.recordFeedback(feedback);
        output(feedback);
        break;
      }
      case 'audit':
        output(store.listAudit(Number(parsed.values.limit)));
        break;
      default:
        throw new RulesPackError('VALIDATION_ERROR', `Unknown command ${command}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof RulesPackError) {
    process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message, details: error.details }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
