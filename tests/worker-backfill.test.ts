import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backfillWorkerRecords, type WorkerRecord } from '../src/workers/worker-manager.js';

describe('backfillWorkerRecords', () => {
  it('dry-runs terminal worker reconciliation idempotently', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'metabot-worker-backfill-'));
    try {
      const resultsPath = join(workdir, 'results.json');
      writeFileSync(
        resultsPath,
        JSON.stringify({
          task: 'Summarize benchmark deltas',
          metrics: { accuracy: 0.91 },
          notes: 'Recovered from persisted results.',
        }),
      );

      const original: WorkerRecord = {
        id: 'worker-alpha',
        botName: 'research-pm',
        pmChatId: 'pm-chat',
        workerChatId: 'worker-worker-alpha',
        workingDirectory: workdir,
        prompt: 'research worker: write results.json',
        model: 'gpt-5.4',
        engine: 'codex',
        status: 'completed',
        startTime: Date.now() - 1_000,
        endTime: Date.now(),
      };

      const first = backfillWorkerRecords([original]);
      expect(first.updatedRecords[0]).toMatchObject({
        artifactStatus: 'valid_complete',
        contractStatus: 'satisfied',
        detailRoute: '/api/workers/worker-alpha',
        finalPayloadRef: `file://${resultsPath}`,
      });
      expect(first.changes).toEqual([
        expect.objectContaining({
          workerId: 'worker-alpha',
          dryRun: true,
        }),
      ]);
      expect(original.artifactStatus).toBeUndefined();

      const second = backfillWorkerRecords(first.updatedRecords);
      expect(second.updatedRecords).toEqual(first.updatedRecords);
      expect(second.changes).toEqual([]);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('keeps aborted workers with valid artifacts as file-only evidence', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'metabot-worker-backfill-aborted-'));
    try {
      const resultsPath = join(workdir, 'results.json');
      writeFileSync(
        resultsPath,
        JSON.stringify({
          task: 'Summarize benchmark deltas',
          metrics: { accuracy: 0.91 },
          notes: 'Abort happened after the durable file was already written.',
        }),
      );

      const result = backfillWorkerRecords([
        {
          id: 'worker-aborted-artifact',
          botName: 'research-pm',
          pmChatId: 'pm-chat',
          workerChatId: 'worker-worker-aborted',
          workingDirectory: workdir,
          prompt: 'research worker: write results.json',
          model: 'gpt-5.4',
          engine: 'codex',
          status: 'aborted',
          executionStatus: 'aborted',
          startTime: Date.now() - 1_000,
          endTime: Date.now(),
        } satisfies WorkerRecord,
      ]);

      expect(result.updatedRecords[0]).toMatchObject({
        status: 'aborted',
        executionStatus: 'aborted',
        artifactStatus: 'valid_complete',
        contractStatus: 'satisfied',
        deliveryStatus: 'file_only',
        recoveryStatus: 'none',
        artifactPath: resultsPath,
        finalPayloadRef: `file://${resultsPath}`,
      });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
