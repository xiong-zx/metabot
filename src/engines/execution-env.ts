/** Bridge-local credentials that would grant a model subprocess extra authority. */
export const BRIDGE_LOCAL_ADMIN_ENV_KEYS = [
  'API_SECRET',
  'METABOT_API_SECRET',
  'METABOT_AUTH',
] as const;

/** Runtime-only credentials and config pointers that must never reach model subprocesses. */
export const METABOT_RUNTIME_SECRET_ENV_KEYS = new Set([
  ...BRIDGE_LOCAL_ADMIN_ENV_KEYS,
  'METABOT_CORE_TOKEN',
  'METABOT_PEER_SECRETS',
  'METABOT_PEER_AUTH_SECRETS',
  'BOTS_CONFIG',
]);

/** Mutate an environment assembled for a child immediately before spawn. */
export function removeMetaBotRuntimeSecrets<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of METABOT_RUNTIME_SECRET_ENV_KEYS) delete env[key];
  return env;
}

/** Preserve the downstream non-mutating helper contract while applying the full boundary. */
export function stripBridgeLocalAdminCredentials<T extends Record<string, string | undefined>>(input: T): T {
  return removeMetaBotRuntimeSecrets({ ...input });
}
