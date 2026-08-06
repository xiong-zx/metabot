/** Bridge-local credentials that would turn an engine subprocess into admin. */
export const BRIDGE_LOCAL_ADMIN_ENV_KEYS = ['API_SECRET', 'METABOT_API_SECRET', 'METABOT_AUTH'] as const;

export function stripBridgeLocalAdminCredentials<T extends Record<string, string | undefined>>(input: T): T {
  const env = { ...input };
  for (const key of BRIDGE_LOCAL_ADMIN_ENV_KEYS) delete env[key];
  return env;
}
