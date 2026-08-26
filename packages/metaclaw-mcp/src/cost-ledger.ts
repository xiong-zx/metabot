import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { MetaClawError } from './errors.js';

export interface MetaClawCostPolicy {
  readonly ledgerFile: string;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxUsdMicros: number;
  readonly inputUsdMicrosPerMillion: number;
  readonly outputUsdMicrosPerMillion: number;
}

export interface CostReservation {
  readonly id: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usdMicros: number;
}

const reservationSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  usd_micros: z.number().int().nonnegative(),
  settled: z.boolean(),
  outcome: z.enum(['success', 'failed']).nullable(),
  actual_input_tokens: z.number().int().nonnegative().nullable(),
  actual_output_tokens: z.number().int().nonnegative().nullable(),
}).strict();

const ledgerSchema = z.object({
  version: z.literal(1),
  calls: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  usd_micros: z.number().int().nonnegative(),
  reservations: z.record(z.string().uuid(), reservationSchema),
}).strict();

type Ledger = z.infer<typeof ledgerSchema>;

export class MetaClawCostLedger {
  constructor(private readonly policy: MetaClawCostPolicy) {
    if (!path.isAbsolute(policy.ledgerFile)) throw new MetaClawError('Cost ledger path must be absolute', 'profile_invalid');
    for (const [name, value] of Object.entries(policy)) {
      if (name === 'ledgerFile') continue;
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new MetaClawError(`Cost policy ${name} must be a positive integer`, 'profile_invalid');
      }
    }
    const parent = lstatSync(path.dirname(policy.ledgerFile));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700) {
      throw new MetaClawError('Cost ledger directory must be a 0700 plain directory', 'profile_invalid');
    }
    if (existsSync(policy.ledgerFile)) this.read();
  }

  reserve(inputTokens: number, outputTokens: number): CostReservation {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 1) {
      throw new MetaClawError('Inference token reservation is invalid', 'invalid_request');
    }
    const usdMicros = costMicros(inputTokens, outputTokens, this.policy);
    return this.locked((ledger) => {
      const next = {
        calls: ledger.calls + 1,
        inputTokens: ledger.input_tokens + inputTokens,
        outputTokens: ledger.output_tokens + outputTokens,
        usdMicros: ledger.usd_micros + usdMicros,
      };
      if (
        next.calls > this.policy.maxCalls ||
        next.inputTokens > this.policy.maxInputTokens ||
        next.outputTokens > this.policy.maxOutputTokens ||
        next.usdMicros > this.policy.maxUsdMicros
      ) {
        throw new MetaClawError('MetaClaw inference cost budget is exhausted', 'limitation_gated', {
          reason: 'cost_budget_exhausted',
        });
      }
      const id = randomUUID();
      ledger.calls = next.calls;
      ledger.input_tokens = next.inputTokens;
      ledger.output_tokens = next.outputTokens;
      ledger.usd_micros = next.usdMicros;
      ledger.reservations[id] = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        usd_micros: usdMicros,
        settled: false,
        outcome: null,
        actual_input_tokens: null,
        actual_output_tokens: null,
      };
      this.write(ledger);
      return { id, inputTokens, outputTokens, usdMicros };
    });
  }

  settle(
    reservation: CostReservation,
    outcome: 'success' | 'failed',
    actual?: { inputTokens: number; outputTokens: number },
  ): void {
    this.locked((ledger) => {
      const entry = ledger.reservations[reservation.id];
      if (!entry || entry.settled) throw new MetaClawError('Cost reservation cannot be settled', 'internal');
      if (actual && (
        !Number.isSafeInteger(actual.inputTokens) || actual.inputTokens < 0 ||
        !Number.isSafeInteger(actual.outputTokens) || actual.outputTokens < 0 ||
        actual.inputTokens > entry.input_tokens || actual.outputTokens > entry.output_tokens
      )) {
        throw new MetaClawError('Provider usage exceeds the reserved cost ceiling', 'contract_violation');
      }
      entry.settled = true;
      entry.outcome = outcome;
      entry.actual_input_tokens = actual?.inputTokens ?? null;
      entry.actual_output_tokens = actual?.outputTokens ?? null;
      this.write(ledger);
    });
  }

  private locked<T>(operation: (ledger: Ledger) => T): T {
    const lock = `${this.policy.ledgerFile}.lock`;
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw new MetaClawError('Cost ledger is busy; inference was not dispatched', 'limitation_gated', {
        reason: 'cost_ledger_busy',
      });
    }
    try {
      return operation(this.read());
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  private read(): Ledger {
    if (!existsSync(this.policy.ledgerFile)) return emptyLedger();
    const info = lstatSync(this.policy.ledgerFile);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
      throw new MetaClawError('Cost ledger must be a 0600 regular non-symlink file', 'profile_invalid');
    }
    const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(this.policy.ledgerFile, 'utf8')) as unknown);
    if (!parsed.success) throw new MetaClawError('Cost ledger is invalid', 'profile_invalid');
    return parsed.data;
  }

  private write(ledger: Ledger): void {
    const temporary = `${this.policy.ledgerFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.policy.ledgerFile);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function emptyLedger(): Ledger {
  return { version: 1, calls: 0, input_tokens: 0, output_tokens: 0, usd_micros: 0, reservations: {} };
}

function costMicros(inputTokens: number, outputTokens: number, policy: MetaClawCostPolicy): number {
  return Math.ceil(
    (inputTokens * policy.inputUsdMicrosPerMillion + outputTokens * policy.outputUsdMicrosPerMillion) / 1_000_000,
  );
}
