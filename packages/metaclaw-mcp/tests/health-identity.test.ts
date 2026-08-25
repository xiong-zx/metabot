import { afterEach, describe, expect, it } from 'vitest';

import { SERVICE_BEARER_SURFACE } from '../src/gates.js';
import { createMetaClawRuntime } from '../src/runtime.js';
import { runHealth, runStatus } from '../src/tools.js';
import {
  ALL_GATES_SATISFIED,
  cleanupFixtures,
  createFixture,
  fakeService,
  jsonResponse,
  type FixtureOptions,
  type RecordedRequest,
} from './helpers.js';

afterEach(cleanupFixtures);

const BEARER = 'test-bearer';

function harness(respond: (request: RecordedRequest) => Response | Promise<Response>, options: FixtureOptions = {}) {
  const fixture = createFixture(options);
  const service = fakeService(respond);
  return {
    fixture,
    requests: service.requests,
    runtime: createMetaClawRuntime({ env: fixture.env, fetchImpl: service.fetchImpl }),
  };
}

const CANDIDATE_RELEASE_ID = '0.4.1+mcpsec.2-396ff44';
const pinned = () => jsonResponse({ status: 'ok', release_id: CANDIDATE_RELEASE_ID });

/**
 * A probe spends a credential to learn something a TCP connect already tells
 * you. While the gate covering the bearer is open, the process on that port is
 * not known to be the service the bearer was minted for, so the bearer does not
 * go — and nothing that port says about itself is repeated as identity.
 */
describe('service bearer withholding', () => {
  it('sends no authorization while the identity gate is open', async () => {
    const { runtime, requests } = harness(pinned);
    const result = await runHealth(runtime);

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].headers)).not.toContain('authorization');
    expect(JSON.stringify(requests[0].headers)).not.toContain(BEARER);
    expect(result.credential).toEqual({ bearerPresented: false, withheldFor: ['MCLAW-011'] });
  });

  it('presents the bearer only once that gate carries evidence', async () => {
    const { runtime, requests } = harness(pinned, { gates: ALL_GATES_SATISFIED });
    const result = await runHealth(runtime);

    expect(requests[0].headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(result.credential).toEqual({ bearerPresented: true, withheldFor: [] });
  });

  it('names the bearer surface on the gate that covers it', async () => {
    const { runtime } = harness(pinned);
    const gate = runtime.gates.find((entry) => entry.id === 'MCLAW-011');
    expect(gate?.gates).toContain(SERVICE_BEARER_SURFACE);
    expect(((await runStatus(runtime)).profile as any).serviceBearerWithheldFor).toEqual(['MCLAW-011']);
  });

  it('still answers the reachability question without the credential', async () => {
    const { runtime } = harness(pinned);
    expect(await runHealth(runtime)).toMatchObject({ reachable: true, httpStatus: 200 });
  });
});

describe('endpoint identity pinning', () => {
  it('reports a matched pin without echoing the response', async () => {
    const { runtime } = harness(pinned);
    const result = await runHealth(runtime);
    expect(result.serviceIdentity).toEqual({
      state: 'matched',
      pinnedField: 'release_id',
      reason: 'The probe reported the pinned release_id.',
    });
    expect(result.serviceIdentity).not.toHaveProperty('observed');
  });

  it('reports a mismatch rather than adopting what the port claims to be', async () => {
    const { runtime } = harness(() => jsonResponse({ release_id: 'something-else-entirely' }));
    const result = await runHealth(runtime);

    expect(result.serviceIdentity.state).toBe('mismatch');
    // Local manifest identity is unchanged: the port does not get to relabel it.
    expect(result.release.releaseId).toBe(CANDIDATE_RELEASE_ID);
    expect(JSON.stringify(result)).not.toContain('something-else-entirely');
  });

  it('never echoes an unauthenticated probe body, even on mismatch', async () => {
    const { runtime } = harness(() =>
      jsonResponse({ release_id: '"><script>alert(1)</script>', extra: 'attacker chosen' }),
    );
    const result = await runHealth(runtime);
    expect(result.serviceIdentity.state).toBe('mismatch');
    expect(result.serviceIdentity.observed).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('attacker chosen');
    expect(JSON.stringify(result)).not.toContain('<script>');
  });

  it('carries a bounded observed value only from an authenticated probe', async () => {
    const { runtime } = harness(() => jsonResponse({ release_id: 'x'.repeat(500) }), {
      gates: ALL_GATES_SATISFIED,
    });
    const result = await runHealth(runtime);
    expect(result.serviceIdentity.state).toBe('mismatch');
    expect(result.serviceIdentity.observed?.length).toBe(120);
  });

  it('reports an absent pinned field rather than falling back to anything else', async () => {
    const { runtime } = harness(() => jsonResponse({ status: 'ok', version: '9.9.9' }));
    const result = await runHealth(runtime);
    expect(result.serviceIdentity).toMatchObject({ state: 'absent', pinnedField: 'release_id' });
    expect(JSON.stringify(result)).not.toContain('9.9.9');
  });

  it('reports a non-JSON probe body as absent, not as identity', async () => {
    const { runtime } = harness(() => new Response('not json at all', { status: 200 }));
    expect((await runHealth(runtime)).serviceIdentity).toMatchObject({ state: 'absent' });
  });

  it('marks an unreachable service unverified rather than guessing', async () => {
    const { runtime } = harness(() => {
      throw new Error('ECONNREFUSED 127.0.0.1:9412');
    });
    const result = await runHealth(runtime);
    expect(result.serviceIdentity.state).toBe('unverified');
    expect(result.reachable).toBe(false);
  });

  it('requires the profile to state a pin or to state why there is none', () => {
    expect(() =>
      createMetaClawRuntime({
        env: createFixture({
          profileOverrides: (profile) => {
            delete profile.service.identity;
            return profile;
          },
        }).env,
      }),
    ).toThrow(/pinned schema/);
  });

  it('refuses an unpinned identity for the sealed downstream candidate', () => {
    expect(() =>
      harness(pinned, {
        profileOverrides: (profile) => {
          profile.service.identity = { source: 'unpinned', reason: 'candidate identity deliberately omitted' };
          return profile;
        },
      }),
    ).toThrow(/exact release identity pin/);
  });

  it('refuses an unpinned identity that gives no reason', () => {
    expect(() =>
      createMetaClawRuntime({
        env: createFixture({
          profileOverrides: (profile) => {
            profile.service.identity = { source: 'unpinned' };
            return profile;
          },
        }).env,
      }),
    ).toThrow(/pinned schema/);
  });

  it('reports the pin in status without reporting an observation', async () => {
    const { runtime } = harness(pinned);
    expect(((await runStatus(runtime)).profile as any).endpointIdentityPin).toEqual({
      source: 'health_body',
      field: 'release_id',
      expect: CANDIDATE_RELEASE_ID,
    });
  });
});
