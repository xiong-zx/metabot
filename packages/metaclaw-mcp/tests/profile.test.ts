import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MetaClawError } from '../src/errors.js';
import { inspectProfilePins, loadMetaClawProfile, REQUIRED_PROFILE_PINS } from '../src/profile.js';
import { cleanupFixtures, createFixture } from './helpers.js';

afterEach(cleanupFixtures);

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof MetaClawError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

function detailsOf(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return (error instanceof MetaClawError ? error.details : undefined) ?? {};
  }
  return {};
}

describe('managed profile', () => {
  it('loads a complete profile and resolves the pinned loopback endpoint', () => {
    const fixture = createFixture();
    const profile = loadMetaClawProfile(fixture.profilePath);
    expect(profile.model.id).toBe('fixture-pinned-model');
    expect(profile.endpoint.hostname).toBe('127.0.0.1');
    expect(profile.endpoint.port).toBe('9412');
    expect(profile.sourcePath).toBe(fixture.profilePath);
  });

  it('fails closed when any required pin is absent', () => {
    for (const key of Object.keys(REQUIRED_PROFILE_PINS)) {
      const fixture = createFixture({
        profileOverrides: (profile) => {
          const pins = { ...profile.pins };
          delete pins[key];
          return { ...profile, pins };
        },
      });
      expect(codeOf(() => loadMetaClawProfile(fixture.profilePath)), `pin ${key}`).toBe('profile_invalid');
      const failed = detailsOf(() => loadMetaClawProfile(fixture.profilePath)).failedPins as Array<{ key: string }>;
      expect(failed.map((pin) => pin.key)).toEqual([key]);
    }
  });

  it('fails closed when a pin is present but contradicts the required value', () => {
    const fixture = createFixture({
      profileOverrides: (profile) => ({
        ...profile,
        pins: { ...profile.pins, 'skills.auto_evolve': true, mode: 'auto' },
      }),
    });
    const failed = detailsOf(() => loadMetaClawProfile(fixture.profilePath)).failedPins as Array<{ key: string }>;
    expect(failed.map((pin) => pin.key).sort()).toEqual(['mode', 'skills.auto_evolve']);
  });

  it('refuses a non-loopback or non-http service endpoint', () => {
    for (const endpoint of ['http://10.0.0.4:9412', 'https://127.0.0.1:9412', 'http://localhost:9412']) {
      const fixture = createFixture({
        profileOverrides: (profile) => ({ ...profile, service: { ...profile.service, endpoint } }),
      });
      expect(codeOf(() => loadMetaClawProfile(fixture.profilePath)), endpoint).toBe('profile_invalid');
    }
  });

  it('refuses relative paths and unknown profile fields', () => {
    const relative = createFixture({
      profileOverrides: (profile) => ({ ...profile, managedHome: 'relative/home' }),
    });
    expect(codeOf(() => loadMetaClawProfile(relative.profilePath))).toBe('profile_invalid');

    const extra = createFixture({
      profileOverrides: (profile) => ({ ...profile, autoStartService: true }),
    });
    expect(codeOf(() => loadMetaClawProfile(extra.profilePath))).toBe('profile_invalid');
  });

  it('refuses a bearer stored inside the shared skills root', () => {
    const fixture = createFixture({
      profileOverrides: (profile) => ({
        ...profile,
        service: { ...profile.service, bearerFile: path.join(profile.skills.root, 'bearer') },
      }),
    });
    expect(codeOf(() => loadMetaClawProfile(fixture.profilePath))).toBe('profile_invalid');
  });

  it('refuses a skills root nested inside the managed HOME', () => {
    const fixture = createFixture({
      profileOverrides: (profile) => ({
        ...profile,
        skills: { ...profile.skills, root: path.join(profile.managedHome, 'skills') },
      }),
    });
    expect(codeOf(() => loadMetaClawProfile(fixture.profilePath))).toBe('profile_invalid');
  });

  it('refuses the reverse nesting and equality of managed HOME and skills root', () => {
    for (const relation of ['parent', 'equal']) {
      const fixture = createFixture({
        profileOverrides: (profile) => ({
          ...profile,
          managedHome: relation === 'equal' ? profile.skills.root : path.join(profile.skills.root, 'nested-home'),
          service: {
            ...profile.service,
            bearerFile: relation === 'equal'
              ? path.join(profile.skills.root, '..', 'bearer-outside')
              : path.join(profile.skills.root, 'nested-home', 'bearer'),
          },
        }),
      });
      expect(codeOf(() => loadMetaClawProfile(fixture.profilePath)), relation).toBe('profile_invalid');
    }
  });

  it('requires explicit local read entry, byte, and deadline limits', () => {
    for (const field of ['localReadDeadlineMs', 'maxLocalEntries', 'maxLocalBytes']) {
      const fixture = createFixture({
        profileOverrides: (profile) => {
          delete profile.limits[field];
          return profile;
        },
      });
      expect(codeOf(() => loadMetaClawProfile(fixture.profilePath)), field).toBe('profile_invalid');
    }
  });

  it('refuses a symlinked, absent, or malformed profile file', () => {
    const fixture = createFixture();
    const link = path.join(fixture.root, 'profile-link.json');
    symlinkSync(fixture.profilePath, link);
    expect(codeOf(() => loadMetaClawProfile(link))).toBe('profile_invalid');
    expect(codeOf(() => loadMetaClawProfile(path.join(fixture.root, 'absent.json')))).toBe('profile_invalid');
    expect(codeOf(() => loadMetaClawProfile('profile.json'))).toBe('profile_invalid');

    const malformed = path.join(fixture.root, 'malformed.json');
    writeFileSync(malformed, '{ not json', { mode: 0o600 });
    chmodSync(malformed, 0o600);
    expect(codeOf(() => loadMetaClawProfile(malformed))).toBe('profile_invalid');
  });

  it('reports every pin, matched and unmatched, for status', () => {
    const report = inspectProfilePins({ mode: 'auto' });
    expect(report).toHaveLength(Object.keys(REQUIRED_PROFILE_PINS).length);
    expect(report.find((pin) => pin.key === 'mode')).toMatchObject({ expected: 'skills_only', actual: 'auto', ok: false });
    expect(report.find((pin) => pin.key === 'rl.enabled')).toMatchObject({ actual: null, ok: false });
  });
});
