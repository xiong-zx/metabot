import * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { MessageSender, type FeishuMessageSnapshot } from './message-sender.js';

// Re-export from shared types so existing imports continue to work
export type { IncomingMessage } from '../types.js';
import type { IncomingMessage } from '../types.js';

export type MessageHandler = (msg: IncomingMessage) => void;

/** Payload delivered when a user clicks a button on an interactive card. */
export interface CardActionEvent {
  chatId: string;
  userId: string;
  messageId: string;
  /** Arbitrary value object set by the card builder on the clicked button. */
  value: Record<string, unknown>;
}

export type CardActionHandler = (event: CardActionEvent) => void;

// Cache for group member counts (to avoid calling Feishu API on every message)
const MEMBER_COUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const memberCountCache = new Map<string, { count: number; ts: number }>();

// Cache for recent media messages in group chats (file/image sent without @mention).
// When a user later @mentions the bot, cached media is attached automatically.
const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING_MEDIA_PER_USER = 10;
const MAX_REFERENCED_TEXT_CHARS = 16_000;
interface CachedMedia {
  messageId: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  ts: number;
}
type PendingMediaCache = Map<string, CachedMedia[]>;

function cacheMediaKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

function consumeCachedMedia(
  cache: PendingMediaCache,
  chatId: string,
  userId: string,
  replyToMessageId: string,
): CachedMedia[] {
  const key = cacheMediaKey(chatId, userId);
  const items = cache.get(key);
  if (!items) return [];
  const now = Date.now();
  const valid = items.filter(m => now - m.ts < MEDIA_CACHE_TTL_MS);
  if (valid.length === 0) {
    cache.delete(key);
    return [];
  }

  const selected = valid.filter(m => m.messageId === replyToMessageId);
  if (selected.length === 0) {
    cache.set(key, valid);
    return [];
  }
  const remaining = valid.filter(m => m.messageId !== replyToMessageId);
  if (remaining.length > 0) cache.set(key, remaining);
  else cache.delete(key);
  return selected;
}

function cachePendingMedia(
  cache: PendingMediaCache,
  chatId: string,
  userId: string,
  media: Omit<CachedMedia, 'ts'>,
): void {
  const key = cacheMediaKey(chatId, userId);
  const now = Date.now();
  const valid = (cache.get(key) ?? []).filter(item => now - item.ts < MEDIA_CACHE_TTL_MS);
  valid.push({ ...media, ts: now });
  cache.set(key, valid.slice(-MAX_PENDING_MEDIA_PER_USER));
}

function isDuplicateMessage(cache: Map<string, number>, messageId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of cache) {
    if (now - ts >= MESSAGE_DEDUPE_TTL_MS) cache.delete(id);
  }
  const prior = cache.get(messageId);
  if (prior !== undefined && now - prior < MESSAGE_DEDUPE_TTL_MS) return true;
  cache.set(messageId, now);
  return false;
}

function cleanMessageText(text: string): string {
  return text
    .replace(/@_\w+\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function truncateReferencedText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_REFERENCED_TEXT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_REFERENCED_TEXT_CHARS)}\n[Referenced message truncated]`,
    truncated: true,
  };
}

function parseReferencedMessage(
  snapshot: FeishuMessageSnapshot,
  logger: Logger,
): {
  replyContext?: IncomingMessage['replyContext'];
  media: CachedMedia[];
} {
  const messageType = snapshot.messageType;
  const content = snapshot.content;
  if (!messageType || !content) return { media: [] };

  try {
    const parsed = JSON.parse(content);
    let text = '';
    let media: CachedMedia[] = [];
    if (messageType === 'text') {
      text = cleanMessageText(parsed.text || '');
    } else if (messageType === 'post') {
      text = cleanMessageText(extractTextFromPost(parsed));
      media = extractImagesFromPost(parsed).map(imageKey => ({
        messageId: snapshot.messageId,
        imageKey,
        ts: Date.now(),
      }));
    } else if (messageType === 'image' && parsed.image_key) {
      media = [{ messageId: snapshot.messageId, imageKey: parsed.image_key, ts: Date.now() }];
    } else if (messageType === 'file' && parsed.file_key && parsed.file_name) {
      media = [{
        messageId: snapshot.messageId,
        fileKey: parsed.file_key,
        fileName: parsed.file_name,
        ts: Date.now(),
      }];
    } else {
      logger.debug({ messageId: snapshot.messageId, messageType }, 'Referenced message type is unsupported');
      return { media: [] };
    }

    const bounded = truncateReferencedText(text);
    return {
      replyContext: {
        messageId: snapshot.messageId,
        messageType,
        text: bounded.text || undefined,
        truncated: bounded.truncated || undefined,
      },
      media,
    };
  } catch (err) {
    logger.warn({ err, messageId: snapshot.messageId, messageType }, 'Failed to parse referenced message');
    return { media: [] };
  }
}

async function resolveReferencedMessage(
  cache: PendingMediaCache,
  messageSender: MessageSender | undefined,
  chatId: string,
  userId: string,
  messageId: string,
  logger: Logger,
): Promise<{
  replyContext?: IncomingMessage['replyContext'];
  media: CachedMedia[];
}> {
  const cachedMedia = consumeCachedMedia(cache, chatId, userId, messageId);
  if (!messageSender || typeof messageSender.getMessage !== 'function') {
    return { media: cachedMedia };
  }

  const snapshot = await messageSender.getMessage(messageId);
  if (!snapshot) return { media: cachedMedia };
  if (snapshot.chatId && snapshot.chatId !== chatId) {
    logger.warn({ messageId, chatId, referencedChatId: snapshot.chatId }, 'Ignoring cross-chat reply reference');
    return { media: [] };
  }

  const parsed = parseReferencedMessage(snapshot, logger);
  return {
    replyContext: parsed.replyContext,
    media: parsed.media.length > 0 ? parsed.media : cachedMedia,
  };
}

async function isPrivateLikeGroup(chatId: string, sender: MessageSender): Promise<boolean> {
  const cached = memberCountCache.get(chatId);
  if (cached && Date.now() - cached.ts < MEMBER_COUNT_CACHE_TTL_MS) {
    return cached.count === 2;
  }
  const count = await sender.getChatMemberCount(chatId);
  if (count !== undefined) {
    memberCountCache.set(chatId, { count, ts: Date.now() });
    return count === 2;
  }
  return false;
}

export function createEventDispatcher(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
  onCardAction?: CardActionHandler,
  /** Fired for every Feishu event before filtering; used by the WS watchdog. */
  onAnyEvent?: () => void,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});
  // Each Feishu app gets an independent dispatcher. Keep routing state local so
  // one bot cannot consume another bot's pending attachment or dedupe entry.
  const pendingMediaCache: PendingMediaCache = new Map();
  const recentMessageIds = new Map<string, number>();

  // Register the card action trigger handler (fired when a user clicks a button
  // on an interactive card). The lark SDK types omit this event so we cast.
  if (onCardAction) {
    (dispatcher as unknown as {
      register: (handlers: Record<string, (data: unknown) => unknown>) => void;
    }).register({
      'card.action.trigger': (data: unknown) => {
        onAnyEvent?.();
        try {
          const d = data as {
            operator?: { open_id?: string };
            action?: { value?: unknown };
            context?: { open_message_id?: string; open_chat_id?: string };
          };
          const userId = d.operator?.open_id;
          const messageId = d.context?.open_message_id;
          const chatId = d.context?.open_chat_id;
          const raw = d.action?.value;
          if (!userId || !messageId || !chatId || !raw || typeof raw !== 'object') {
            logger.warn({ data }, 'Card action missing required fields');
            return { toast: { type: 'error', content: 'Invalid card action' } };
          }
          onCardAction({
            chatId,
            userId,
            messageId,
            value: raw as Record<string, unknown>,
          });
          return { toast: { type: 'success', content: '已收到' } };
        } catch (err) {
          logger.error({ err }, 'Error handling card action');
          return { toast: { type: 'error', content: 'Internal error' } };
        }
      },
    });
  }

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      onAnyEvent?.();
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        const msgType = message.message_type;

        // Only handle text, post (rich text), image, and file messages
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'image' && msgType !== 'file') {
          logger.debug({ type: msgType }, 'Ignoring unsupported message type');
          return;
        }

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;
        const replyToMessageId = message.parent_id || undefined;
        if (!messageId) {
          logger.warn({ chatId, chatType }, 'Message missing message_id');
          return;
        }
        if (isDuplicateMessage(recentMessageIds, messageId)) {
          logger.info({ messageId, chatId }, 'Ignoring duplicate message event');
          return;
        }

        // include_bot permissions can deliver messages authored by another app.
        // Feishu chat is a user-facing ingress; bot-to-bot work belongs on the
        // agent bus and must not silently consume model context here.
        const senderType = sender?.sender_type;
        if (senderType !== 'user') {
          logger.info({ messageId, chatId, senderType }, 'Ignoring non-user message event');
          return;
        }

        const userId = sender?.sender_id?.open_id;
        if (!userId) {
          logger.warn('Message missing sender open_id');
          return;
        }

        // In group chats, only respond when the bot is @mentioned
        // Exceptions: 2-member groups are treated like DMs; groupNoMention mode skips @mention check
        const mentions = message.mentions;
        if (chatType === 'group') {
          const botMentioned = botOpenId
            ? mentions?.some((m: any) => m.id?.open_id === botOpenId)
            : false;
          if (!botMentioned) {
            // groupNoMention mode: respond to all messages without @mention
            if (config.groupNoMention) {
              logger.debug({ chatId }, 'Group no-mention mode enabled, processing without @mention');
            } else if (messageSender && await isPrivateLikeGroup(chatId, messageSender)) {
              logger.debug({ chatId }, 'Private-like group (2 members), processing without @mention');
            } else if (msgType === 'image' || msgType === 'file') {
              // Cache media messages for later retrieval when user @mentions bot
              const media = parseMediaMessage(message, msgType, logger);
              if (media) {
                cachePendingMedia(pendingMediaCache, chatId, userId, { ...media, messageId });
                logger.info({ chatId, userId, msgType, ...media }, 'Cached group media for later @mention');
              }
              return;
            } else {
              logger.debug('Ignoring group message without @mention');
              return;
            }
          }
        }

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;
        let postExtraImages: string[] = [];

        if (msgType === 'image') {
          // Image message: extract image_key
          try {
            const content = JSON.parse(message.content);
            imageKey = content.image_key;
          } catch {
            logger.warn('Failed to parse image message content');
            return;
          }
          if (!imageKey) {
            logger.warn('Image message missing image_key');
            return;
          }
          text = '请分析这张图片';
          logger.info({ userId, chatId, chatType, imageKey }, 'Received image message');
        } else if (msgType === 'file') {
          // File message: extract file_key and file_name
          try {
            const content = JSON.parse(message.content);
            fileKey = content.file_key;
            fileName = content.file_name;
          } catch {
            logger.warn('Failed to parse file message content');
            return;
          }
          if (!fileKey || !fileName) {
            logger.warn('File message missing file_key or file_name');
            return;
          }
          text = '请分析这个文件';
          logger.info({ userId, chatId, chatType, fileKey, fileName }, 'Received file message');
        } else if (msgType === 'post') {
          // Rich text (post) message: extract plain text and images from nested structure
          try {
            const content = JSON.parse(message.content);
            logger.debug({ postContent: JSON.stringify(content).slice(0, 500) }, 'Raw post content');
            text = extractTextFromPost(content);
            const postImages = extractImagesFromPost(content);
            if (postImages.length > 0) {
              imageKey = postImages[0];
              postExtraImages = postImages.slice(1);
            }
            logger.debug({ extractedText: text.slice(0, 200), imageKey, postImageCount: postImages.length }, 'Extracted post content');
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse post message content');
            return;
          }
        } else {
          // Text message: extract and clean text
          try {
            const content = JSON.parse(message.content);
            text = content.text || '';
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse message content');
            return;
          }
        }

        // Common text cleanup for text and post messages
        if (msgType === 'text' || msgType === 'post') {
          text = cleanMessageText(text);

          if (!text && !imageKey && !replyToMessageId) {
            logger.debug('Empty message after stripping mentions');
            return;
          }

          if (!text && replyToMessageId) {
            text = '请处理我回复的消息';
          }

          // If text is empty but we have an image (e.g. @bot + image in group chat), set default prompt
          if (!text && imageKey) {
            text = '请分析这张图片';
          }

          logger.info({ userId, chatId, chatType, text: text.slice(0, 100), imageKey }, 'Received message');
        }

        let replyContext: IncomingMessage['replyContext'];
        let referencedMedia: CachedMedia[] = [];
        if (chatType === 'group' && replyToMessageId) {
          const resolved = await resolveReferencedMessage(
            pendingMediaCache,
            messageSender,
            chatId,
            userId,
            replyToMessageId,
            logger,
          );
          replyContext = resolved.replyContext;
          referencedMedia = resolved.media;
          logger.info({
            chatId,
            userId,
            replyToMessageId,
            messageType: replyContext?.messageType,
            mediaCount: referencedMedia.length,
          }, 'Resolved replied message context');
        }

        // Collect extra media: post images (2nd+) and explicitly referenced media
        let extraMedia: IncomingMessage['extraMedia'];
        if (postExtraImages.length > 0) {
          extraMedia = postExtraImages.map(key => ({
            messageId,
            imageKey: key,
          }));
          logger.info({ chatId, postExtraImageCount: postExtraImages.length }, 'Attached extra images from post');
        }
        if (referencedMedia.length > 0) {
          const cachedMedia = referencedMedia.map(m => ({
            messageId: m.messageId,
            imageKey: m.imageKey,
            fileKey: m.fileKey,
            fileName: m.fileName,
          }));
          extraMedia = extraMedia ? [...extraMedia, ...cachedMedia] : cachedMedia;
          logger.info({
            chatId,
            userId,
            replyToMessageId,
            mediaCount: referencedMedia.length,
          }, 'Attached referenced media to @mention message');
        }

        onMessage({
          messageId,
          chatId,
          chatType,
          userId,
          text,
          imageKey,
          fileKey,
          fileName,
          replyContext,
          extraMedia,
        });
      } catch (err) {
        logger.error({ err }, 'Error handling message event');
      }
    },
  });

  return dispatcher;
}

/** Parse image/file message content, returning media fields or undefined on failure. */
function parseMediaMessage(
  message: any, msgType: string, logger: Logger,
): { imageKey?: string; fileKey?: string; fileName?: string } | undefined {
  try {
    const content = JSON.parse(message.content);
    if (msgType === 'image') {
      const imageKey = content.image_key;
      return imageKey ? { imageKey } : undefined;
    }
    if (msgType === 'file') {
      const fileKey = content.file_key;
      const fileName = content.file_name;
      return (fileKey && fileName) ? { fileKey, fileName } : undefined;
    }
  } catch {
    logger.warn({ msgType }, 'Failed to parse media message for caching');
  }
  return undefined;
}

/**
 * Extract all image_keys from a Feishu post (rich text) message.
 * Looks for { tag: "img", image_key: "..." } elements in the post content.
 */
function extractImagesFromPost(content: Record<string, unknown>): string[] {
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    bodies.push(content);
  } else {
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  const keys: string[] = [];
  for (const body of bodies) {
    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if (el.tag === 'img' && typeof el.image_key === 'string') {
          keys.push(el.image_key);
        }
      }
    }
  }

  return keys;
}

/**
 * Extract plain text from Feishu post (rich text) message content.
 * Handles two formats:
 *   With locale wrapper: { "zh_cn": { "title": "...", "content": [[{tag, text}, ...], ...] } }
 *   Without locale wrapper: { "title": "...", "content": [[{tag, text}, ...], ...] }
 */
function extractTextFromPost(content: Record<string, unknown>): string {
  // Try to find the post body — either the content itself or nested under a locale key
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    // Direct format (no locale wrapper)
    bodies.push(content);
  } else {
    // Locale-wrapped format: values are { title, content }
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  for (const body of bodies) {
    const parts: string[] = [];

    if (body.title && typeof body.title === 'string') {
      parts.push(body.title);
    }

    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line: string[] = [];
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if ((el.tag === 'text' || el.tag === 'a') && typeof el.text === 'string') {
          line.push(el.text);
        }
      }
      if (line.length > 0) {
        parts.push(line.join(''));
      }
    }

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return '';
}
