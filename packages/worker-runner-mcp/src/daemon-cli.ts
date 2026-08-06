#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  LocalCapabilityVerifier,
  assertDistinctKeys,
  readPrivateKeyFile,
  readPublicKeyFile,
} from './local-auth.js';
import { WorkerRunnerDaemon } from './daemon.js';
import { createWorkerRunnerServiceRuntime, integerEnv, requiredAnyEnv, requiredEnv } from './runtime.js';

const env = process.env;
const capabilityPublicKeyPath = requiredEnv(env, 'METABOT_WORKER_CAPABILITY_PUBLIC_KEY_FILE');
const capabilityPublicKeys = [
  readPublicKeyFile(
    capabilityPublicKeyPath,
    'Worker Runner capability public key',
  ),
];
const previousCapabilityPath =
  env.METABOT_WORKER_CAPABILITY_PREVIOUS_PUBLIC_KEY_FILE?.trim() || `${capabilityPublicKeyPath}.prev`;
if (existsSync(previousCapabilityPath)) {
  capabilityPublicKeys.push(readPublicKeyFile(previousCapabilityPath, 'Previous Worker Runner capability public key'));
}
if (env.METABOT_WORKER_CALLBACK_URL) {
  const callbackPrivateKey = readPrivateKeyFile(
    requiredEnv(env, 'METABOT_WORKER_CALLBACK_PRIVATE_KEY_FILE'),
    'Worker callback private key',
  );
  assertDistinctKeys(capabilityPublicKeys, callbackPrivateKey, [
    'Worker Runner capability',
    'Worker callback signing',
  ]);
}
const runtime = createWorkerRunnerServiceRuntime({ env, dynamicPrincipals: true });
const daemon = new WorkerRunnerDaemon(runtime.service, {
  endpoint: requiredAnyEnv(env, ['METABOT_WORKER_LISTEN', 'METABOT_WORKER_DAEMON_URL']),
  capabilityVerifier: new LocalCapabilityVerifier(capabilityPublicKeys, 'worker'),
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
