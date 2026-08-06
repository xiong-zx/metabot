#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { ArcDaemon } from './daemon.js';
import {
  ArcCapabilityVerifier,
  assertArcDistinctKeys,
  readArcPrivateKeyFile,
  readArcPublicKeyFile,
} from './local-auth.js';
import { createArcRuntime, integerEnv, requiredAnyEnv, requiredEnv } from './runtime.js';

const env = process.env;
const capabilityPublicKeyPath = requiredEnv(env, 'METABOT_ARC_CAPABILITY_PUBLIC_KEY_FILE');
const capabilityPublicKeys = [
  readArcPublicKeyFile(
    capabilityPublicKeyPath,
    'ARC capability public key',
  ),
];
const previousCapabilityPath =
  env.METABOT_ARC_CAPABILITY_PREVIOUS_PUBLIC_KEY_FILE?.trim() || `${capabilityPublicKeyPath}.prev`;
if (existsSync(previousCapabilityPath)) {
  capabilityPublicKeys.push(readArcPublicKeyFile(previousCapabilityPath, 'Previous ARC capability public key'));
}
if (env.METABOT_ARC_CALLBACK_URL) {
  const callbackPrivateKey = readArcPrivateKeyFile(
    requiredEnv(env, 'METABOT_ARC_CALLBACK_PRIVATE_KEY_FILE'),
    'ARC callback private key',
  );
  assertArcDistinctKeys(capabilityPublicKeys, callbackPrivateKey);
}
const runtime = await createArcRuntime({ env });
const daemon = new ArcDaemon(runtime.coordinator, {
  endpoint: requiredAnyEnv(env, ['METABOT_ARC_LISTEN', 'METABOT_ARC_DAEMON_URL']),
  capabilityVerifier: new ArcCapabilityVerifier(capabilityPublicKeys),
  notifications: runtime.notifications,
  maxRequestBytes: integerEnv(env, 'METABOT_ARC_MAX_REQUEST_BYTES', 1_048_576),
});
for (const stale of runtime.store.lock.staleLocks) {
  process.stderr.write(
    `metabot-arcd: reclaimed stale data lock from pid ${stale.owner.pid}; diagnostic ${stale.archivePath}\n`,
  );
}
await daemon.start();
process.stderr.write(`metabot-arcd: listening on ${daemon.url.href}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void daemon.close().finally(() => {
      runtime.coordinator.dispose();
      runtime.store.close();
      process.exit(0);
    });
  });
}
