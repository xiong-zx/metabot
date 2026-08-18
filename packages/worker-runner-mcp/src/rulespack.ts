import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { MetaBotRulesPackRuntime, type RulesPackConfig } from '@metabot/rulespack-adapter';
import type { WorkerRecord, WorkerRulesPackProvider } from './types.js';

export function createWorkerRulesPackProvider(env: NodeJS.ProcessEnv): WorkerRulesPackProvider | undefined {
  const configPath = env.METABOT_RULESPACK_CONFIG?.trim();
  if (!configPath) return undefined;
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) {
    throw new Error('METABOT_RULESPACK_CONFIG must be a bounded regular non-symlink file');
  }
  const actual = realpathSync(configPath);
  const config = JSON.parse(readFileSync(actual, 'utf8')) as RulesPackConfig;
  const runtime = new MetaBotRulesPackRuntime(config, stderrLogger);
  return {
    async prepare(worker: WorkerRecord) {
      const legacyUnknown = worker.principalRole === 'unknown' || worker.executionKind === 'unknown';
      const prepared = await runtime.prepareTurn({
        botName: worker.botName,
        chatId: worker.chatId,
        roles: legacyUnknown ? ['unknown'] : [worker.principalRole, worker.executionKind],
        cwd: worker.workdir,
        ...(legacyUnknown ? {} : { workerId: worker.id, taskId: worker.id }),
        dataClasses: [legacyUnknown ? 'legacy-unknown' : worker.executionKind === 'arc' ? 'arc' : 'worker'],
        outputTypes: [worker.outputContract?.format ?? 'text'],
      });
      return {
        injectionText: prepared.injectionText,
        packDigest: prepared.packDigest,
        markInjected: prepared.markInjected,
        markRejected: prepared.markRejected,
      };
    },
    close: () => runtime.close(),
  };
}

const stderrLogger = {
  debug: (_bindings: unknown, _message?: string) => undefined,
  info: (_bindings: unknown, _message?: string) => undefined,
  warn: (bindings: unknown, message?: string) => {
    process.stderr.write(`worker-rulespack warning: ${message ?? ''} ${safe(bindings)}\n`);
  },
  error: (bindings: unknown, message?: string) => {
    process.stderr.write(`worker-rulespack error: ${message ?? ''} ${safe(bindings)}\n`);
  },
};

function safe(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'string'
      ? item.replace(/(authorization|token|secret|password)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
      : item,
  ).slice(0, 2_000);
}
