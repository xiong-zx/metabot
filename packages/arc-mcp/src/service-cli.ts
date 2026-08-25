#!/usr/bin/env node
import { arcRuntimeEnvironment, loadArcProductConfig, readArcProductBearer } from './product-config.js';
import { ArcProductService } from './product-service.js';
import { createArcRuntime, parseBoundedRuntimeArguments } from './runtime.js';

const config = loadArcProductConfig();
const bounded = parseBoundedRuntimeArguments(process.argv.slice(2));
const runtime = await createArcRuntime({
  env: arcRuntimeEnvironment(config),
  ...(bounded ? { bounded } : {}),
});
const service = new ArcProductService(runtime.coordinator, {
  endpoint: config.service_url,
  bearer: readArcProductBearer(config),
});
await service.start();
process.stderr.write(`arc-mcp-service: listening on ${service.url.href}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().finally(() => {
      runtime.coordinator.dispose();
      runtime.store.close();
      process.exit(0);
    });
  });
}
