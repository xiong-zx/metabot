#!/usr/bin/env node
import { MetaClawError } from './errors.js';
import { connectMetaClawStdioServer } from './server.js';
import { createMetaClawRuntime, type MetaClawRuntime } from './runtime.js';

const SERVER = 'metaclaw-mcp';

async function main(): Promise<void> {
  // A misconfigured entry must not appear in a client's tool list at all: it is
  // better for the entry to be absent than present and refusing every call.
  let runtime: MetaClawRuntime;
  try {
    runtime = createMetaClawRuntime();
  } catch (error) {
    // Before a runtime exists there is no redactor to consult, so the only safe
    // thing to print is what this package itself produced. `createMetaClawRuntime`
    // redacts on the way out, so a `MetaClawError` here is already clean; a
    // foreign error at this point may be an fs or JSON failure carrying a path
    // or a file fragment, and neither belongs on an operator's terminal.
    fail(error, undefined);
    return;
  }

  try {
    const server = await connectMetaClawStdioServer(runtime);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await server.close();
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } catch (error) {
    fail(error, runtime);
  }
}

function fail(error: unknown, runtime: MetaClawRuntime | undefined): void {
  process.stderr.write(`${SERVER}: ${describe(error, runtime)}\n`);
  process.exitCode = 1;
}

function describe(error: unknown, runtime: MetaClawRuntime | undefined): string {
  if (error instanceof MetaClawError) {
    return runtime === undefined ? `${error.code}: ${error.message}` : `${error.code}: ${runtime.redact(error.message)}`;
  }
  if (runtime !== undefined) return `internal: ${runtime.redact(error)}`;
  // No redactor and not our error: name the failure, print none of its content.
  return `internal: unredactable ${error instanceof Error ? error.name : typeof error} during startup`;
}

void main();
