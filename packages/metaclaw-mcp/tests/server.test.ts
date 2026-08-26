import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MetaClawError } from '../src/errors.js';
import { assertReturnedModelProvider, prepareInference } from '../src/infer.js';
import { createMetaClawRuntime, type MetaClawRuntime } from '../src/runtime.js';
import { METACLAW_TOOL_NAMES, runHealth, runInfer, runSkillGet, runSkillsList, runStatus } from '../src/tools.js';
import { createMetaClawMcpServer } from '../src/server.js';
import {
  ALL_GATES_SATISFIED,
  cleanupFixtures,
  createFixture,
  fakeService,
  jsonResponse,
  writeSkill,
  type FixtureOptions,
  type RecordedRequest,
} from './helpers.js';

afterEach(cleanupFixtures);

interface Harness {
  runtime: MetaClawRuntime;
  requests: RecordedRequest[];
  fixture: ReturnType<typeof createFixture>;
}

function harness(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
  options: FixtureOptions = {},
): Harness {
  const fixture = createFixture(options);
  const service = fakeService(respond);
  const runtime = acceptMclaw015Fixture(
    createMetaClawRuntime({ env: fixture.env, fetchImpl: service.fetchImpl }),
    options,
  );
  return {
    fixture,
    requests: service.requests,
    runtime,
  };
}

/** Exercise downstream inference mechanics without adding a production bypass. */
function acceptMclaw015Fixture(runtime: MetaClawRuntime, options: FixtureOptions): MetaClawRuntime {
  if (options.gates?.['MCLAW-015']?.evidence !== '__EXACT_FIXTURE_MCLAW-015__') return runtime;
  return {
    ...runtime,
    gates: runtime.gates.map((gate) => gate.id === 'MCLAW-015'
      ? { ...gate, satisfied: true, evidence: 'fixture-only bounded acceptance' }
      : gate),
  };
}

/** A factory, not a value: a Response body can only be read once. */
const completion = (): Response =>
  jsonResponse({
    model: 'fixture-pinned-model',
    provider: 'fixture-provider',
    choices: [{ message: { role: 'assistant', content: 'fixture answer' } }],
  });

async function dispatch(runtime: MetaClawRuntime, input = { messages: [{ role: 'user' as const, content: 'hi' }] }) {
  const prepared = prepareInference(runtime.profile, input);
  const response = await runtime.client.createCompletion({
    body: prepared.body,
    headers: prepared.headers,
    deadlineMs: prepared.deadlineMs,
  });
  assertReturnedModelProvider(response.json, runtime.profile);
  return { prepared, response };
}

async function failureOf(run: () => unknown): Promise<{ code: string; details: unknown }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MetaClawError) return { code: error.code, details: error.details };
    return { code: `unexpected:${String(error)}`, details: undefined };
  }
  return { code: 'no-error', details: undefined };
}

describe('tool surface', () => {
  it('exposes exactly five tools and nothing that mutates the service', async () => {
    const { runtime } = harness(completion, { gates: ALL_GATES_SATISFIED });
    const server = createMetaClawMcpServer(runtime);
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );

    expect(registered.sort()).toEqual([...METACLAW_TOOL_NAMES].sort());
    expect(registered).toHaveLength(5);
    for (const forbidden of [
      'start',
      'stop',
      'restart',
      'setup',
      'uninstall',
      'train',
      'memory',
      'config',
      'auth',
      'promote',
      'write',
      'delete',
      'evolve',
    ]) {
      expect(
        registered.some((name) => name.includes(forbidden)),
        forbidden,
      ).toBe(false);
    }
  });
});

describe('metaclaw_health', () => {
  it('probes without starting anything and reports release identity', async () => {
    const { runtime, requests } = harness(() => jsonResponse({ status: 'ok', version: '0.4.1' }));
    const result = await runHealth(runtime);

    expect(result).toMatchObject({
      reachable: true,
      httpStatus: 200,
      autoStart: 'never',
      integrity: {
        checked: false,
        reason: 'Use metaclaw_status for bounded release-integrity verification.',
      },
    });
    expect(result.release).toMatchObject({ official: false, tag: 'v0.4.1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:9412/healthz' });
  });

  it('reports an unreachable service as structured, not as an exception', async () => {
    const { runtime } = harness(() => {
      throw new Error('ECONNREFUSED 127.0.0.1:9412');
    });
    const result = await runHealth(runtime);
    expect(result.reachable).toBe(false);
    expect(result.error).toMatchObject({ code: 'service_unavailable', retryable: true });
  });

  it('does not hash the release during a reachability-only health probe', async () => {
    const { runtime, fixture, requests } = harness(() => jsonResponse({ status: 'ok' }));
    const releaseFile = fixture.releaseFile;
    chmodSync(releaseFile, 0o644);
    writeFileSync(releaseFile, 'drifted after startup\n');
    chmodSync(releaseFile, 0o444);

    const health = await runHealth(runtime);
    expect(health).toMatchObject({
      reachable: true,
      integrity: { checked: false },
    });
    expect(requests).toHaveLength(1);

    const status = await runStatus(runtime);
    expect(status.release).toMatchObject({ integrityOk: false, driftCount: 1 });
  });

  it('reports a refused bearer as unauthenticated rather than unavailable', async () => {
    const { runtime } = harness(() => jsonResponse({ error: 'unauthorized' }, 401));
    expect((await runHealth(runtime)).error).toMatchObject({ code: 'unauthenticated', retryable: false });
  });
});

describe('metaclaw_status', () => {
  it('reports pins, gates, limitations and skills digests without any secret', async () => {
    const { runtime, fixture } = harness(completion);
    writeSkill(fixture.skillsRoot, 'research', '# Research\n');

    const status = await runStatus(runtime);
    const serialized = JSON.stringify(status);

    expect((status.release as Record<string, unknown>).official).toBe(false);
    expect((status.profile as Record<string, unknown>).bindHost).toBe('127.0.0.1');
    expect((status.profile as any).pins.every((pin: { ok: boolean }) => pin.ok)).toBe(true);
    expect(status.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'MCLAW-COST-LEDGER', satisfied: true, evidence: 'mechanical:cost-ledger-v1' }),
      expect.objectContaining({ id: 'MCLAW-011', satisfied: false }),
    ]));
    expect((status.limitations as Array<{ id: string }>).map((item) => item.id)).toContain('streaming');
    expect((status.skills as any).activeDigests).toEqual([
      { name: 'research', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);

    const bearer = readFileSync(fixture.bearerPath, 'utf8').trim();
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain(fixture.bearerPath);
  });

  it('fails startup when the exact managed skills path is missing', () => {
    expect(() =>
      harness(completion, {
        profileOverrides: (profile) => ({
          ...profile,
          skills: { ...profile.skills, root: path.join(profile.profileRoot, 'absent-skills') },
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: 'profile_invalid' }));
  });

  it('shares one local-read budget and reports status truncation truthfully', async () => {
    const { runtime, fixture } = harness(completion, {
      profileOverrides: (profile) => ({
        ...profile,
        limits: { ...profile.limits, maxLocalEntries: 8 },
      }),
    });
    writeSkill(fixture.skillsRoot, 'research', '# Research\n');
    const status = await runStatus(runtime);
    expect(status.release).toMatchObject({ complete: true, integrityOk: true });
    expect(status.skills).toMatchObject({
      readable: true,
      complete: false,
      truncation: { reason: 'entry_limit', limit: 8 },
    });
  });
});

describe('metaclaw_infer', () => {
  it('refuses while any dependency gate is open, before forming a request', async () => {
    const { runtime, requests } = harness(completion);
    const failure = await failureOf(() => runInfer(runtime, { messages: [{ role: 'user', content: 'hi' }] }));

    expect(failure.code).toBe('limitation_gated');
    expect((failure.details as any).openGates.map((gate: { id: string }) => gate.id)).toEqual([
      'MCLAW-011',
      'MCLAW-010',
      'MCLAW-012',
      'MCLAW-014',
      'MCLAW-015',
    ]);
    expect(requests).toHaveLength(0);
  });

  it('refuses startup when MCLAW-014 claims satisfaction without sealed ARC evidence', () => {
    expect(() =>
      harness(completion, {
        gates: {
          'MCLAW-014': { satisfied: true, evidence: 'wired' },
        },
      }),
    ).toThrow(/MCLAW-014 cannot be satisfied without a sealed ARC evidence manifest/);
  });

  it('keeps MCLAW-015 mechanically open despite profile text claiming acceptance', async () => {
    const fixture = createFixture({ gates: ALL_GATES_SATISFIED });
    const service = fakeService(completion);
    const runtime = createMetaClawRuntime({ env: fixture.env, fetchImpl: service.fetchImpl });
    const failure = await failureOf(() => runInfer(runtime, { messages: [{ role: 'user', content: 'hi' }] }));

    expect((failure.details as any).openGates.map((gate: { id: string }) => gate.id)).toEqual(['MCLAW-015']);
    expect(service.requests).toHaveLength(0);
  });

  it('atomically reserves cost before constructing the pinned non-streaming request', async () => {
    const { runtime, requests } = harness(completion, { gates: ALL_GATES_SATISFIED });
    const input = {
      messages: [{ role: 'user', content: 'hi' }],
      controls: { model: 'expensive-model', stream: true, session_id: 'someone-elses-session' },
    } as const;
    const result = await runInfer(runtime, input);
    const prepared = prepareInference(runtime.profile, input);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe('http://127.0.0.1:9412/v1/chat/completions');
    expect(request.headers['x-turn-type']).toBe('side');
    expect(request.headers['x-session-id']).toMatch(/^metaclaw-side-/);
    expect(request.headers.authorization).toBe('Bearer test-bearer');

    const body = JSON.parse(request.body!);
    expect(body.model).toBe('fixture-pinned-model');
    expect(body.stream).toBe(false);
    expect(body.session_id).toBeUndefined();
    expect(request.body).not.toContain('expensive-model');
    expect(request.body).not.toContain('someone-elses-session');

    expect(prepared.strippedControls).toEqual(['model', 'session_id', 'stream']);
    expect(result.cost).toMatchObject({
      reserved_output_tokens: runtime.profile.limits.maxOutputTokens,
      policy: 'worst_case_charged_before_dispatch',
    });
  });

  it('gives concurrent prepared calls distinct session ids', async () => {
    const { runtime } = harness(completion, { gates: ALL_GATES_SATISFIED });
    const sessions = [1, 2, 3, 4].map(
      () => prepareInference(runtime.profile, { messages: [{ role: 'user', content: 'hi' }] }).sessionId,
    );
    expect(new Set(sessions).size).toBe(4);
  });

  it('keeps inference integrity-gated before release drift can dispatch', async () => {
    const { runtime, fixture, requests } = harness(completion, { gates: ALL_GATES_SATISFIED });
    const releaseFile = fixture.releaseFile;
    chmodSync(releaseFile, 0o644);
    writeFileSync(releaseFile, 'print("tampered")\n');
    chmodSync(releaseFile, 0o444);

    const failure = await failureOf(() => runInfer(runtime, { messages: [{ role: 'user', content: 'hi' }] }));
    expect(failure.code).toBe('integrity_drift');
    expect(requests).toHaveLength(0);
  });

  it('maps service outcomes onto the closed error domain', async () => {
    for (const [status, code] of [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [500, 'provider_error'],
      [400, 'contract_violation'],
    ] as const) {
      const { runtime } = harness(() => jsonResponse({ error: 'x' }, status), { gates: ALL_GATES_SATISFIED });
      expect((await failureOf(() => dispatch(runtime))).code, `${status}`).toBe(code);
    }
  });

  it('reports a deadline overrun as deadline_exceeded with cancellation stated as unsupported', async () => {
    const fixture = createFixture({
      gates: ALL_GATES_SATISFIED,
      profileOverrides: (profile) => ({ ...profile, limits: { ...profile.limits, deadlineMs: 20 } }),
    });
    const service = fakeService(() => new Promise<Response>(() => undefined));
    const runtime = acceptMclaw015Fixture(
      createMetaClawRuntime({ env: fixture.env, fetchImpl: service.fetchImpl }),
      { gates: ALL_GATES_SATISFIED },
    );

    const failure = await failureOf(() => dispatch(runtime));
    expect(failure.code).toBe('deadline_exceeded');
    expect((failure.details as any).upstreamCancellation).toBe('unsupported');
  });

  it('reports an unparseable answer as a contract violation', async () => {
    const { runtime } = harness(
      () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      { gates: ALL_GATES_SATISFIED },
    );
    expect((await failureOf(() => dispatch(runtime))).code).toBe('contract_violation');
  });

  it('refuses outbound headers and body fields outside the service allowlists', async () => {
    const { runtime, requests } = harness(completion);
    const prepared = prepareInference(runtime.profile, { messages: [{ role: 'user', content: 'hi' }] });
    expect(
      (
        await failureOf(() =>
          runtime.client.createCompletion({
            body: { ...prepared.body, user: 'caller-controlled' },
            headers: prepared.headers,
            deadlineMs: prepared.deadlineMs,
          }),
        )
      ).code,
    ).toBe('invalid_request');
    expect(
      (
        await failureOf(() =>
          runtime.client.createCompletion({
            body: prepared.body,
            headers: { ...prepared.headers, 'x-debug': 'please echo me' },
            deadlineMs: prepared.deadlineMs,
          }),
        )
      ).code,
    ).toBe('invalid_request');
    expect(requests).toHaveLength(0);
  });
});

describe('read-only skills tools', () => {
  it('lists and fetches without mutating, and marks itself read-only', async () => {
    const { runtime, fixture } = harness(completion);
    writeSkill(fixture.skillsRoot, 'research', '# Research\n');

    const listed = await runSkillsList(runtime);
    expect(listed).toMatchObject({ readOnly: true, writer: 'arc', activeCount: 1, quarantinedCount: 0 });

    const fetched = await runSkillGet(runtime, { name: 'research' });
    expect(fetched).toMatchObject({ readOnly: true, content: '# Research\n' });
    expect((fetched.provenance as any).writer).toBe('arc');
  });

  it('remains usable while a dependency gate is open, unlike inference', async () => {
    const { runtime, fixture } = harness(completion);
    writeSkill(fixture.skillsRoot, 'research', '# Research\n');
    await expect(runSkillsList(runtime)).resolves.toMatchObject({ readOnly: true });
    expect((await failureOf(() => runInfer(runtime, { messages: [{ role: 'user', content: 'hi' }] }))).code).toBe(
      'limitation_gated',
    );
  });
});

describe('managed-state drift', () => {
  it('fails every network-capable tool closed when the profile or protected config drifts', async () => {
    const profileDrift = harness(completion, { gates: ALL_GATES_SATISFIED });
    const profile = JSON.parse(readFileSync(profileDrift.fixture.profilePath, 'utf8'));
    profile.model.id = 'changed-after-startup';
    writeFileSync(profileDrift.fixture.profilePath, JSON.stringify(profile), { mode: 0o600 });
    chmodSync(profileDrift.fixture.profilePath, 0o600);
    expect((await failureOf(() => runHealth(profileDrift.runtime))).code).toBe('integrity_drift');
    expect(profileDrift.requests).toHaveLength(0);

    const configDrift = harness(completion, { gates: ALL_GATES_SATISFIED });
    writeFileSync(configDrift.runtime.profile.service.configFile, '{"drift":true}\n', { mode: 0o600 });
    chmodSync(configDrift.runtime.profile.service.configFile, 0o600);
    expect(
      (await failureOf(() => runInfer(configDrift.runtime, { messages: [{ role: 'user', content: 'hi' }] }))).code,
    ).toBe('integrity_drift');
    expect(configDrift.requests).toHaveLength(0);

    const arcEvidenceDrift = harness(completion, { gates: ALL_GATES_SATISFIED });
    const originalArcManifest = readFileSync(arcEvidenceDrift.fixture.arcManifestPath, 'utf8');
    chmodSync(arcEvidenceDrift.fixture.arcManifestPath, 0o644);
    writeFileSync(arcEvidenceDrift.fixture.arcManifestPath, `${originalArcManifest} `, { mode: 0o444 });
    chmodSync(arcEvidenceDrift.fixture.arcManifestPath, 0o444);
    expect(
      (await failureOf(() => runInfer(arcEvidenceDrift.runtime, { messages: [{ role: 'user', content: 'hi' }] }))).code,
    ).toBe('integrity_drift');
    expect(arcEvidenceDrift.requests).toHaveLength(0);
  });

  it('fails status closed when linked superseded evidence changes', async () => {
    const { runtime } = harness(completion);
    writeFileSync(runtime.manifest.supersedes!.manifestPath, '{"changed":true}\n', { mode: 0o600 });
    const failure = await failureOf(() => runStatus(runtime));
    expect(failure.code).toBe('integrity_drift');
  });
});

describe('runtime startup', () => {
  it('requires every environment variable to be an absolute path', async () => {
    for (const variable of [
      'METACLAW_MCP_PROFILE_FILE',
      'METACLAW_MCP_RELEASE_MANIFEST',
    ]) {
      const fixture = createFixture();
      expect(
        (await failureOf(() => createMetaClawRuntime({ env: { ...fixture.env, [variable]: 'relative/path' } }))).code,
        variable,
      ).toBe('profile_invalid');
      expect(
        (await failureOf(() => createMetaClawRuntime({ env: { ...fixture.env, [variable]: '' } }))).code,
        variable,
      ).toBe('profile_invalid');
    }
  });

  it('refuses a release root nested in either managed mutable root', async () => {
    const fixture = createFixture({
      manifestOverrides: (manifest) => ({ ...manifest, root: path.dirname(manifest.root) }),
    });
    expect((await failureOf(() => createMetaClawRuntime({ env: fixture.env }))).code).toBe('profile_invalid');
  });

  it('pairs the profile to the exact manifest and sealed console executable', async () => {
    const wrongRelease = createFixture({
      profileOverrides: (profile) => ({
        ...profile,
        release: { ...profile.release, releaseId: 'different-release' },
      }),
    });
    expect((await failureOf(() => createMetaClawRuntime({ env: wrongRelease.env }))).code).toBe('profile_invalid');

    const wrongExecutable = createFixture({
      profileOverrides: (profile) => ({
        ...profile,
        service: {
          ...profile.service,
          process: { ...profile.service.process, executable: profile.service.configFile },
        },
      }),
    });
    expect((await failureOf(() => createMetaClawRuntime({ env: wrongExecutable.env }))).code).toBe('profile_invalid');
  });
});
