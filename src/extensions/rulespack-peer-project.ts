import { createHash } from 'node:crypto';

export interface RulesPackProjectChatAttestation {
  subjectKey: string;
  projectId: string;
}

interface ProjectChatBinding {
  projectId: string;
  chats: ReadonlyArray<{ bot: string; chatId: string }>;
}

const MAX_ATTESTATIONS = 4_096;
const SUBJECT_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** Hash one exact target tuple without publishing its raw chat ID through peer discovery. */
export function rulesPackProjectChatSubjectKey(botName: string, chatId: string): string {
  const bot = exactIdentity(botName, 'RulesPack project chat bot', 200);
  const chat = exactIdentity(chatId, 'RulesPack project chatId', 500);
  return `sha256:${createHash('sha256').update(JSON.stringify([bot, chat])).digest('hex')}`;
}

/** Materialize only this bot's trusted config bindings as deterministic non-secret attestations. */
export function buildRulesPackProjectChatAttestations(
  configured: readonly ProjectChatBinding[] | undefined,
  botName: string,
): RulesPackProjectChatAttestation[] {
  const bot = exactIdentity(botName, 'RulesPack project chat bot', 200);
  const attestations = new Map<string, RulesPackProjectChatAttestation>();
  for (const project of configured ?? []) {
    const projectId = configIdentity(project.projectId, 'RulesPack chat projectId');
    for (const chat of project.chats) {
      const targetBot = configIdentity(chat.bot, 'RulesPack project chat bot');
      if (targetBot !== bot) continue;
      const subjectKey = rulesPackProjectChatSubjectKey(
        bot,
        configIdentity(chat.chatId, 'RulesPack project chatId'),
      );
      if (attestations.has(subjectKey)) {
        throw new Error(`RulesPack project chat attestation is duplicated for ${bot}`);
      }
      attestations.set(subjectKey, { subjectKey, projectId });
      if (attestations.size > MAX_ATTESTATIONS) {
        throw new Error(`RulesPack project chat attestations exceed ${MAX_ATTESTATIONS}`);
      }
    }
  }
  return [...attestations.values()].sort((left, right) => left.subjectKey.localeCompare(right.subjectKey));
}

/** Validate untrusted peer/Core metadata before using it as an exact dispatch subject fact. */
export function parseRulesPackProjectChatAttestations(
  value: unknown,
): RulesPackProjectChatAttestation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ATTESTATIONS) {
    throw new Error('RulesPack target advertised invalid project chat attestations');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('RulesPack target advertised invalid project chat attestations');
    }
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'projectId,subjectKey') {
      throw new Error('RulesPack target advertised invalid project chat attestations');
    }
    if (typeof entry.subjectKey !== 'string' || !SUBJECT_KEY_PATTERN.test(entry.subjectKey)) {
      throw new Error('RulesPack target advertised invalid project chat attestations');
    }
    const projectId = exactIdentity(entry.projectId, 'RulesPack attested projectId', 500);
    if (seen.has(entry.subjectKey)) {
      throw new Error('RulesPack target advertised duplicate project chat attestations');
    }
    seen.add(entry.subjectKey);
    return { subjectKey: entry.subjectKey, projectId };
  });
}

export function attestedRulesPackProjectId(
  value: unknown,
  botName: string,
  chatId: string,
): { advertised: boolean; projectId?: string } {
  const attestations = parseRulesPackProjectChatAttestations(value);
  if (!attestations) return { advertised: false };
  const subjectKey = rulesPackProjectChatSubjectKey(botName, chatId);
  const projectId = attestations.find((entry) => entry.subjectKey === subjectKey)?.projectId;
  return { advertised: true, ...(projectId ? { projectId } : {}) };
}

function exactIdentity(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be one exact non-empty value`);
  }
  return value;
}

function configIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 500 || normalized.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}
