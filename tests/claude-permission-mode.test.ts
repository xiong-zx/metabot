import { describe, expect, it } from 'vitest';
import { webBotFromJson } from '../src/config.js';
import { resolveClaudePermissionOptions } from '../src/engines/claude/executor.js';

describe('Claude permissionMode config', () => {
  it('parses permissionMode from bot JSON entries', () => {
    const config = webBotFromJson({
      name: 'web-claude',
      engine: 'claude',
      defaultWorkingDirectory: '/tmp',
      permissionMode: 'plan',
    });

    expect(config.claude.permissionMode).toBe('plan');
  });

  it('keeps the existing root-aware default when permissionMode is unset', () => {
    expect(resolveClaudePermissionOptions(undefined, true)).toEqual({
      permissionMode: 'auto',
    });
    expect(resolveClaudePermissionOptions(undefined, false)).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('only enables dangerous skip permissions for bypassPermissions', () => {
    expect(resolveClaudePermissionOptions('auto', false)).toEqual({
      permissionMode: 'auto',
    });
    expect(resolveClaudePermissionOptions('bypassPermissions', true)).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });
});
