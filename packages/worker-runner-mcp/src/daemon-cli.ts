#!/usr/bin/env node
import { LocalCapabilityAuthority, assertDistinctKeys, readSecretFile } from './local-auth.js';
import { WorkerRunnerDaemon } from './daemon.js';
import { createWorkerRunnerServiceRuntime, integerEnv, requiredAnyEnv, requiredEnv } from './runtime.js';

const env = process.env;
const capabilityKey = readSecretFile(
  requiredEnv(env, 'METABOT_WORKER_CAPABILITY_KEY_FILE'),
  'Worker Runner capability key',
);
if (env.METABOT_WORKER_CALLBACK_URL) {
  const callbackKey = readSecretFile(
    requiredAnyEnv(env, ['METABOT_WORKER_CALLBACK_KEY_FILE', 'METABOT_WORKER_CALLBACK_SIGNING_KEY_FILE']),
    'Worker callback signing key',
  );
  assertDistinctKeys(capabilityKey, callbackKey, ['Worker Runner capability', 'Worker callback signing']);
}
const runtime = createWorkerRunnerServiceRuntime({ env, dynamicPrincipals: true });
const daemon = new WorkerRunnerDaemon(runtime.service, {
  endpoint: requiredAnyEnv(env, ['METABOT_WORKER_LISTEN', 'METABOT_WORKER_DAEMON_URL']),
  capabilityAuthority: new LocalCapabilityAuthority(capabilityKey, 'worker-runner'),
  maxRequestBytes: integerEnv(env, 'METABOT_WORKER_MAX_REQUEST_BYTES', 1_048_576),
  maxStatusOutputChars: integerEnv(env, 'METABOT_WORKER_STATUS_OUTPUT_CHARS', 16_384),
});
for (const stale of runtime.store.lock.staleLocks) {
  process.stderr.write(
    `metabot-worker-runnerd: reclaimed stale data lock from pid ${stale.owner.pid}; diagnostic ${stale.archivePath}\n`,
  );
}
await daemon.start();
process.stderr.write(`metabot-worker-runnerd: listening on ${daemon.url.href}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void daemon.close().finally(() => {
      runtime.service.dispose();
      runtime.store.close();
      process.exit(0);
    });
  });
}
