import { MetaBotRulesPackRuntime, validateRulesPackDatabasePath } from './runtime.js';
import type { RulesPackConfig, RulesPackLogger } from './types.js';

/** Validate configured sources and project containment without touching the live RulesPack database. */
export async function preflightRulesPackConfig(config: RulesPackConfig, logger: RulesPackLogger): Promise<void> {
  validateRulesPackDatabasePath(config.dbPath, config.protectedDbPaths);
  const runtime = new MetaBotRulesPackRuntime({
    ...config,
    dbPath: ':memory:',
    protectedDbPaths: [],
  }, logger);
  try {
    await runtime.refresh();
  } finally {
    runtime.close();
  }
}
