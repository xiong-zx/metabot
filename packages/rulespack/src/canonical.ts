import { createHash, randomUUID } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestObject(value: unknown): string {
  return `sha256:${sha256(stableStringify(value))}`;
}

export function stableId(prefix: string, digest: string): string {
  return `${prefix}_${digest.replace(/^sha256:/, '').slice(0, 24)}`;
}

export function eventId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
