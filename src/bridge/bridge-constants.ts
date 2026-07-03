export const MAX_QUEUE_SIZE = 5;

function parseTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatDuration(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1 && Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = ms / (60 * 1000);
  if (minutes >= 1 && Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${ms}ms`;
}

export const TASK_TIMEOUT_MS = parseTimeoutMs('METABOT_TASK_TIMEOUT_MS', 24 * 60 * 60 * 1000);
export const IDLE_TIMEOUT_MS = parseTimeoutMs('METABOT_IDLE_TIMEOUT_MS', 60 * 60 * 1000);
export const QUESTION_TIMEOUT_MS = parseTimeoutMs('METABOT_QUESTION_TIMEOUT_MS', 5 * 60 * 1000);
export const SPONTANEOUS_COALESCE_MS = 30 * 1000;
export const SPONTANEOUS_SNIPPET_MAX_CHARS = 4000;
export const SPONTANEOUS_BODY_MAX_CHARS = 12000;
export const FINAL_CARD_RETRIES = 3;
export const FINAL_CARD_BASE_DELAY_MS = 2000;
export const TASK_TIMEOUT_MESSAGE = `Task timed out (${formatDuration(TASK_TIMEOUT_MS)} limit)`;
export const IDLE_TIMEOUT_MESSAGE = `Task aborted: no activity for ${formatDuration(IDLE_TIMEOUT_MS)}`;
export const BATCH_DEBOUNCE_MS = 2000;
export const DEFAULT_IMAGE_TEXT = '请分析这张图片';
export const DEFAULT_FILE_TEXT = '请分析这个文件';
