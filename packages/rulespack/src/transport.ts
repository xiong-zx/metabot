import { digestObject } from './canonical.js';
import { subjectFingerprint, verifyCompiledPack } from './compiler.js';
import { RulesPackError } from './errors.js';
import type { CompiledRulesPack, ExecutionSubject } from './model.js';

export interface RulesPackDispatchEnvelopeV1 {
  schemaVersion: 1;
  envelopeId: string;
  issuer: string;
  audience: string;
  replayId: string;
  issuedAt: string;
  expiresAt: string;
  subjectFingerprint: string;
  target: ExecutionSubject;
  packDigest: string;
  pack: CompiledRulesPack;
  required: boolean;
  parentDispatchId?: string;
  authentication?: {
    scheme: string;
    keyId?: string;
    value: string;
  };
}

/** Signed local-only authority for one level of detached Worker descendants. */
export interface RulesPackChildGrantV1 {
  schemaVersion: 1;
  purpose: 'worker';
  grantId: string;
  capabilityDigest: string;
  issuedAt: string;
  expiresAt: string;
  depth: 1;
  parentEnvelopeFingerprint: string;
  parent: RulesPackDispatchEnvelopeV1;
  constraints: {
    hostId: string;
    bot: string;
    chatId: string;
    projectId?: string;
  };
  signature: {
    scheme: 'ed25519';
    value: string;
  };
}

export function rulesPackChildGrantFingerprint(
  grant: Omit<RulesPackChildGrantV1, 'signature'>,
): string {
  return digestObject(grant);
}

/** Structural verification only. The downstream adapter owns authenticated capability/signature verification. */
export function validateDispatchEnvelope(
  envelope: RulesPackDispatchEnvelopeV1,
  expected: { audience: string; target: ExecutionSubject; now?: string },
): RulesPackDispatchEnvelopeV1 {
  const nowText = expected.now ?? new Date().toISOString();
  const now = Date.parse(nowText);
  if (!Number.isFinite(now)) {
    throw new RulesPackError('VALIDATION_ERROR', 'Dispatch verification time is invalid');
  }
  if (envelope === null || typeof envelope !== 'object') {
    throw new RulesPackError('VALIDATION_ERROR', 'Dispatch envelope must be an object');
  }
  if (envelope.schemaVersion !== 1) throw new RulesPackError('VALIDATION_ERROR', 'Unsupported dispatch envelope version');
  if (
    typeof envelope.envelopeId !== 'string' ||
    typeof envelope.issuer !== 'string' ||
    typeof envelope.audience !== 'string' ||
    typeof envelope.replayId !== 'string' ||
    typeof envelope.issuedAt !== 'string' ||
    typeof envelope.expiresAt !== 'string' ||
    typeof envelope.packDigest !== 'string' ||
    typeof envelope.required !== 'boolean' ||
    envelope.pack === null ||
    typeof envelope.pack !== 'object'
  ) {
    throw new RulesPackError('VALIDATION_ERROR', 'Dispatch envelope fields are malformed');
  }
  if (envelope.audience !== expected.audience) {
    throw new RulesPackError('TARGET_MISMATCH', 'Dispatch audience mismatch');
  }
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= now || issuedAt > now) {
    throw new RulesPackError('TARGET_MISMATCH', 'Dispatch envelope is expired or not yet valid');
  }
  const expectedFingerprint = subjectFingerprint(expected.target);
  if (
    envelope.subjectFingerprint !== expectedFingerprint ||
    subjectFingerprint(envelope.target) !== expectedFingerprint ||
    envelope.pack.subjectFingerprint !== expectedFingerprint
  ) {
    throw new RulesPackError('TARGET_MISMATCH', 'Dispatch target fingerprint mismatch');
  }
  if (envelope.packDigest !== envelope.pack.packDigest) {
    throw new RulesPackError('TARGET_MISMATCH', 'Dispatch pack digest mismatch');
  }
  verifyCompiledPack(envelope.pack, nowText);
  return envelope;
}

export function dispatchEnvelopeFingerprint(envelope: RulesPackDispatchEnvelopeV1): string {
  return digestObject({
    schemaVersion: envelope.schemaVersion,
    envelopeId: envelope.envelopeId,
    issuer: envelope.issuer,
    audience: envelope.audience,
    replayId: envelope.replayId,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    subjectFingerprint: envelope.subjectFingerprint,
    packDigest: envelope.packDigest,
    required: envelope.required,
    parentDispatchId: envelope.parentDispatchId,
  });
}
