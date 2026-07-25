import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CODEX_SANDBOX,
  DEGRADED_CODEX_SANDBOX,
  probeCodexSandboxSupport,
  resetCodexSandboxSupportForTests,
  resolveDefaultCodexSandbox,
  setCodexSandboxSupportForTests,
} from '../src/engines/codex/sandbox-support.js';
import { buildCodexArgs } from '../src/engines/codex/executor.js';

/**
 * `--sandbox workspace-write` needs unprivileged user namespaces. Hosts that
 * forbid them (this project's AutoDL containers) fail every Codex write with
 * `bwrap: No permissions to create new namespace`, so the *default* mode is
 * probed rather than hard-coded. Explicit configuration must always win.
 */

afterEach(() => {
  resetCodexSandboxSupportForTests();
});

const NAMESPACE_FAILURE =
  'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.';

describe('probeCodexSandboxSupport', () => {
  it('reports available when the bwrap namespace smoke test succeeds', () => {
    const run = vi.fn().mockReturnValue({ status: 0, stderr: '' });
    const support = probeCodexSandboxSupport({ platform: 'linux', run });

    expect(support).toEqual({ available: true, probe: 'bwrap' });
    expect(run.mock.calls[0][0]).toBe('bwrap');
    expect(run.mock.calls[0][1]).toContain('--unshare-user');
  });

  it('reports unavailable, with the reason, when bwrap cannot unshare', () => {
    const run = vi.fn().mockReturnValue({ status: 1, stderr: NAMESPACE_FAILURE });
    const support = probeCodexSandboxSupport({ platform: 'linux', run });

    expect(support.available).toBe(false);
    expect(support.probe).toBe('bwrap');
    expect(support.reason).toBe(NAMESPACE_FAILURE);
  });

  it('falls back to `unshare -Ur` when bwrap is not installed', () => {
    const run = vi.fn((command: string) =>
      command === 'bwrap' ? undefined : { status: 1, stderr: 'unshare: unshare failed: Operation not permitted' },
    );
    const support = probeCodexSandboxSupport({ platform: 'linux', run });

    expect(support.available).toBe(false);
    expect(support.probe).toBe('unshare');
  });

  it('assumes available when no probe tool exists — never degrade on a guess', () => {
    const run = vi.fn().mockReturnValue(undefined);
    const support = probeCodexSandboxSupport({ platform: 'linux', run });

    expect(support).toEqual({ available: true, probe: 'none' });
  });

  it('does not probe bwrap on non-Linux hosts (macOS uses Seatbelt)', () => {
    const run = vi.fn();
    const support = probeCodexSandboxSupport({ platform: 'darwin', run });

    expect(support).toEqual({ available: true, probe: 'non-linux' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('resolveDefaultCodexSandbox', () => {
  it('keeps workspace-write when namespaces work', () => {
    setCodexSandboxSupportForTests({ available: true, probe: 'bwrap' });
    const logger = { warn: vi.fn() };

    expect(resolveDefaultCodexSandbox(logger)).toBe(DEFAULT_CODEX_SANDBOX);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('degrades to danger-full-access and warns once when namespaces are unavailable', () => {
    setCodexSandboxSupportForTests({ available: false, probe: 'bwrap', reason: NAMESPACE_FAILURE });
    const logger = { warn: vi.fn() };

    expect(resolveDefaultCodexSandbox(logger)).toBe(DEGRADED_CODEX_SANDBOX);
    expect(resolveDefaultCodexSandbox(logger)).toBe(DEGRADED_CODEX_SANDBOX);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.warn.mock.calls[0];
    expect(fields).toMatchObject({ engine: 'codex', probe: 'bwrap', reason: NAMESPACE_FAILURE });
    expect(message).toContain('danger-full-access');
    expect(message).toContain('CODEX_SANDBOX');
  });
});

describe('buildCodexArgs sandbox default', () => {
  const cwd = '/work/proj';
  const prompt = 'run pwd';

  function sandboxArg(args: string[]): string | undefined {
    const index = args.indexOf('--sandbox');
    return index === -1 ? undefined : args[index + 1];
  }

  it('uses workspace-write when the host supports namespaces', () => {
    setCodexSandboxSupportForTests({ available: true, probe: 'bwrap' });

    expect(sandboxArg(buildCodexArgs({}, cwd, prompt, undefined, undefined))).toBe('workspace-write');
  });

  it('falls back to danger-full-access when the host cannot sandbox', () => {
    setCodexSandboxSupportForTests({ available: false, probe: 'bwrap', reason: NAMESPACE_FAILURE });

    expect(sandboxArg(buildCodexArgs({}, cwd, prompt, undefined, undefined))).toBe('danger-full-access');
  });

  it('never overrides an explicitly configured sandbox', () => {
    setCodexSandboxSupportForTests({ available: false, probe: 'bwrap', reason: NAMESPACE_FAILURE });

    // This is also the `CODEX_SANDBOX` path: src/config.ts copies that env var
    // straight into codexConfig.sandbox before the executor ever sees it.
    expect(sandboxArg(buildCodexArgs({ sandbox: 'workspace-write' }, cwd, prompt, undefined, undefined)))
      .toBe('workspace-write');
    expect(sandboxArg(buildCodexArgs({ sandbox: 'read-only' }, cwd, prompt, undefined, undefined)))
      .toBe('read-only');

    setCodexSandboxSupportForTests({ available: true, probe: 'bwrap' });
    expect(sandboxArg(buildCodexArgs({ sandbox: 'danger-full-access' }, cwd, prompt, undefined, undefined)))
      .toBe('danger-full-access');
  });

  it('emits no --sandbox flag at all when approvals are bypassed', () => {
    setCodexSandboxSupportForTests({ available: false, probe: 'bwrap', reason: NAMESPACE_FAILURE });
    const args = buildCodexArgs({ dangerouslyBypassApprovalsAndSandbox: true }, cwd, prompt, undefined, undefined);

    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(sandboxArg(args)).toBeUndefined();
  });
});
