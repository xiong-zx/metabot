import { Buffer } from 'node:buffer';
import type { GenericOutputContract } from './types.js';

/** Conservative cross-platform bound for Kimi's argv-based --prompt mode. */
export const KIMI_PROMPT_MAX_BYTES = 16_384;

export function renderWorkerPrompt(prompt: string, contract?: GenericOutputContract): string {
  if (!contract) return prompt;
  const lines = [
    prompt,
    '',
    '[Caller-supplied generic output contract]',
    `Return the final response as ${contract.format}.`,
  ];
  if (contract.description) lines.push(contract.description);
  if (contract.jsonSchema) lines.push(`JSON Schema: ${JSON.stringify(contract.jsonSchema)}`);
  return lines.join('\n');
}

export function renderedPromptBytes(prompt: string, contract?: GenericOutputContract): number {
  return Buffer.byteLength(renderWorkerPrompt(prompt, contract), 'utf8');
}
