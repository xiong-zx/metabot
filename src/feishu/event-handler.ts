import * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { MessageSender, type FeishuMessageSnapshot } from './message-sender.js';
import {
  type FeishuGroupReplyMode,
  FeishuGroupReplyModeStore,
} from './group-reply-mode-store.js';

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
export type GroupReplyModeNoticeHandler = (
  chatId: string,
  title: string,
  content: string,
  color: string,
) => Promise<void>;

// Cache for group member counts (to avoid calling Feishu API on every message)
const MEMBER_COUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const memberCountCache = new Map<string, { count: number; ts: number }>();

// Cache for recent media messages in group chats (file/image sent without @mention).
// Entries are consumed only when the user replies to that exact message and @mentions the bot.
const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const METABOT_CARD_CHROME_PREFIXES = [
  '\u{1F3AF} **Goal:**',
  '**State:**',
  '\u{1F9D1}\u{200D}\u{1F91D}\u{200D}\u{1F9D1} **Team:**',
  '\u{1F9D1}\u{200D}\u{1F91D}\u{200D}\u{1F9D1} **Team**',
  '\u{1F4E1} **Background**',
];
const METABOT_TOOL_STATUS_PATTERN =
  /^(?:\u{23F3}|\u{2705})\s+\*\*.+\*\*\s+\u{00B7}\s+\d+\s+tools?$/u;

function isMetaBotCardChrome(node: unknown): boolean {
  if (!isRecord(node) || node.tag !== 'markdown' || typeof node.content !== 'string') {
    return false;
  }
  const content = node.content.trim();
  return METABOT_CARD_CHROME_PREFIXES.some(prefix => content.startsWith(prefix))
    || METABOT_TOOL_STATUS_PATTERN.test(content);
}

function stripLeadingMetaBotCardChrome(elements: unknown): unknown {
  if (!Array.isArray(elements)) return elements;

  let index = 0;
  while (index < elements.length && isMetaBotCardChrome(elements[index])) {
    index += 1;
    const separator = elements[index];
    if (isRecord(separator) && separator.tag === 'hr') index += 1;
  }
  return index > 0 ? elements.slice(index) : elements;
}

function isMetaBotStatsFooter(node: Record<string, unknown>): boolean {
  if (node.tag !== 'column_set' || node.background_style !== 'grey' || !Array.isArray(node.columns)) {
    return false;
  }
  return node.columns.some(column => {
    if (!isRecord(column) || !Array.isArray(column.elements)) return false;
    return column.elements.some(element => (
      isRecord(element)
      && element.tag === 'markdown'
      && typeof element.content === 'string'
      && element.content.startsWith('<font color="grey"')
    ));
  });
}

const METABOT_STATS_FOOTER_PATTERN = /^(?:ctx: \d|\$\d)/;
const MAX_CARD_TRAVERSAL_DEPTH = 40;
const MAX_CARD_TRAVERSAL_NODES = 4_000;

const TEXT_LEAF_TAGS = new Set(['markdown', 'plain_text', 'lark_md', 'md', 'text', 'a', 'at']);
const TEXT_CONTENT_KEYS = ['content', 'text', 'plain_text', 'lark_md'];
const UI_CONTROL_TAGS = new Set(['note', 'button', 'select_static', 'overflow']);
const DEEP_SCAN_SKIP_KEYS = new Set([
  'config', 'header', 'i18n_header', 'card_link', 'style', 'styles',
  'behaviors', 'action', 'value', 'confirm',
]);
const I18N_LOCALE_ORDER = ['zh_cn', 'zh_hk', 'zh_tw', 'en_us', 'ja_jp'];

interface CardTextContext {
  output: string[];
  seen: Set<object>;
  budget: { remaining: number };
  /** Also read note/button/control labels (fallback pass only). */
  permissive: boolean;
  /** Descend every property, not just known element containers. */
  deep: boolean;
}

function readLeafText(node: Record<string, unknown>): string {
  for (const key of TEXT_CONTENT_KEYS) {
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function collectInteractiveCardText(node: unknown, ctx: CardTextContext, depth = 0): void {
  if (ctx.budget.remaining <= 0 || depth > MAX_CARD_TRAVERSAL_DEPTH) return;
  ctx.budget.remaining -= 1;

  if (typeof node === 'string') {
    if (!ctx.deep && node.trim()) ctx.output.push(node.trim());
    return;
  }
  if (Array.isArray(node)) {
    if (ctx.seen.has(node)) return;
    ctx.seen.add(node);
    for (const item of node) collectInteractiveCardText(item, ctx, depth + 1);
    return;
  }
  if (!isRecord(node) || ctx.seen.has(node)) return;
  ctx.seen.add(node);

  const tag = typeof node.tag === 'string' ? node.tag : '';
  if (TEXT_LEAF_TAGS.has(tag)) {
    const text = readLeafText(node);
    if (text) ctx.output.push(text);
    return;
  }

  if (UI_CONTROL_TAGS.has(tag)) {
    if (!ctx.permissive) return;
    const nested: string[] = [];
    const probe: CardTextContext = { ...ctx, output: nested, permissive: false };
    collectInteractiveCardText(node.elements ?? node.text ?? node.content, probe, depth + 1);
    for (const text of nested) {
      if (!METABOT_STATS_FOOTER_PATTERN.test(text)) ctx.output.push(text);
    }
    return;
  }

  if (tag === 'table') {
    collectInteractiveTableText(node, ctx);
    return;
  }

  if (tag === 'div') {
    collectInteractiveCardText(node.text, ctx, depth + 1);
    if (Array.isArray(node.fields)) {
      for (const field of node.fields) {
        if (isRecord(field)) collectInteractiveCardText(field.text, ctx, depth + 1);
      }
    }
    return;
  }

  if (tag === 'column_set') {
    if (!isMetaBotStatsFooter(node)) collectInteractiveCardText(node.columns, ctx, depth + 1);
    return;
  }

  if (ctx.deep) {
    for (const [key, value] of Object.entries(node)) {
      if (DEEP_SCAN_SKIP_KEYS.has(key)) continue;
      if (isRecord(value) || Array.isArray(value)) {
        collectInteractiveCardText(value, ctx, depth + 1);
      }
    }
    return;
  }

  collectInteractiveCardText(node.elements, ctx, depth + 1);
}

function collectInteractiveTableText(node: Record<string, unknown>, ctx: CardTextContext): void {
  const columns = Array.isArray(node.columns) ? node.columns.filter(isRecord) : [];
  const columnNames = columns
    .map(column => typeof column.name === 'string' ? column.name : '')
    .filter(Boolean);
  const header = columns
    .map(column => typeof column.display_name === 'string' ? column.display_name.trim() : '')
    .filter(Boolean);
  if (header.length > 0) ctx.output.push(header.join(' | '));

  if (!Array.isArray(node.rows)) return;
  for (const row of node.rows) {
    if (!isRecord(row)) continue;
    const values = (columnNames.length > 0 ? columnNames.map(name => row[name]) : Object.values(row))
      .map(formatTableCell)
      .filter(Boolean);
    if (values.length > 0) ctx.output.push(values.join(' | '));
  }
}

function formatTableCell(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function pushI18nElementRoots(value: unknown, roots: unknown[]): void {
  if (!isRecord(value)) return;
  for (const locale of I18N_LOCALE_ORDER) {
    if (value[locale] !== undefined) roots.push(value[locale]);
  }
  for (const [locale, elements] of Object.entries(value)) {
    if (!I18N_LOCALE_ORDER.includes(locale)) roots.push(elements);
  }
}

function cardElementRoots(card: Record<string, unknown>): unknown[] {
  const roots: unknown[] = [];
  const seen = new Set<Record<string, unknown>>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 3 || !isRecord(node) || seen.has(node)) return;
    seen.add(node);
    const body = isRecord(node.body) ? node.body : undefined;
    if (body?.elements !== undefined) roots.push(body.elements);
    if (node.elements !== undefined) roots.push(node.elements);
    pushI18nElementRoots(body?.i18n_elements, roots);
    pushI18nElementRoots(node.i18n_elements, roots);
    visit(node.card, depth + 1);
    visit(node.data, depth + 1);
  };

  visit(card, 0);
  return roots;
}

function extractCardSummaryText(card: Record<string, unknown>): string {
  const containers = [card, isRecord(card.card) ? card.card : undefined];
  for (const container of containers) {
    if (!container) continue;
    const config = isRecord(container.config) ? container.config : undefined;
    const summary = isRecord(config?.summary) ? config.summary : container.summary;
    if (isRecord(summary) && typeof summary.content === 'string' && summary.content.trim()) {
      return summary.content.trim();
    }
  }
  return '';
}

function runCardTextPass(roots: unknown[], options: { permissive: boolean; deep: boolean }): string {
  for (const root of roots) {
    const ctx: CardTextContext = {
      output: [],
      seen: new Set<object>(),
      budget: { remaining: MAX_CARD_TRAVERSAL_NODES },
      permissive: options.permissive,
      deep: options.deep,
    };
    collectInteractiveCardText(stripLeadingMetaBotCardChrome(root), ctx);
    if (ctx.output.length > 0) return cleanMessageText(ctx.output.join('\n\n'));
  }
  return '';
}

function extractInteractiveCardText(card: unknown): string {
  if (!isRecord(card)) return '';
  const roots = cardElementRoots(card);
  const strict = runCardTextPass(roots, { permissive: false, deep: false });
  if (strict) return strict;

  const permissive = runCardTextPass(roots, { permissive: true, deep: false });
  if (permissive) return permissive;

  const summary = extractCardSummaryText(card);
  if (summary) return cleanMessageText(summary);

  return runCardTextPass([card], { permissive: true, deep: true });
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
      const post = extractPostInterleaved(parsed);
      text = cleanMessageText(post.text);
      media = post.imageKeys.map(imageKey => ({
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
    } else if (messageType === 'interactive') {
      text = extractInteractiveCardText(parsed);
      if (!text) {
        logger.info(
          { messageId: snapshot.messageId, messageType },
          'Referenced interactive card contained no extractable text',
        );
      }
    } else {
      logger.info({ messageId: snapshot.messageId, messageType }, 'Referenced message type is unsupported');
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
  messageType?: string;
}> {
  const cachedMedia = consumeCachedMedia(cache, chatId, userId, messageId);
  if (!messageSender || typeof messageSender.getMessage !== 'function') {
    return { media: cachedMedia };
  }

  const snapshot = await messageSender.getMessage(messageId);
  if (!snapshot) return { media: cachedMedia };
  if (snapshot.chatId && snapshot.chatId !== chatId) {
    logger.warn({ messageId, chatId, referencedChatId: snapshot.chatId }, 'Ignoring cross-chat reply reference');
    return { media: [], messageType: snapshot.messageType };
  }

  const parsed = parseReferencedMessage(snapshot, logger);
  return {
    replyContext: parsed.replyContext,
    media: parsed.media.length > 0 ? parsed.media : cachedMedia,
    messageType: snapshot.messageType,
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

export function isBotMentioned(mentions: unknown, botOpenId?: string): boolean {
  if (!botOpenId || !Array.isArray(mentions)) {
    return false;
  }

  return mentions.some((mention) => {
    if (!mention || typeof mention !== 'object') {
      return false;
    }
    const id = (mention as { id?: { open_id?: unknown } }).id;
    return id?.open_id === botOpenId;
  });
}

export interface GroupReplyModeCommand {
  action: 'status' | 'set' | 'help';
  mode?: FeishuGroupReplyMode;
}

export function parseGroupReplyModeCommand(text: string): GroupReplyModeCommand | undefined {
  const match = text.trim().match(/^\/(?:group-reply|group_mode|群回复)(?:\s+(.+))?$/i);
  if (!match) return undefined;
  const arg = match[1]?.trim().toLowerCase();
  if (!arg || arg === 'status' || arg === '状态') return { action: 'status' };
  if (['mention', 'at', '@', '仅@', '只@', '必须@'].includes(arg)) {
    return { action: 'set', mode: 'mention' };
  }
  if (['all', '全部', '所有消息', '全量'].includes(arg)) {
    return { action: 'set', mode: 'all' };
  }
  return { action: 'help' };
}

export function shouldProcessGroupMessage(options: {
  botMentioned: boolean;
  storedMode?: FeishuGroupReplyMode;
  configGroupNoMention?: boolean;
  privateLikeGroup?: boolean;
}): boolean {
  if (options.botMentioned) return true;
  if (options.storedMode) return options.storedMode === 'all';
  return options.configGroupNoMention === true || options.privateLikeGroup === true;
}

function groupReplyModeDescription(mode: FeishuGroupReplyMode): string {
  return mode === 'all' ? '回复群里的所有消息' : '只有被 @ 时才回复';
}

export async function handleGroupReplyModeCommand(options: {
  text: string;
  botName: string;
  chatId: string;
  userId: string;
  defaultMode: FeishuGroupReplyMode;
  canChangeMode: boolean;
  store: FeishuGroupReplyModeStore;
  sendNotice: GroupReplyModeNoticeHandler;
}): Promise<boolean> {
  const command = parseGroupReplyModeCommand(options.text);
  if (!command) return false;
  const storedMode = options.store.get(options.botName, options.chatId);
  const currentMode = storedMode ?? options.defaultMode;

  if (command.action === 'set' && command.mode) {
    if (!options.canChangeMode) {
      await options.sendNotice(
        options.chatId,
        '无权限切换群回复模式',
        '只有当前飞书群的群主可以修改回复模式。所有群成员都可以 @ 当前 Bot 并使用 `/group-reply status` 查看状态。',
        'red',
      );
      return true;
    }
    options.store.set(options.botName, options.chatId, command.mode, options.userId);
    await options.sendNotice(
      options.chatId,
      '群回复模式已更新',
      `当前 Agent：\`${options.botName}\`\n当前群模式：**${groupReplyModeDescription(command.mode)}**\n\n命令：@ 当前 Bot 后使用 \`/group-reply mention\` 或 \`/group-reply all\``,
      'green',
    );
    return true;
  }

  if (command.action === 'status') {
    await options.sendNotice(
      options.chatId,
      '群回复模式',
      `当前 Agent：\`${options.botName}\`\n当前群模式：**${groupReplyModeDescription(currentMode)}**\n模式来源：${storedMode ? '当前群显式设置' : 'Agent 默认设置'}\n\n命令：@ 当前 Bot 后使用 \`/group-reply mention\` 或 \`/group-reply all\``,
      'blue',
    );
    return true;
  }

  await options.sendNotice(
    options.chatId,
    '群回复模式命令',
    '请先 @ 当前 Bot。用法：\n- `/group-reply mention` — 只有被 @ 时回复\n- `/group-reply all` — 回复群里的所有消息\n- `/group-reply status` — 查看当前模式',
    'orange',
  );
  return true;
}

export function createEventDispatcher(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
  onCardAction?: CardActionHandler,
  groupReplyModeStore?: FeishuGroupReplyModeStore,
  onGroupReplyModeNotice?: GroupReplyModeNoticeHandler,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});
  // Each bot dispatcher owns its own fallback cache so one bot cannot consume
  // another bot's pending attachment state.
  const pendingMediaCache: PendingMediaCache = new Map();

  // Register the card action trigger handler (fired when a user clicks a button
  // on an interactive card). The lark SDK types omit this event so we cast.
  if (onCardAction) {
    (dispatcher as unknown as {
      register: (handlers: Record<string, (data: unknown) => unknown>) => void;
    }).register({
      'card.action.trigger': (data: unknown) => {
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

        const userId = sender?.sender_id?.open_id;
        if (!userId) {
          logger.warn('Message missing sender open_id');
          return;
        }

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;
        const replyToMessageId = message.parent_id || undefined;
        const mentions = message.mentions;

        let commandText = '';
        let botMentioned = false;
        if (chatType === 'group') {
          botMentioned = isBotMentioned(mentions, botOpenId);
        }
        if (chatType === 'group' && msgType === 'text') {
          try {
            const content = JSON.parse(message.content);
            commandText = String(content.text || '').replace(/@_\w+\s*/g, '').trim();
          } catch {
            commandText = '';
          }

          const groupReplyCommand = parseGroupReplyModeCommand(commandText);
          if (groupReplyCommand && !botMentioned) {
            logger.debug({ chatId, botName: config.name }, 'Ignoring group reply mode command not addressed to this Bot');
            return;
          }
          if (groupReplyCommand && groupReplyModeStore && onGroupReplyModeNotice) {
            const storedMode = groupReplyModeStore.get(config.name, chatId);
            const inheritedPrivateLike = !storedMode && !config.groupNoMention
              && messageSender && typeof messageSender.getChatMemberCount === 'function'
              ? await isPrivateLikeGroup(chatId, messageSender)
              : false;
            const canChangeMode = groupReplyCommand.action !== 'set'
              || (await messageSender?.isChatOwner(chatId, userId)) === true;
            await handleGroupReplyModeCommand({
              text: commandText,
              botName: config.name,
              chatId,
              userId,
              defaultMode: config.groupNoMention || inheritedPrivateLike ? 'all' : 'mention',
              canChangeMode,
              store: groupReplyModeStore,
              sendNotice: onGroupReplyModeNotice,
            });
            logger.info({ chatId, userId, botName: config.name }, 'Handled group reply mode command');
            return;
          }
        }

        if (chatType === 'group') {
          const storedMode = groupReplyModeStore?.get(config.name, chatId);
          const privateLikeGroup = !storedMode && !config.groupNoMention
            && messageSender && typeof messageSender.getChatMemberCount === 'function'
            ? await isPrivateLikeGroup(chatId, messageSender)
            : false;
          if (!shouldProcessGroupMessage({
            botMentioned,
            storedMode,
            configGroupNoMention: config.groupNoMention,
            privateLikeGroup,
          })) {
            if (msgType === 'image' || msgType === 'file') {
              // Cache media only as a fallback for a later reply to this exact message.
              const media = parseMediaMessage(message, msgType, logger);
              if (media) {
                cachePendingMedia(pendingMediaCache, chatId, userId, { ...media, messageId });
                logger.info({ chatId, userId, msgType, ...media }, 'Cached group media for an explicit reply');
              }
              return;
            }
            logger.debug({ chatId, botName: config.name, storedMode }, 'Ignoring group message under mention-only mode');
            return;
          }
          logger.debug({ chatId, botName: config.name, storedMode }, 'Processing group message under reply mode');
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
          // Rich text (post) message: extract plain text and images from nested structure,
          // preserving the original ordering by inlining [图N] placeholders where images appeared.
          try {
            const content = JSON.parse(message.content);
            logger.debug({ postContent: JSON.stringify(content).slice(0, 500) }, 'Raw post content');
            const interleaved = extractPostInterleaved(content);
            text = interleaved.text;
            if (interleaved.imageKeys.length > 0) {
              imageKey = interleaved.imageKeys[0];
              postExtraImages = interleaved.imageKeys.slice(1);
            }
            logger.debug({ extractedText: text.slice(0, 200), imageKey, postImageCount: interleaved.imageKeys.length }, 'Extracted post content');
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
            referencedMessageType: resolved.messageType,
            parsedMessageType: replyContext?.messageType,
            mediaCount: referencedMedia.length,
          }, 'Resolved replied message context');
        }

        // Collect extra media: post images (2nd+) and explicitly referenced media.
        let extraMedia: IncomingMessage['extraMedia'];
        if (postExtraImages.length > 0) {
          extraMedia = postExtraImages.map(key => ({
            messageId,
            imageKey: key,
          }));
          logger.info({ chatId, postExtraImageCount: postExtraImages.length }, 'Attached extra images from post');
        }
        if (referencedMedia.length > 0) {
          const media = referencedMedia.map(item => ({
            messageId: item.messageId,
            imageKey: item.imageKey,
            fileKey: item.fileKey,
            fileName: item.fileName,
          }));
          extraMedia = extraMedia ? [...extraMedia, ...media] : media;
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
 * Extract text and images from a Feishu post (rich text) message in a single pass,
 * preserving the original ordering. Images are replaced with [Image N] placeholders
 * (1-indexed) inside the text, and the matching image_keys are returned in the
 * same order, so the caller can re-align them downstream.
 *
 * Handles two content shapes:
 *   With locale wrapper:    { "zh_cn": { "title": "...", "content": [[{tag, ...}, ...], ...] } }
 *   Without locale wrapper: { "title": "...", "content": [[{tag, ...}, ...], ...] }
 */
function extractPostInterleaved(
  content: Record<string, unknown>,
): { text: string; imageKeys: string[] } {
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

  for (const body of bodies) {
    const parts: string[] = [];
    const imageKeys: string[] = [];

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
        } else if (el.tag === 'img' && typeof el.image_key === 'string') {
          imageKeys.push(el.image_key);
          line.push(`[Image ${imageKeys.length}]`);
        }
      }
      if (line.length > 0) {
        parts.push(line.join(''));
      }
    }

    if (parts.length > 0 || imageKeys.length > 0) {
      return { text: parts.join('\n'), imageKeys };
    }
  }

  return { text: '', imageKeys: [] };
}
