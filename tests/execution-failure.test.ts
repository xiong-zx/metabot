import { describe, expect, it } from 'vitest';
import {
  ExecutionPolicyError,
  executionFailureMetadata,
} from '../src/services/execution-failure.js';

describe('execution failure metadata', () => {
  it('marks explicit policy failures non-retryable with a stable fingerprint', () => {
    const first = executionFailureMetadata(new ExecutionPolicyError(
      'ENGINE_POLICY_INCOMPATIBLE',
      'Engine is not supported by the required policy',
    ));
    const second = executionFailureMetadata(new ExecutionPolicyError(
      'ENGINE_POLICY_INCOMPATIBLE',
      'Engine is not supported by the required policy',
    ));
    expect(first).toMatchObject({
      code: 'ENGINE_POLICY_INCOMPATIBLE',
      retryable: false,
      message: 'Engine is not supported by the required policy',
    });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('redacts credential-like values before persistence or display', () => {
    const failure = executionFailureMetadata(new Error(
      'request failed Authorization=Bearer abc.def token=top-secret-value',
    ));
    expect(failure.message).toContain('[REDACTED]');
    expect(failure.message).not.toContain('abc.def');
    expect(failure.message).not.toContain('top-secret-value');
  });

  it('classifies unstructured transient failures as retryable', () => {
    expect(executionFailureMetadata(new Error('connection reset by peer'))).toMatchObject({
      code: 'EXECUTION_FAILED',
      retryable: true,
    });
  });
});
