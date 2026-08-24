#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { ArcDaemon } from './daemon.js';
import {
  ArcCapabilityVerifier,
  assertArcDistinctKeys,
  readArcPrivateKeyFile,
  readArcPublicKeyFile,
} from './local-auth.js';
import {
  createArcRuntime,
  integerEnv,
  parseBoundedRuntimeArguments,
  requiredAnyEnv,
  requiredEnv,
  type BoundedRuntimeRequest,
} from './runtime.js';

const env = process.env;

// Argv rather than environment on purpose: an exported variable outlives the
// one run it was meant for, and this is the switch that decides whether a
// daemon may launch a locally patched candidate and spend real money. With
// neither flag this is the production daemon it has always been.
let bounded: BoundedRuntimeRequest | undefined;
try {
  bounded = parseBoundedRuntimeArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`metabot-arcd: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
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
const runtime = await createArcRuntime({ env, ...(bounded ? { bounded } : {}) });
if (bounded) {
  process.stderr.write(
    `metabot-arcd: bounded run selected: release ${bounded.specName}, budget policy ${bounded.policyId}\n`,
  );
}
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
