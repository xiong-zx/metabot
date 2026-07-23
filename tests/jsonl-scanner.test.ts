import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJsonlScanner } from '../src/engines/claude/pty/jsonl-scanner.js';

const logger = {
  warn: () => {},
} as any;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-jsonl-scanner-'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function line(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

async function nextWithTimeout<T>(iterator: AsyncIterator<T>, ms = 500): Promise<IteratorResult<T>> {
  return Promise.race([
    iterator.next(),
    new Promise<IteratorResult<T>>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for scanner record')), ms);
    }),
  ]);
}

describe('createJsonlScanner', () => {
  it('replays existing records by default', async () => {
    fs.writeFileSync(file, line({ type: 'assistant', id: 'old' }));
    const scanner = createJsonlScanner({ jsonlPath: file, logger, pollMs: 5 });
    const iterator = scanner[Symbol.asyncIterator]();

    await expect(nextWithTimeout(iterator)).resolves.toEqual({
      done: false,
      value: { type: 'assistant', id: 'old' },
    });
    scanner.stop();
  });

  it('starts at EOF on resume and only emits newly appended records', async () => {
    fs.writeFileSync(file, [
      line({ type: 'assistant', id: 'old-question', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } }),
      line({ type: 'assistant', id: 'old-answer' }),
    ].join(''));
    const scanner = createJsonlScanner({ jsonlPath: file, logger, pollMs: 5, startAtEnd: true });
    const iterator = scanner[Symbol.asyncIterator]();

    const next = nextWithTimeout(iterator);
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.appendFileSync(file, line({ type: 'assistant', id: 'new-turn' }));

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: 'assistant', id: 'new-turn' },
    });
    scanner.stop();
  });

  it('drainPending(true) recovers a complete-but-unterminated final record once', async () => {
    const scanner = createJsonlScanner({ jsonlPath: file, logger, pollMs: 5 });

    // A final assistant line written WITHOUT its terminating newline — mimics
    // the end-of-turn race where the Stop hook fires before claude flushes \n.
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', id: 'final-answer' }));

    // Without includePartial the unterminated line stays buffered.
    expect(scanner.drainPending(false)).toEqual([]);

    // With includePartial the final record is recovered.
    expect(scanner.drainPending(true)).toEqual([{ type: 'assistant', id: 'final-answer' }]);

    // When the terminating newline finally lands, it is NOT re-emitted.
    fs.appendFileSync(file, '\n');
    expect(scanner.drainPending(true)).toEqual([]);

    // A genuinely new record after it still comes through normally.
    fs.appendFileSync(file, line({ type: 'assistant', id: 'next-turn' }));
    expect(scanner.drainPending(false)).toEqual([{ type: 'assistant', id: 'next-turn' }]);

    scanner.stop();
  });

  it('drainPending(true) leaves an incomplete (non-JSON) partial buffered', async () => {
    const scanner = createJsonlScanner({ jsonlPath: file, logger, pollMs: 5 });

    // Half-written record (invalid JSON) must not be emitted or consumed.
    fs.writeFileSync(file, '{"type":"assistant","id":"half');
    expect(scanner.drainPending(true)).toEqual([]);

    // Once the rest + newline lands, the completed record is emitted once.
    fs.appendFileSync(file, '-written"}\n');
    expect(scanner.drainPending(false)).toEqual([
      { type: 'assistant', id: 'half-written' },
    ]);

    scanner.stop();
  });

  it('drainPending returns records already read into the iterator batch but not delivered', async () => {
    fs.writeFileSync(file, [
      line({ type: 'assistant', id: 'intermediate' }),
      line({ type: 'assistant', id: 'final-answer' }),
    ].join(''));
    const scanner = createJsonlScanner({ jsonlPath: file, logger, pollMs: 5 });
    const iterator = scanner[Symbol.asyncIterator]();

    await expect(nextWithTimeout(iterator)).resolves.toEqual({
      done: false,
      value: { type: 'assistant', id: 'intermediate' },
    });

    // The second record was read in the same filesystem batch. Previously it
    // lived only in the generator local array, so an end-of-turn drain at EOF
    // returned [] and result could overtake it.
    expect(scanner.drainPending()).toEqual([{ type: 'assistant', id: 'final-answer' }]);
    scanner.stop();
  });
});
