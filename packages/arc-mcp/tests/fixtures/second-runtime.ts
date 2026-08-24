/**
 * Stands in for a second `arc-mcp-service` launched against a data directory that
 * a live daemon already owns. It prints one JSON line so the test can assert on
 * the real refusal instead of on an in-process simulation of it.
 */
import { createArcRuntime } from '../../src/runtime.js';

try {
  const runtime = await createArcRuntime({ env: process.env });
  runtime.coordinator.dispose();
  runtime.store.close();
  process.stdout.write(`${JSON.stringify({ acquired: true })}\n`);
} catch (error) {
  const code = (error as { code?: string }).code;
  process.stdout.write(
    `${JSON.stringify({ acquired: false, code, message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
