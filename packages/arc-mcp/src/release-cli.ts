#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  OFFICIAL_ARC_CONSOLE_SCRIPTS,
  OFFICIAL_ARC_PACKAGE_DIR,
  officialBridgePath,
  officialCompatibilityPath,
  probeOfficialResearchClaw,
} from './official-driver.js';
import {
  installExternalReleaseCandidate,
  verifyExternalReleaseCandidate,
  type CommandResult,
} from './releases/release-manager.js';
import { inspectReleaseDoctor } from './releases/release-doctor.js';
import { applyCliSelector, planCliSelector, readSelectorTarget } from './releases/selector.js';
import {
  defaultReleaseRoot,
  EXTERNAL_RELEASE_SPECS,
  OFFICIAL_RESEARCHCLAW_TAG_SPEC,
  releaseSpecByName,
  specProvenanceClass,
  specRole,
  type ExternalReleaseSpec,
} from './releases/spec.js';

/**
 * Operator release doctor, installer, and selector.
 *
 * Everything here is a deliberate operator action run from a shell. None of it
 * is reachable from the daemon or from an MCP tool: installing a release seals
 * a new immutable directory, and installing a selector writes one POSIX script.
 * Neither starts a daemon, activates an MCP server, edits an existing sealed
 * manifest, removes an older release, or changes the `current` MCP selector —
 * that switch stays behind the separate ARC-008 approval.
 */

const command = process.argv[2] ?? 'doctor';
const releaseRoot = path.resolve(
  process.env.METABOT_ARC_RELEASE_ROOT ?? defaultReleaseRoot(os.homedir()),
);

if (command === 'doctor') {
  const report = await inspectReleaseDoctor({ releaseRoot, execute });
  report.package_dir = OFFICIAL_ARC_PACKAGE_DIR;
  report.bridge = officialBridgePath();
  report.compatibility = officialCompatibilityPath();
  if (report.verified !== true) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (command === 'install') {
  const spec = requireSpec(process.argv[3]);
  const patchSource = patchSourceArgument(process.argv.slice(3), spec);
  const report: Record<string, unknown> = {
    action: 'install',
    release_root: releaseRoot,
    role: specRole(spec),
    provenance_class: specProvenanceClass(spec),
    official: !spec.patch,
    ...(patchSource ? { patch_source: patchSource } : {}),
    pin: describe(spec),
  };
  try {
    const manifest = await installExternalReleaseCandidate(
      {
        root: releaseRoot,
        bootstrapPython: process.env.METABOT_ARC_BOOTSTRAP_PYTHON ?? 'python3',
        bridgePath: officialBridgePath(),
        compatibilityPath: officialCompatibilityPath(),
        acpAgent: process.env.METABOT_ARC_ACP_AGENT ?? 'codex',
        spec,
        ...(patchSource ? { patchSource } : {}),
        packageDirName: OFFICIAL_ARC_PACKAGE_DIR,
        role: specRole(spec),
        sealReadOnly: true,
        consoleScripts: OFFICIAL_ARC_CONSOLE_SCRIPTS,
      },
      {
        execute,
        findCommand,
        probe: probeOfficialResearchClaw,
        now: () => new Date(),
        randomId: () => randomUUID(),
      },
    );
    report.installed = true;
    report.manifest = manifest;
  } catch (error) {
    report.installed = false;
    report.error = message(error);
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (command === 'verify') {
  const spec = requireSpec(process.argv[3]);
  const report: Record<string, unknown> = {
    action: 'verify',
    release_root: releaseRoot,
    role: specRole(spec),
    provenance_class: specProvenanceClass(spec),
    official: !spec.patch,
  };
  try {
    report.manifest = await verifyExternalReleaseCandidate(
      {
        root: releaseRoot,
        bootstrapPython: process.env.METABOT_ARC_BOOTSTRAP_PYTHON ?? 'python3',
        bridgePath: officialBridgePath(),
        compatibilityPath: officialCompatibilityPath(),
        acpAgent: process.env.METABOT_ARC_ACP_AGENT ?? 'codex',
        spec,
        packageDirName: OFFICIAL_ARC_PACKAGE_DIR,
        role: specRole(spec),
      },
      {
        execute,
        findCommand,
        probe: probeOfficialResearchClaw,
        now: () => new Date(),
        randomId: () => randomUUID(),
      },
    );
    report.verified = true;
  } catch (error) {
    report.verified = false;
    report.error = message(error);
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (command === 'selector-plan' || command === 'selector-apply') {
  // The path argument is optional, so an option must never be mistaken for it.
  const positional = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  const selectorPath = path.resolve(
    positional ?? process.env.METABOT_ARC_CLI_SELECTOR ?? path.join(os.homedir(), '.local', 'bin', 'researchclaw'),
  );
  const report: Record<string, unknown> = { action: command, selector_path: selectorPath, release_root: releaseRoot };
  report.current_target = safely(() => readSelectorTarget(selectorPath));
  try {
    const plan = planCliSelector({ selectorPath, releaseRoot, spec: OFFICIAL_RESEARCHCLAW_TAG_SPEC });
    report.plan = plan;
    if (command === 'selector-apply') {
      // Stating the value being replaced turns a concurrent operator change
      // into a conflict instead of a silent overwrite, and the returned
      // previous contents are the exact rollback material.
      const expected = expectedSelectorTarget(process.argv.slice(3));
      const applied = applyCliSelector(plan, expected);
      report.applied = true;
      report.previous_script = applied.previous_script;
      report.previous_symlink_target = applied.previous_symlink_target;
    }
  } catch (error) {
    report.error = message(error);
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const names = Object.keys(EXTERNAL_RELEASE_SPECS).join('|');
  process.stderr.write(
    `metabot-arc-release: unsupported command '${command}'; use ` +
      `'doctor', 'install <${names}> [--patch-source <repo>]', 'verify <${names}>', ` +
      `'selector-plan [path]', or 'selector-apply [path] --expect <target|none>'\n`,
  );
  process.exitCode = 2;
}

function requireSpec(value: string | undefined): ExternalReleaseSpec {
  const spec = value ? releaseSpecByName(value) : undefined;
  if (spec) return spec;
  process.stderr.write(
    `metabot-arc-release: expected one of ${Object.keys(EXTERNAL_RELEASE_SPECS).join(', ')}, got '${value ?? ''}'\n`,
  );
  process.exit(2);
}

/**
 * Where a patched candidate's commits are fetched from.
 *
 * A patched candidate exists in no upstream repository, so there is no source
 * to default to and guessing one would be wrong. The operator must name the
 * local staging clone, and stating it is what makes sealing local patches a
 * deliberate act rather than something that can happen by running a command
 * with no arguments.
 */
function patchSourceArgument(argv: readonly string[], spec: ExternalReleaseSpec): string | undefined {
  const index = argv.indexOf('--patch-source');
  const value = index < 0 ? undefined : argv[index + 1];
  if (!spec.patch) {
    if (value !== undefined) {
      process.stderr.write(
        'metabot-arc-release: --patch-source is only valid for a downstream-patched candidate; an official ' +
          'release is cloned from the origin it pins\n',
      );
      process.exit(2);
    }
    return undefined;
  }
  if (!value || value.startsWith('--')) {
    process.stderr.write(
      `metabot-arc-release: '${spec.releaseIdSuffix ?? 'candidate'}' is a ${specProvenanceClass(spec)} release; ` +
        'pass --patch-source <local-repository> naming the checkout that holds its patch commits\n',
    );
    process.exit(2);
  }
  return path.resolve(value);
}

function expectedSelectorTarget(argv: readonly string[]): string | null {
  const index = argv.indexOf('--expect');
  if (index < 0 || argv[index + 1] === undefined) {
    process.stderr.write(
      "metabot-arc-release: selector-apply requires --expect <target|none> naming the selector it replaces\n",
    );
    process.exit(2);
  }
  const value = argv[index + 1]!;
  return value === 'none' ? null : value;
}

function describe(spec: { repository: string; tag: string; revision: string; version: string }): Record<string, string> {
  return { repository: spec.repository, tag: spec.tag, revision: spec.revision, version: spec.version };
}

function execute(command_: string, args: string[]): CommandResult {
  const result = spawnSync(command_, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function findCommand(name: string): string | undefined {
  const result = spawnSync('command', ['-v', name], { encoding: 'utf8', shell: true });
  const found = (result.stdout ?? '').trim().split('\n')[0]?.trim();
  return result.status === 0 && found ? found : undefined;
}

function safely<T>(read: () => T): T | { error: string } {
  try {
    return read();
  } catch (error) {
    return { error: message(error) };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
