#!/usr/bin/env node
import { ArcDaemon } from './daemon.js';
import { ArcCapabilityAuthority, assertArcDistinctKeys, readArcSecretFile } from './local-auth.js';
import { createArcRuntime, integerEnv, requiredAnyEnv, requiredEnv } from './runtime.js';

const env = process.env;
const capabilityKey = readArcSecretFile(requiredEnv(env, 'METABOT_ARC_CAPABILITY_KEY_FILE'), 'ARC capability key');
if (env.METABOT_ARC_CALLBACK_URL) {
  const callbackKey = readArcSecretFile(
    requiredAnyEnv(env, ['METABOT_ARC_CALLBACK_KEY_FILE', 'METABOT_ARC_CALLBACK_SIGNING_KEY_FILE']),
    'ARC callback signing key',
  );
  assertArcDistinctKeys(capabilityKey, callbackKey);
}
const runtime = await createArcRuntime({ env });
const daemon = new ArcDaemon(runtime.coordinator, {
  endpoint: requiredAnyEnv(env, ['METABOT_ARC_LISTEN', 'METABOT_ARC_DAEMON_URL']),
  capabilityAuthority: new ArcCapabilityAuthority(capabilityKey),
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
