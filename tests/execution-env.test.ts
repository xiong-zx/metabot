import { describe, expect, it } from 'vitest';
import { buildCodexEnv } from '../src/engines/codex/executor.js';
import { removeMetaBotRuntimeSecrets } from '../src/engines/execution-env.js';

describe('model child environment credential boundary', () => {
  it('removes Bridge administrator and peer credentials while preserving ordinary settings', () => {
    expect(removeMetaBotRuntimeSecrets({
      PATH: '/usr/bin',
      API_SECRET: 'admin-secret',
      METABOT_API_SECRET: 'admin-secret',
      METABOT_CORE_TOKEN: 'core-bearer',
      METABOT_PEER_SECRETS: 'legacy-secret',
      METABOT_PEER_AUTH_SECRETS: 'scoped-secret',
      BOTS_CONFIG: '/private/bots.json',
      METABOT_PEER_ID: 'imac',
    })).toEqual({ PATH: '/usr/bin', METABOT_PEER_ID: 'imac' });
  });

  it('applies the boundary to Codex even when a bot override tries to restore a runtime secret', () => {
    const env = buildCodexEnv({
      env: {
        API_SECRET: 'override-admin-secret',
        METABOT_CORE_TOKEN: 'override-core-bearer',
        METABOT_PEER_AUTH_SECRETS: 'override-peer-secret',
        SAFE_SETTING: 'yes',
      },
    }, {
      API_SECRET: 'inherited-admin-secret',
      METABOT_CORE_TOKEN: 'inherited-core-bearer',
      BOTS_CONFIG: '/private/bots.json',
      PATH: '/usr/bin',
    });
    expect(env).toMatchObject({ PATH: '/usr/bin', SAFE_SETTING: 'yes' });
    expect(env.API_SECRET).toBeUndefined();
    expect(env.METABOT_CORE_TOKEN).toBeUndefined();
    expect(env.METABOT_PEER_AUTH_SECRETS).toBeUndefined();
    expect(env.BOTS_CONFIG).toBeUndefined();
  });
});
