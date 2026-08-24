import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import {
  ARC_HITL_CONTRACT_VERSION,
  assertSafeHitlId,
  listPendingHitlRequests,
  writeHitlResponse,
  type ArcHitlSubmitRequest,
} from '../src/hitl.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const RUN_ID = 'run-1';
const RESPONDER = { bot_name: 'memory', chat_id: 'chat-1' };
const NOW = '2026-08-15T00:00:00.000Z';

let parent: string;
let projectRoot: string;
let artifacts: ArcArtifactStore;

function gateDirectory(): string {
  const directory = path.join(projectRoot, '.metabot-arc', 'runs', RUN_ID, 'hitl');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeRequest(requestId: string, overrides: Record<string, unknown> = {}): string {
  const directory = gateDirectory();
  const file = path.join(directory, `${requestId}.request.json`);
  writeFileSync(
    file,
    JSON.stringify({
      contract_version: ARC_HITL_CONTRACT_VERSION,
      request_id: requestId,
      run_id: RUN_ID,
      stage: 'experiment_review',
      prompt: 'Approve the proposed experiment plan?',
      created_at: NOW,
      ...overrides,
    }),
    'utf8',
  );
  return file;
}

function submit(request: ArcHitlSubmitRequest) {
  return writeHitlResponse(artifacts, { projectRoot, runId: RUN_ID }, request, RESPONDER, NOW);
}

beforeEach(() => {
  parent = temporaryDirectory('arc-hitl-');
  projectRoot = projectDirectory(parent);
  artifacts = new ArcArtifactStore();
});

afterEach(() => removeDirectory(parent));

describe('HITL identifier safety', () => {
  it('rejects traversal, separators, and absolute identifiers', () => {
    for (const value of ['..', '../escape', 'a/b', 'a\\b', '/etc/passwd', '.hidden', '', 'a'.repeat(129)]) {
      expect(() => assertSafeHitlId(value, 'request_id')).toThrow(/Unsafe ARC request_id/i);
    }
  });

  it('accepts ordinary gate identifiers', () => {
    expect(assertSafeHitlId('gate-01_v2.a', 'request_id')).toBe('gate-01_v2.a');
  });
});

describe('HITL submission', () => {
  it('writes an atomic decision next to its request', () => {
    writeRequest('gate-1');
    const record = submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'approve', guidance: 'Proceed.' });

    expect(record).toMatchObject({
      contract_version: ARC_HITL_CONTRACT_VERSION,
      request_id: 'gate-1',
      run_id: RUN_ID,
      decision: 'approve',
      guidance: 'Proceed.',
      responder: RESPONDER,
    });
    const written = JSON.parse(readFileSync(path.join(gateDirectory(), 'gate-1.response.json'), 'utf8'));
    expect(written.decision).toBe('approve');
  });

  it('records a rejection without guidance as an explicit null', () => {
    writeRequest('gate-1');
    expect(submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'reject' }).guidance).toBeNull();
  });

  it('refuses a second decision for the same gate', () => {
    writeRequest('gate-1');
    submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'approve' });
    expect(() => submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'reject' })).toThrow(
      /already has a decision/i,
    );
  });

  it('refuses a decision for a gate that does not exist', () => {
    gateDirectory();
    expect(() => submit({ run_id: RUN_ID, request_id: 'missing-gate', decision: 'approve' })).toThrow(
      /request was not found/i,
    );
  });

  it('refuses a decision when the run has no gate directory at all', () => {
    expect(() => submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'approve' })).toThrow(
      /no HITL gate directory/i,
    );
  });

  it('refuses a request id that traverses out of the gate directory', () => {
    gateDirectory();
    expect(() =>
      submit({ run_id: RUN_ID, request_id: '../../../../etc/passwd', decision: 'approve' }),
    ).toThrow(/Unsafe ARC request_id/i);
  });

  it('refuses a run id that traverses out of the project root', () => {
    gateDirectory();
    expect(() =>
      writeHitlResponse(
        artifacts,
        { projectRoot, runId: '../../escape' },
        { run_id: '../../escape', request_id: 'gate-1', decision: 'approve' },
        RESPONDER,
        NOW,
      ),
    ).toThrow(/Unsafe ARC run_id/i);
  });

  it('refuses a symlinked gate directory', () => {
    const outside = path.join(parent, 'outside-gates');
    mkdirSync(outside, { recursive: true });
    mkdirSync(path.join(projectRoot, '.metabot-arc', 'runs', RUN_ID), { recursive: true });
    symlinkSync(outside, path.join(projectRoot, '.metabot-arc', 'runs', RUN_ID, 'hitl'));
    expect(() => submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'approve' })).toThrow(
      /symbolic link/i,
    );
  });

  it('refuses a request whose stored id disagrees with its file name', () => {
    writeRequest('gate-1', { request_id: 'gate-2' });
    expect(() => submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'approve' })).toThrow(
      /does not match its file name/i,
    );
  });

  it('refuses a malformed request record', () => {
    const directory = gateDirectory();
    writeFileSync(path.join(directory, 'gate-1.request.json'), '{"nope": true}', 'utf8');
    expect(() => submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'approve' })).toThrow(
      /does not match the contract/i,
    );
  });
});

describe('pending gate listing', () => {
  it('returns nothing when the run has no gate directory', () => {
    expect(listPendingHitlRequests(artifacts, { projectRoot, runId: RUN_ID })).toEqual([]);
  });

  it('lists only gates that have no decision yet', () => {
    writeRequest('gate-1');
    writeRequest('gate-2');
    submit({ run_id: RUN_ID, request_id: 'gate-1', decision: 'approve' });

    const pending = listPendingHitlRequests(artifacts, { projectRoot, runId: RUN_ID });
    expect(pending.map((entry) => entry.request_id)).toEqual(['gate-2']);
  });

  it('ignores files whose names are not safe gate identifiers', () => {
    const directory = gateDirectory();
    writeFileSync(path.join(directory, '..unsafe.request.json'), '{}', 'utf8');
    expect(listPendingHitlRequests(artifacts, { projectRoot, runId: RUN_ID })).toEqual([]);
  });
});
