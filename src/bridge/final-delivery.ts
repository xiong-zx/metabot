import * as fsPromises from 'node:fs/promises';
import type { BotConfigBase } from '../config.js';
import type { CardState } from '../types.js';
import type { StreamProcessor, SessionManager } from '../engines/index.js';
import type { Logger } from '../utils/logger.js';
import {
  normalizeCardUpdateOutcome,
  type CardUpdateFailure,
  type IMessageSender,
} from './message-sender.interface.js';
import { FINAL_CARD_BASE_DELAY_MS, FINAL_CARD_RETRIES } from './bridge-constants.js';
import { createVoiceReplyOpus } from './voice-reply.js';

const TEXT_FALLBACK_CHUNK_LENGTH = 1800;

export interface FinalCardDeliveryResult {
  status: 'updated' | 'updated_safe' | 'superseded' | 'text_fallback' | 'reconciliation_required';
  normalAttempts: number;
  originalCardTerminal: boolean;
  replacementMessageId?: string;
  lastFailure?: CardUpdateFailure;
}

function splitTextFallback(text: string): string[] {
  const characters = Array.from(text);
  if (characters.length <= TEXT_FALLBACK_CHUNK_LENGTH) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += TEXT_FALLBACK_CHUNK_LENGTH) {
    chunks.push(characters.slice(offset, offset + TEXT_FALLBACK_CHUNK_LENGTH).join(''));
  }
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

function supersedingState(state: CardState): CardState {
  const notice = '> **Final result:** This card supersedes an earlier Running card that could not be updated.';
  return {
    ...state,
    responseText: state.responseText ? `${notice}\n\n${state.responseText}` : notice,
  };
}

export async function sendFinalCardWithRetry(opts: {
  sender: IMessageSender;
  config: BotConfigBase;
  logger: Logger;
  sessionManager: SessionManager;
  messageId: string;
  state: CardState;
  chatId?: string;
}): Promise<FinalCardDeliveryResult> {
  const { sender, config, logger, sessionManager, messageId, state, chatId } = opts;

  if (chatId && (state.status === 'complete' || state.status === 'error')) {
    sessionManager.addUsage(chatId, state.totalTokens ?? 0, state.costUsd ?? 0, state.durationMs ?? 0);
    const session = sessionManager.getSession(chatId);
    state.sessionCostUsd = session.cumulativeCostUsd;
  }

  let normalAttempts = 0;
  let lastFailure: CardUpdateFailure | undefined;
  for (let attempt = 0; attempt < FINAL_CARD_RETRIES; attempt++) {
    normalAttempts += 1;
    const result = normalizeCardUpdateOutcome(await sender.updateCard(messageId, state));
    if (result.ok) {
      void sendVoiceReplyIfEnabled({ sender, config, logger, chatId, state });
      return { status: 'updated', normalAttempts, originalCardTerminal: true };
    }
    lastFailure = result;
    if (!result.retryable) {
      logger.warn(
        { attempt: attempt + 1, messageId, ...result },
        'Final card update failed with a non-retryable error',
      );
      break;
    }
    if (attempt + 1 < FINAL_CARD_RETRIES) {
      const delay = FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn(
        { attempt: attempt + 1, delay, messageId, ...result },
        'Final card update failed, retrying',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // A safe terminal render keeps all text but avoids native table elements.
  // Payload failures use it immediately; transient failures reach it only
  // after bounded retries.
  if (lastFailure?.category !== 'authentication' && lastFailure?.category !== 'not_found') {
    const safeResult = normalizeCardUpdateOutcome(await sender.updateCard(
      messageId,
      state,
      { safeTerminal: true },
    ));
    if (safeResult.ok) {
      logger.warn(
        { messageId, normalAttempts, fallback: 'safe_terminal' },
        'Final card delivered with safe terminal rendering',
      );
      void sendVoiceReplyIfEnabled({ sender, config, logger, chatId, state });
      return {
        status: 'updated_safe',
        normalAttempts,
        originalCardTerminal: true,
        lastFailure,
      };
    }
    lastFailure = safeResult;
  }

  if (!chatId) {
    logger.error(
      { messageId, normalAttempts, lastFailure, reconciliationRequired: true },
      'Final card delivery requires reconciliation',
    );
    return {
      status: 'reconciliation_required',
      normalAttempts,
      originalCardTerminal: false,
      lastFailure,
    };
  }

  if (lastFailure?.category !== 'authentication') {
    try {
      const replacementMessageId = await sender.sendCard(
        chatId,
        supersedingState(state),
        { safeTerminal: true },
      );
      if (replacementMessageId) {
        logger.error(
          { messageId, replacementMessageId, chatId, lastFailure, fallback: 'replacement_card' },
          'Final result sent in a card that supersedes the earlier Running card',
        );
        void sendVoiceReplyIfEnabled({ sender, config, logger, chatId, state });
        return {
          status: 'superseded',
          normalAttempts,
          originalCardTerminal: false,
          replacementMessageId,
          lastFailure,
        };
      }
    } catch {
      // The sender logs a secret-safe error. Continue to the final text path.
    }
  }

  const statusEmoji = state.status === 'complete' ? '✅' : '❌';
  const completeText = state.responseText || state.errorMessage || 'Task finished';
  const fallbackText = `${statusEmoji} Final result (supersedes the earlier Running card):\n${completeText}`;
  try {
    for (const chunk of splitTextFallback(fallbackText)) {
      const sent = await sender.sendText(chatId, chunk);
      if (sent === false) throw new Error('Text fallback delivery failed');
    }
    logger.error(
      { messageId, chatId, lastFailure, fallback: 'chunked_text' },
      'Final result sent as chunked text after card delivery failed',
    );
    void sendVoiceReplyIfEnabled({ sender, config, logger, chatId, state });
    return {
      status: 'text_fallback',
      normalAttempts,
      originalCardTerminal: false,
      lastFailure,
    };
  } catch {
    logger.error(
      { messageId, chatId, lastFailure, reconciliationRequired: true },
      'Final card delivery and fallbacks failed; reconciliation is required',
    );
    return {
      status: 'reconciliation_required',
      normalAttempts,
      originalCardTerminal: false,
      lastFailure,
    };
  }
}

export async function sendVoiceReplyIfEnabled(opts: {
  sender: IMessageSender;
  config: BotConfigBase;
  logger: Logger;
  chatId: string | undefined;
  state: CardState;
}): Promise<void> {
  const { sender, config, logger, chatId, state } = opts;
  if (!chatId || state.status !== 'complete' || !state.responseText.trim() || !sender.sendAudioFile) return;

  const audio = await createVoiceReplyOpus(config, state.responseText, logger);
  if (!audio) return;
  try {
    const sent = await sender.sendAudioFile(chatId, audio.filePath, audio.fileName);
    if (!sent) {
      logger.warn({ chatId }, 'Voice reply audio send failed');
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'Unhandled error while sending voice reply');
  } finally {
    await audio.cleanup().catch(() => {});
  }
}

export async function sendPlanContent(opts: {
  sender: IMessageSender;
  logger: Logger;
  chatId: string;
  processor: StreamProcessor;
}): Promise<void> {
  const { sender, logger, chatId, processor } = opts;
  let planContent = processor.getPlanContent() || '';
  if (!planContent.trim()) {
    const planPath = processor.getPlanFilePath();
    if (!planPath) return;
    try {
      planContent = await fsPromises.readFile(planPath, 'utf-8');
    } catch (err) {
      logger.warn({ err, planPath, chatId }, 'Failed to read plan file for display');
      return;
    }
  }
  if (!planContent.trim()) return;

  logger.info({ chatId }, 'Sending plan content to user');
  await sender.sendTextNotice(chatId, '📋 Plan', planContent, 'green');
}
