import { realpathSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectReleaseDoctor } from '../src/releases/release-doctor.js';
import { externalReleaseId } from '../src/releases/release-manager.js';
import {
  ARC_HARD_BUDGET_CANDIDATE_SPEC,
  OFFICIAL_RESEARCHCLAW_COMPAT_SPEC,
} from '../src/releases/spec.js';
import { removeDirectory, temporaryDirectory } from './helpers.js';

let root: string;

beforeEach(() => {
  root = realpathSync.native(temporaryDirectory('arc-doctor-'));
});

afterEach(() => removeDirectory(root));

describe('release doctor default pin', () => {
  it('reports the sealed v2 official pairing as verified without selecting current', async () => {
    let resolvedSpec: unknown;
    const report = await inspectReleaseDoctor({
      releaseRoot: root,
      execute: () => ({ status: 0, stdout: '', stderr: '' }),
      resolve: async (options) => {
        resolvedSpec = options.spec;
        return {
          releaseRoot: root,
          releaseId: externalReleaseId(OFFICIAL_RESEARCHCLAW_COMPAT_SPEC),
          python: '/sealed/venv/bin/python3',
          sourceDir: '/sealed/source',
          manifestPath: '/sealed/manifest.json',
          manifest: { commit: OFFICIAL_RESEARCHCLAW_COMPAT_SPEC.revision } as never,
          pairing: {
            driver_pairing: 'current',
            acpx: { executable: '/opt/homebrew/bin/acpx', version: '0.13.0' },
            immutability: { mode: 'recursive-read-only', sealed: ['source', 'venv'], trees: {} },
          } as never,
        };
      },
    });

    expect(resolvedSpec).toBe(OFFICIAL_RESEARCHCLAW_COMPAT_SPEC);
    expect(report).toMatchObject({
      verified: true,
      release_id: '0.5.0-e2e23c93b494-arc-mcp-0.3.0-v2',
      driver_pairing: 'current',
      current_selector: null,
    });
    expect(report.mcp_execution_pin).toMatchObject({
      release_id: '0.5.0-e2e23c93b494-arc-mcp-0.3.0-v2',
      requires_sealed_trees: true,
      supersedes: { release_id: '0.5.0-e2e23c93b494-arc-mcp-0.3.0' },
    });
    expect(report.selectable_specs).toContainEqual(
      expect.objectContaining({
        name: 'hard-budget-candidate',
        release_id: externalReleaseId(ARC_HARD_BUDGET_CANDIDATE_SPEC),
        official: false,
        eligible: true,
      }),
    );
  });

  it('reports verified=false when the same launch verification fails', async () => {
    const report = await inspectReleaseDoctor({
      releaseRoot: root,
      execute: () => ({ status: 0, stdout: '', stderr: '' }),
      resolve: async () => {
        throw new Error('virtualenv tree is writable');
      },
    });
    expect(report).toMatchObject({ verified: false, error: 'virtualenv tree is writable' });
  });
});
