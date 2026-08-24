import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { MetaClawCostLedger } from '../src/cost-ledger.js';
import { cleanupFixtures, createFixture } from './helpers.js';

afterEach(cleanupFixtures);

describe('mechanical inference cost ledger', () => {
  it('reserves worst-case tokens and USD before dispatch and records settlement', () => {
    const fixture = createFixture();
    const ledger = new MetaClawCostLedger(fixtureProfile(fixture).cost);
    const reservation = ledger.reserve(100, 200);
    ledger.settle(reservation, 'success', { inputTokens: 80, outputTokens: 150 });

    const state = JSON.parse(readFileSync(fixtureProfile(fixture).cost.ledgerFile, 'utf8'));
    expect(state).toMatchObject({ calls: 1, input_tokens: 100, output_tokens: 200 });
    expect(state.reservations[reservation.id]).toMatchObject({
      settled: true,
      outcome: 'success',
      actual_input_tokens: 80,
      actual_output_tokens: 150,
    });
  });

  it('refuses budget exhaustion and a concurrent writer before provider dispatch', () => {
    const fixture = createFixture();
    const cost = { ...fixtureProfile(fixture).cost, maxCalls: 1 };
    const ledger = new MetaClawCostLedger(cost);
    ledger.reserve(1, 1);
    expect(() => ledger.reserve(1, 1)).toThrow(/budget is exhausted/i);

    mkdirSync(`${cost.ledgerFile}.lock`, { mode: 0o700 });
    expect(() => new MetaClawCostLedger(cost).reserve(1, 1)).toThrow(/ledger is busy/i);
  });

  it('rejects a replaced or broadly readable ledger', () => {
    const fixture = createFixture();
    const cost = fixtureProfile(fixture).cost;
    new MetaClawCostLedger(cost);
    writeFileSync(cost.ledgerFile, '{}\n');
    chmodSync(cost.ledgerFile, 0o644);
    expect(() => new MetaClawCostLedger(cost)).toThrow(/0600 regular/i);
  });
});

function fixtureProfile(fixture: ReturnType<typeof createFixture>) {
  return JSON.parse(readFileSync(fixture.profilePath, 'utf8')) as {
    cost: {
      ledgerFile: string;
      maxCalls: number;
      maxInputTokens: number;
      maxOutputTokens: number;
      maxUsdMicros: number;
      inputUsdMicrosPerMillion: number;
      outputUsdMicrosPerMillion: number;
    };
  };
}
