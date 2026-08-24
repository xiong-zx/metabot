import type { CardState } from '../types.js';

export type CardUpdateFailureCategory =
  | 'payload'
  | 'authentication'
  | 'not_found'
  | 'rate_limit'
  | 'transient'
  | 'unknown';

export interface CardUpdateFailure {
  category: CardUpdateFailureCategory;
  retryable: boolean;
  httpStatus?: number;
  providerCode?: string | number;
  providerSubcode?: string | number;
  requestId?: string;
}

export type CardUpdateResult =
  | { ok: true }
  | ({ ok: false } & CardUpdateFailure);

/**
 * Older and non-HTTP senders may still return a boolean. Delivery code treats
 * `false` as an unknown transient failure so those platforms keep their
 * existing bounded-retry behavior.
 */
export type CardUpdateOutcome = boolean | CardUpdateResult;

export interface CardDeliveryOptions {
  /** Avoid platform-sensitive native components while preserving the text. */
  safeTerminal?: boolean;
}

export function normalizeCardUpdateOutcome(outcome: CardUpdateOutcome): CardUpdateResult {
  if (typeof outcome !== 'boolean') return outcome;
  return outcome
    ? { ok: true }
    : { ok: false, category: 'unknown', retryable: true };
}

/**
 * Platform-agnostic message sender interface.
 * Implemented by each IM platform (Feishu, Telegram, etc.).
 */
export interface IMessageSender {
  /** Send a new streaming card/message for a CardState. Returns messageId for subsequent updates. */
  sendCard(
    chatId: string,
    state: CardState,
    options?: CardDeliveryOptions,
  ): Promise<string | undefined>;

  /** Update an existing streaming card/message and classify delivery failures when available. */
  updateCard(
    messageId: string,
    state: CardState,
    options?: CardDeliveryOptions,
  ): Promise<CardUpdateOutcome>;

  /**
   * Send a dedicated interactive question card for an AskUserQuestion call.
   * The state's `pendingQuestion` field carries the options/buttons.
   *
   * Why a separate method (not just sendCard with pendingQuestion):
   *   - On Feishu, Card Schema 2.0 has a mobile-App render bug — `tag: action`
   *     button blocks are silently dropped on iOS/Android, so AskUserQuestion
   *     options become invisible. The Feishu adapter forces Schema 1.0 for
   *     question cards (v1 buttons are verified working on mobile).
   *   - On Telegram (and future platforms), this is the natural hook for
   *     inline-keyboard rendering — also conceptually distinct from a
   *     streaming "thinking" card.
   *
   * Optional: platforms without a special path may omit; bridge falls back
   * to sendCard / updateCard.
   *
   * See memory: bug-feishu-v2-mobile-action-buttons.
   */
  sendQuestionCard?(chatId: string, state: CardState): Promise<string | undefined>;

  /** Update an existing question card with new CardState (e.g., mark answered). */
  updateQuestionCard?(messageId: string, state: CardState): Promise<boolean>;

  /** Send a simple notice message (for command responses: /help, /reset, /stop, etc.). */
  sendTextNotice(chatId: string, title: string, content: string, color?: string): Promise<void>;

  /** Send a plain text message. A boolean result is used when the platform can confirm delivery. */
  sendText(chatId: string, text: string): Promise<boolean | void>;

  /** Send a local image file to the chat. */
  sendImageFile(chatId: string, filePath: string): Promise<boolean>;

  /** Send a local file to the chat. */
  sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean>;

  /** Send a local audio file as a native voice/audio message, when supported. */
  sendAudioFile?(chatId: string, filePath: string, fileName?: string): Promise<boolean>;

  /** Download a user-sent image to a local path. */
  downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean>;

  /** Download a user-sent file to a local path. */
  downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean>;

  /** If true, the bridge will not send a separate "Task completed" text after the card update. */
  skipCompletionNotice?: boolean;
}
