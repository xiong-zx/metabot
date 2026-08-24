/** Runtime-only credentials that must never reach model subprocesses. */
export const METABOT_RUNTIME_SECRET_ENV_KEYS = new Set([
  'API_SECRET',
  'METABOT_API_SECRET',
  'METABOT_CORE_TOKEN',
  'METABOT_PEER_SECRETS',
  'METABOT_PEER_AUTH_SECRETS',
  'BOTS_CONFIG',
]);

export function removeMetaBotRuntimeSecrets<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of METABOT_RUNTIME_SECRET_ENV_KEYS) delete env[key];
  return env;
}
