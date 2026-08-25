import { ConnectorError } from './errors.js';
import { parseLoopbackHttpEndpoint } from './endpoint.js';
import { readProtectedSecret } from './protected-file.js';
import { createRedactor, type Redactor } from './redact.js';

/**
 * The complete set of things a spawned connector is allowed to know.
 *
 * Deliberately absent: tool names, scope vocabularies, database or profile
 * layout, release identity, and the product's own error codes. A descriptor
 * that needed any of those would be a gateway, which is the shape this package
 * exists to avoid.
 */
export interface ConnectorDescriptor {
  /** Environment variable holding the loopback endpoint. */
  readonly endpointEnvVar: string;
  /** Environment variable holding the path of the leased capability file. */
  readonly capabilityFileEnvVar: string;
  /**
   * Signed audience the capability must name. It is carried, not verified: the
   * server behind the endpoint owns signature verification, and a connector
   * that believed an unverified claim would be asserting its own authorization.
   */
  readonly audience: string;
  /** Optional second secret: the connector's credential to a further service. */
  readonly serviceSecretFileEnvVar?: string;
}

export interface ConnectorTargetOptions {
  /** Directory both credential files must resolve inside. */
  containedIn?: string;
}

export interface ConnectorTarget {
  readonly endpoint: URL;
  readonly audience: string;
  readonly capability: string;
  readonly serviceSecret?: string;
  /** Pre-seeded with every secret this target holds. */
  readonly redact: Redactor;
}

export function resolveConnectorTarget(
  env: NodeJS.ProcessEnv,
  descriptor: ConnectorDescriptor,
  options: ConnectorTargetOptions = {},
): ConnectorTarget {
  if (descriptor.audience.trim().length === 0) {
    throw new ConnectorError('Connector descriptor must name an audience', 'AUDIENCE_MISSING');
  }
  const endpoint = parseLoopbackHttpEndpoint(env[descriptor.endpointEnvVar], descriptor.endpointEnvVar);

  const capabilityPath = env[descriptor.capabilityFileEnvVar];
  if (typeof capabilityPath !== 'string' || capabilityPath.trim().length === 0) {
    throw new ConnectorError(`Missing ${descriptor.capabilityFileEnvVar}`, 'CREDENTIAL_MISSING');
  }
  const capability = readProtectedSecret(capabilityPath.trim(), {
    label: 'capability file',
    ...(options.containedIn === undefined ? {} : { containedIn: options.containedIn }),
  });

  let serviceSecret: string | undefined;
  if (descriptor.serviceSecretFileEnvVar !== undefined) {
    const secretPath = env[descriptor.serviceSecretFileEnvVar];
    if (typeof secretPath !== 'string' || secretPath.trim().length === 0) {
      throw new ConnectorError(`Missing ${descriptor.serviceSecretFileEnvVar}`, 'CREDENTIAL_MISSING');
    }
    serviceSecret = readProtectedSecret(secretPath.trim(), { label: 'service credential file' });
  }

  return {
    endpoint,
    audience: descriptor.audience,
    capability,
    ...(serviceSecret === undefined ? {} : { serviceSecret }),
    redact: createRedactor([capability, serviceSecret]),
  };
}
