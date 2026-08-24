import { randomUUID } from 'node:crypto';

import { MetaClawError } from './errors.js';
import type { MetaClawProfile } from './profile.js';

/**
 * Request construction for bounded, non-streaming inference.
 *
 * Two rules shape everything here.
 *
 * **The caller may not steer the request.** Model, provider, base URL, and
 * session identity come from the profile or from this module, never from the
 * tool input. A caller that could choose the model could choose an expensive
 * one; a caller that could choose the session id could join, or flush, someone
 * else's session.
 *
 * **The body is built from an allowlist, not filtered.** Stripping named keys
 * from caller input fails the moment upstream adds a control nobody stripped.
 * Constructing the outbound body field by field cannot fail that way.
 */

/**
 * Controls a caller may send and this server removes. They are reported back
 * rather than silently dropped: a caller that thinks it set `stream: true` and
 * gets a non-streaming answer deserves to know which of the two happened.
 */
export const STRIPPED_CONTROL_KEYS = Object.freeze([
  'model',
  'provider',
  'base_url',
  'baseUrl',
  'stream',
  'stream_options',
  'session_id',
  'session_done',
  'turn_type',
  'memory_scope',
  'user_id',
  'workspace_id',
  'n',
  'logprobs',
] as const);

export type StrippedControlKey = (typeof STRIPPED_CONTROL_KEYS)[number];

export const SESSION_HEADER = 'x-session-id';
export const TURN_TYPE_HEADER = 'x-turn-type';
/**
 * Every call is a side turn. A main turn is what advances a session's durable
 * state upstream, and this server has no session to advance: it mints a fresh
 * session id per call precisely so nothing accumulates.
 */
export const TURN_TYPE_VALUE = 'side';

export interface InferMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface InferInput {
  readonly messages: readonly InferMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly deadlineMs?: number;
  readonly controls?: Readonly<Record<string, unknown>>;
}

export interface PreparedInference {
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly deadlineMs: number;
  readonly sessionId: string;
  readonly strippedControls: readonly string[];
  readonly promptBytes: number;
}

export function prepareInference(profile: MetaClawProfile, input: InferInput): PreparedInference {
  const limits = profile.limits;

  if (input.messages.length === 0) {
    throw new MetaClawError('At least one message is required', 'invalid_request', { field: 'messages' });
  }
  if (input.messages.length > limits.maxMessages) {
    throw new MetaClawError(
      `messages exceeds the ${limits.maxMessages} message bound`,
      'invalid_request',
      { field: 'messages', bound: limits.maxMessages, actual: input.messages.length },
    );
  }

  const promptBytes = input.messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
    0,
  );
  if (promptBytes > limits.maxPromptBytes) {
    throw new MetaClawError(
      `prompt exceeds the ${limits.maxPromptBytes} byte bound`,
      'invalid_request',
      { field: 'messages', bound: limits.maxPromptBytes, actual: promptBytes },
    );
  }

  if (input.maxOutputTokens !== undefined && input.maxOutputTokens > limits.maxOutputTokens) {
    throw new MetaClawError(
      `maxOutputTokens exceeds the ${limits.maxOutputTokens} token bound`,
      'invalid_request',
      { field: 'maxOutputTokens', bound: limits.maxOutputTokens, actual: input.maxOutputTokens },
    );
  }

  // A caller may shorten its own deadline but never extend the profile's.
  const requested = input.deadlineMs ?? limits.deadlineMs;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new MetaClawError('deadlineMs must be a positive integer', 'invalid_request', { field: 'deadlineMs' });
  }
  const deadlineMs = Math.min(requested, limits.deadlineMs);

  // The outbound request is allowlisted, so every key in `controls` is
  // stripped, including one introduced after this build's documentation was
  // written. Reporting only the known names would silently drop the novel one.
  const strippedControls = input.controls === undefined
    ? []
    : Object.keys(input.controls).sort();

  const sessionId = `metaclaw-side-${randomUUID()}`;

  return {
    body: Object.freeze({
      model: profile.model.id,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      // Non-streaming is a contract, not a default: the official service turns
      // a blocking provider call into a synthetic two-chunk SSE response, so a
      // stream here would imply a cancellation story that does not exist.
      stream: false,
      max_tokens: input.maxOutputTokens ?? limits.maxOutputTokens,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    }),
    headers: Object.freeze({
      'content-type': 'application/json',
      [SESSION_HEADER]: sessionId,
      [TURN_TYPE_HEADER]: TURN_TYPE_VALUE,
    }),
    deadlineMs,
    sessionId,
    strippedControls,
    promptBytes,
  };
}

export interface InferenceProvenance {
  readonly model: string;
  readonly provider: string;
  readonly returnedIdentityVerified: true;
  readonly sessionId: string;
  readonly turnType: typeof TURN_TYPE_VALUE;
  readonly releaseId: string;
  readonly official: boolean;
  readonly promptBytes: number;
  readonly elapsedMs: number;
  readonly strippedControls: readonly string[];
  readonly streaming: 'unsupported';
  readonly upstreamCancellation: 'unsupported';
}

/**
 * Provenance carries identity and bounds, never content. Prompt and response
 * text are the two things most likely to be logged by whoever receives this,
 * so they are simply not in it.
 */
export function buildProvenance(input: {
  profile: MetaClawProfile;
  prepared: PreparedInference;
  releaseId: string;
  official: boolean;
  elapsedMs: number;
}): InferenceProvenance {
  return {
    model: input.profile.model.id,
    provider: input.profile.model.provider,
    returnedIdentityVerified: true,
    sessionId: input.prepared.sessionId,
    turnType: TURN_TYPE_VALUE,
    releaseId: input.releaseId,
    official: input.official,
    promptBytes: input.prepared.promptBytes,
    elapsedMs: input.elapsedMs,
    strippedControls: input.prepared.strippedControls,
    streaming: 'unsupported',
    upstreamCancellation: 'unsupported',
  };
}

/** Refuse a response that does not echo both pinned dispatch identities. */
export function assertReturnedModelProvider(
  json: Readonly<Record<string, unknown>>,
  profile: MetaClawProfile,
): void {
  const returnedModel = json.model;
  const returnedProvider = json.provider;
  if (returnedModel !== profile.model.id || returnedProvider !== profile.model.provider) {
    throw new MetaClawError('Completion response did not verify the pinned model and provider', 'contract_violation', {
      modelMatched: returnedModel === profile.model.id,
      providerMatched: returnedProvider === profile.model.provider,
    });
  }
}

/** Extract the assistant text without trusting the service's exact envelope. */
export function extractCompletionText(json: Readonly<Record<string, unknown>>): string {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new MetaClawError('Completion response contained no choices', 'contract_violation');
  }
  const message = (choices[0] as Record<string, unknown> | undefined)?.message;
  if (typeof message !== 'object' || message === null) {
    throw new MetaClawError('Completion choice contained no message', 'contract_violation');
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string') {
    throw new MetaClawError('Completion message content was not text', 'contract_violation');
  }
  return content;
}
