/**
 * PTY backend — JSONL scanner.
 *
 * Tails a Claude session `.jsonl` file, yielding each newly-appended JSON
 * record exactly once in order. Handles:
 *   - file not yet existing (polls until it appears)
 *   - partial trailing line (buffers until newline-terminated)
 *   - clean stop via stop()
 *
 * Uses byte-offset tracking + interval polling (fs.read from last offset).
 */

import { openSync, readSync, statSync, closeSync } from 'node:fs';
import type { CreateJsonlScanner, JsonlScanner, RawJsonlRecord } from './contract.js';

const DEFAULT_POLL_MS = 120;

export const createJsonlScanner: CreateJsonlScanner = ({
  jsonlPath,
  logger,
  pollMs = DEFAULT_POLL_MS,
  startAtEnd = false,
}) => {
  let stopped = false;
  let offset = 0;
  let partialLine = '';
  // Records read in one filesystem poll but not yet handed to the async
  // consumer. Keeping this queue on the scanner object (rather than in the
  // generator's local `records` array) lets drainPending() form a real ordering
  // barrier before a synthesized result.
  const pendingRecords: RawJsonlRecord[] = [];

  function stop(): void {
    stopped = true;
  }

  function fileExists(): boolean {
    try {
      statSync(jsonlPath);
      return true;
    } catch {
      return false;
    }
  }

  function fileSize(): number {
    try {
      return statSync(jsonlPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Read newly appended bytes starting from `offset`, split into lines,
   * parse each complete line as JSON, and yield the records.
   *
   * When `includePartial` is true, a trailing line WITHOUT a terminating
   * newline is also emitted — provided it already parses as a complete JSON
   * record. This is used at end-of-turn (Stop hook) to recover claude's final
   * assistant line before its `\n` has been flushed to disk, so the real answer
   * is ordered ahead of the synthetic `result` instead of being stranded after
   * it. The partial is consumed (offset already at EOF, `partialLine` cleared)
   * so the later poll that sees the real newline does NOT re-emit a duplicate.
   */
  function readNewRecords(includePartial = false): RawJsonlRecord[] {
    const size = fileSize();
    if (size < offset) {
      offset = startAtEnd ? size : 0;
      partialLine = '';
    }

    const records: RawJsonlRecord[] = [];

    if (size > offset) {
      const bytesToRead = size - offset;
      const buf = Buffer.alloc(bytesToRead);

      let fd: number | undefined;
      try {
        fd = openSync(jsonlPath, 'r');
        readSync(fd, buf, 0, bytesToRead, offset);
      } catch (err) {
        logger.warn({ err, jsonlPath }, 'jsonl-scanner: read error');
        return records;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }

      offset = size;
      const chunk = buf.toString('utf8');
      const raw = partialLine + chunk;
      const lines = raw.split('\n');

      // Last element is either '' (chunk ended with \n) or an incomplete line.
      partialLine = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed) as RawJsonlRecord);
        } catch {
          logger.warn({ line: trimmed.slice(0, 120) }, 'jsonl-scanner: malformed JSON line, skipping');
        }
      }
    }

    // End-of-turn final flush: emit a complete-but-unterminated trailing record
    // ONCE, then consume it so the newline-terminated re-read is a no-op.
    if (includePartial) {
      const trimmed = partialLine.trim();
      if (trimmed) {
        try {
          records.push(JSON.parse(trimmed) as RawJsonlRecord);
          partialLine = '';
        } catch {
          // Not a complete record yet — leave it buffered for the next poll.
        }
      }
    }

    return records;
  }

  async function* iterate(): AsyncGenerator<RawJsonlRecord, void, undefined> {
    // Wait for the file to appear.
    while (!stopped && !fileExists()) {
      await sleep(pollMs);
    }
    if (stopped) return;
    if (startAtEnd) {
      offset = fileSize();
      partialLine = '';
    }

    // Main poll loop.
    while (!stopped) {
      pendingRecords.push(...readNewRecords(false));
      while (pendingRecords.length > 0) {
        yield pendingRecords.shift()!;
        if (stopped) return;
      }
      await sleep(pollMs);
    }
  }

  const scanner: JsonlScanner = {
    stop,
    drainPending(includePartial = false): RawJsonlRecord[] {
      const records = pendingRecords.splice(0, pendingRecords.length);
      records.push(...readNewRecords(includePartial));
      return records;
    },
    [Symbol.asyncIterator]() {
      return iterate();
    },
  };

  return scanner;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
