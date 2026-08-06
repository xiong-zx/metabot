#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RestartStore,
  assertRestartRequestId,
  defaultTargetScripts,
  type RestartKind,
  type RuntimeExpectation,
} from './restart-store.js';
import { clearRestartBreadcrumb, writeRestartBreadcrumb } from '../bridge/restart-notice.js';

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(values: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith('--')) {
      flags.set(name, 'true');
      continue;
    }
    flags.set(name, next);
    i += 1;
  }
  return { positionals, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function optional(flags: Map<string, string>, name: string): string | undefined {
  return flags.get(name)?.trim() || undefined;
}

function integer(flags: Map<string, string>, name: string): number | undefined {
  const value = optional(flags, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function boolean(flags: Map<string, string>, name: string, fallback: boolean): boolean {
  const value = optional(flags, name);
  if (!value) return fallback;
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  throw new Error(`--${name} must be true or false`);
}

function runtimeExpectations(flags: Map<string, string>): Record<string, RuntimeExpectation> | undefined {
  const value = optional(flags, 'expectations-json');
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--expectations-json must be a JSON object');
  }
  return parsed as Record<string, RuntimeExpectation>;
}

export function runRestartStateCli(argv = process.argv.slice(2)): unknown {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];
  if (!command) throw new Error('Usage: restart-state-cli <claim|breadcrumb|mark-restarting|mark-failed|get|clear-breadcrumb>');
  const requestId = required(flags, 'request-id');
  assertRestartRequestId(requestId);

  if (command === 'breadcrumb') {
    return {
      ok: true,
      path: writeRestartBreadcrumb({
        requestId,
        kind: (optional(flags, 'kind') || 'restart') as RestartKind,
        botName: optional(flags, 'bot'),
        chatId: optional(flags, 'chat'),
        source: optional(flags, 'source'),
        reason: optional(flags, 'reason'),
        resume: boolean(flags, 'resume', true),
        targetRoot: required(flags, 'target-root'),
      }),
    };
  }
  if (command === 'clear-breadcrumb') {
    clearRestartBreadcrumb(requestId);
    return { ok: true, requestId };
  }

  const store = new RestartStore();
  try {
    if (command === 'claim') {
      const kind = required(flags, 'kind') as RestartKind;
      const targetRoot = required(flags, 'target-root');
      const targetApps = required(flags, 'target-apps').split(',');
      return store.claim({
        requestId,
        kind,
        requesterBot: optional(flags, 'bot'),
        requesterChat: optional(flags, 'chat'),
        source: optional(flags, 'source'),
        reason: optional(flags, 'reason'),
        resume: boolean(flags, 'resume', true),
        targetRoot,
        targetApps,
        targetScripts: defaultTargetScripts(targetRoot, targetApps),
        runtimeExpectations: runtimeExpectations(flags),
      });
    }
    if (command === 'mark-restarting') {
      return { ok: true, record: store.markRestarting(requestId, { oldRuntimePid: integer(flags, 'old-pid') }) };
    }
    if (command === 'mark-failed') {
      return {
        ok: true,
        record: store.markFailed(requestId, required(flags, 'error'), { runtimePid: integer(flags, 'runtime-pid') }),
      };
    }
    if (command === 'get') return { ok: true, record: store.get(requestId) ?? null };
    throw new Error(`Unknown restart-state command: ${command}`);
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(`${JSON.stringify(runRestartStateCli())}\n`);
  } catch (error) {
    process.stderr.write(`restart-state: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
