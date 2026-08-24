import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  parseReleaseManifest,
  releaseIsOfficial,
  releaseProvenanceClass,
  releaseRole,
  safeReleaseIdentifier,
  type ExternalReleaseManifest,
} from './manifest.js';
import { externalReleasePaths } from './release-manager.js';
import { assertReleaseSpecEligible, type ExternalReleaseRole, type ExternalReleaseSpec } from './spec.js';

/**
 * ARC-009: direct, inspectable shell access to one exact official release.
 *
 * The selector is a plain POSIX script that `exec`s the release's own console
 * entry point. It contains no Node, no MetaBot path, no daemon URL, and no
 * client credential: `researchclaw` therefore keeps working with every MCP
 * process stopped, and running it never starts, configures, or activates
 * anything. Selecting a release is an operator action, separate from ARC-008
 * MCP activation.
 */

export const SELECTOR_CONTRACT = 'metabot.autoresearchclaw.cli-selector.v1' as const;

export interface CliSelectorPlan {
  contract: typeof SELECTOR_CONTRACT;
  selector_path: string;
  release_id: string;
  release_root: string;
  release_role: ExternalReleaseRole;
  executable: string;
  commit: string;
  base_tag: string;
  describe: string;
  exact_tag_release: boolean;
  script: string;
  current_target: string | null;
}

export interface ResolvedSelectorRelease {
  releaseId: string;
  executable: string;
  manifest: ExternalReleaseManifest;
}

/**
 * Resolves the console script a sealed release installed into its own
 * virtualenv. The manifest is re-read so a selector can never be pointed at a
 * directory that is not a sealed candidate.
 */
export function resolveSelectorRelease(
  releaseRoot: string,
  spec: ExternalReleaseSpec,
  binaryName = 'researchclaw',
): ResolvedSelectorRelease {
  assertReleaseSpecEligible(spec, 'selected for direct CLI use');
  const paths = externalReleasePaths(releaseRoot, spec);
  const manifest = parseReleaseManifest(paths.manifest);
  const releaseId = safeReleaseIdentifier(manifest.release_id, 'release id');
  if (manifest.commit !== spec.revision || manifest.base_tag !== spec.tag) {
    throw new Error(`Sealed release ${releaseId} is not the requested official revision`);
  }
  // `researchclaw` on PATH is ARC-009's promise that a human gets the exact
  // official application with no MetaBot involvement. A locally patched tree
  // shares the official version and tag, so nothing about the name would
  // reveal the substitution — which is precisely why it is refused here
  // rather than left to the operator to notice.
  if (!releaseIsOfficial(manifest)) {
    throw new Error(
      `Sealed release ${releaseId} is a ${releaseProvenanceClass(manifest)} release and cannot back the direct ` +
        `${binaryName} CLI selector, which must remain exact official code`,
    );
  }
  const executable = path.join(paths.venv, 'bin', safeReleaseIdentifier(binaryName, 'binary name'));
  if (!existsSync(executable) || !lstatSync(executable).isFile()) {
    throw new Error(`Sealed release ${releaseId} does not provide ${binaryName}: ${executable}`);
  }
  return { releaseId, executable, manifest };
}

export function renderCliSelector(release: ResolvedSelectorRelease): string {
  const manifest = release.manifest;
  return [
    '#!/bin/sh',
    `# ${SELECTOR_CONTRACT}`,
    '#',
    `# Official ${manifest.product} ${manifest.version}, pinned by release id.`,
    `#   origin:     ${manifest.origin}`,
    `#   tag:        ${manifest.base_tag} (${manifest.base_tag_commit})`,
    `#   describe:   ${manifest.describe}`,
    `#   commit:     ${manifest.commit}`,
    `#   source:     ${manifest.source_dir}`,
    `#   release_id: ${release.releaseId}`,
    `#   role:       ${releaseRole(manifest)}`,
    `#   exact_tag:  ${manifest.describe === manifest.base_tag ? 'yes' : 'no'}`,
    '#',
    '# This selector is deliberately independent of MetaBot: it starts no daemon,',
    '# activates no MCP server, reads no client credential, and writes no configuration.',
    '# Replace it to roll back to another sealed release.',
    'set -eu',
    `exec ${shellQuote(release.executable)} "$@"`,
    '',
  ].join('\n');
}

export function planCliSelector(options: {
  selectorPath: string;
  releaseRoot: string;
  spec: ExternalReleaseSpec;
  binaryName?: string;
}): CliSelectorPlan {
  const binaryName = options.binaryName ?? 'researchclaw';
  const release = resolveSelectorRelease(options.releaseRoot, options.spec, binaryName);
  return {
    contract: SELECTOR_CONTRACT,
    selector_path: path.resolve(options.selectorPath),
    release_id: release.releaseId,
    release_root: path.resolve(options.releaseRoot),
    release_role: releaseRole(release.manifest),
    executable: release.executable,
    commit: release.manifest.commit,
    base_tag: release.manifest.base_tag,
    describe: release.manifest.describe,
    // `describe` equals the tag only when HEAD is the tagged commit itself.
    exact_tag_release: release.manifest.describe === release.manifest.base_tag,
    script: renderCliSelector(release),
    current_target: readSelectorTarget(path.resolve(options.selectorPath)),
  };
}

export interface AppliedCliSelector {
  plan: CliSelectorPlan;
  /** Exact previous file contents, so a rollback restores byte-for-byte. */
  previous_script: string | null;
  previous_symlink_target: string | null;
}

/**
 * Installs the selector atomically. Never invoked by the daemon or by an MCP
 * tool; the caller must state the target it expects to replace so a concurrent
 * change is a conflict rather than a silent overwrite.
 */
export function applyCliSelector(
  plan: CliSelectorPlan,
  expectedCurrentTarget: string | null,
): AppliedCliSelector {
  const actual = readSelectorTarget(plan.selector_path);
  if (actual !== expectedCurrentTarget) {
    throw new Error(
      `Official CLI selector changed: expected ${expectedCurrentTarget ?? 'none'}, found ${actual ?? 'none'}`,
    );
  }
  let previousScript: string | null = null;
  let previousSymlink: string | null = null;
  if (existsSync(plan.selector_path) || isSymbolicLink(plan.selector_path)) {
    const info = lstatSync(plan.selector_path);
    if (info.isSymbolicLink()) previousSymlink = readlinkSync(plan.selector_path);
    else previousScript = readFileSync(plan.selector_path, 'utf8');
  }
  mkdirSync(path.dirname(plan.selector_path), { recursive: true });
  const temporary = path.join(
    path.dirname(plan.selector_path),
    `.${path.basename(plan.selector_path)}-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, plan.script, { encoding: 'utf8', mode: 0o755, flag: 'wx' });
    renameSync(temporary, plan.selector_path);
  } finally {
    if (existsSync(temporary) || isSymbolicLink(temporary)) unlinkSync(temporary);
  }
  return { plan, previous_script: previousScript, previous_symlink_target: previousSymlink };
}

/**
 * What the selector currently points at, whichever form it takes. A symlink is
 * reported as its raw target and a script as the path it execs, so an existing
 * operator-managed selector is described rather than silently replaced.
 */
export function readSelectorTarget(selectorPath: string): string | null {
  const resolved = path.resolve(selectorPath);
  if (!existsSync(resolved) && !isSymbolicLink(resolved)) return null;
  const info = lstatSync(resolved);
  if (info.isSymbolicLink()) return readlinkSync(resolved);
  if (!info.isFile()) throw new Error(`Official CLI selector is neither a file nor a symlink: ${resolved}`);
  const match = /^exec\s+(.+?)\s+"\$@"\s*$/m.exec(readFileSync(resolved, 'utf8'));
  return match?.[1] ? shellUnquote(match[1]) : 'unrecognized';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellUnquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return trimmed;
  return trimmed.slice(1, -1).replace(/'\\''/g, "'");
}

function isSymbolicLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
