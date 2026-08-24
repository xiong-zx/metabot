import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/config.js';
import { buildCard } from '../src/feishu/card-builder.js';
import { buildCardV2 } from '../src/feishu/card-builder-v2.js';
import {
  createEventDispatcher,
  isBotMentioned,
  parseGroupReplyModeCommand,
  shouldProcessGroupMessage,
} from '../src/feishu/event-handler.js';
import type { IncomingMessage } from '../src/types.js';

function config(): BotConfig {
  return {
    name: 'test-bot',
    groupNoMention: false,
    feishu: { appId: 'cli_self_app', appSecret: 'secret' },
  } as BotConfig;
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function event(input: {
  messageId: string;
  messageType?: 'text' | 'post' | 'image' | 'file';
  content?: Record<string, unknown>;
  mentions?: string[];
  parentId?: string;
}) {
  const messageType = input.messageType ?? 'text';
  const fallbackContent = messageType === 'text' ? { text: 'hello' } : {};
  return {
    sender: { sender_id: { open_id: 'user-open-id' } },
    message: {
      message_id: input.messageId,
      message_type: messageType,
      chat_id: 'chat-1',
      chat_type: 'group',
      parent_id: input.parentId,
      mentions: input.mentions?.map(openId => ({ id: { open_id: openId } })),
      content: JSON.stringify(input.content ?? fallbackContent),
    },
  };
}

function messageHandler(messageSender?: any) {
  const received: IncomingMessage[] = [];
  const testLogger = logger();
  const dispatcher = createEventDispatcher(
    config(),
    testLogger,
    msg => received.push(msg),
    'bot-open-id',
    messageSender,
  );
  const handle = dispatcher.handles.get('im.message.receive_v1');
  if (!handle) throw new Error('message handler was not registered');
  return { received, logger: testLogger, handle: (data: unknown) => handle(data) };
}

describe('Feishu replied-message routing', () => {
  it('ignores unmentioned messages and attaches only the exact replied cached media', async () => {
    const { received, handle } = messageHandler();
    await handle(event({ messageId: 'text-unmentioned', content: { text: 'not for this bot' } }));
    await handle(event({
      messageId: 'file-1',
      messageType: 'file',
      content: { file_key: 'key-1', file_name: 'first.pdf' },
    }));
    await handle(event({
      messageId: 'file-2',
      messageType: 'file',
      content: { file_key: 'key-2', file_name: 'second.pdf' },
    }));
    expect(received).toEqual([]);

    await handle(event({
      messageId: 'bare-mention',
      content: { text: '@_bot_open_id no reply' },
      mentions: ['bot-open-id'],
    }));
    expect(received[0].extraMedia).toBeUndefined();

    await handle(event({
      messageId: 'reply-file-2',
      content: { text: '@_bot_open_id read this' },
      parentId: 'file-2',
      mentions: ['bot-open-id'],
    }));
    expect(received[1].extraMedia).toEqual([{
      messageId: 'file-2',
      fileKey: 'key-2',
      fileName: 'second.pdf',
    }]);

    await handle(event({
      messageId: 'reply-file-1',
      content: { text: '@_bot_open_id read the other' },
      parentId: 'file-1',
      mentions: ['bot-open-id'],
    }));
    expect(received[2].extraMedia).toEqual([{
      messageId: 'file-1',
      fileKey: 'key-1',
      fileName: 'first.pdf',
    }]);
  });

  it('keeps cached attachment fallback state isolated between bot dispatchers', async () => {
    const firstBot = messageHandler();
    const secondBot = messageHandler();
    await firstBot.handle(event({
      messageId: 'isolated-file',
      messageType: 'file',
      content: { file_key: 'isolated-key', file_name: 'isolated.pdf' },
    }));

    const reply = event({
      messageId: 'reply-isolated-file',
      content: { text: '@_bot_open_id inspect' },
      parentId: 'isolated-file',
      mentions: ['bot-open-id'],
    });
    await secondBot.handle(reply);
    await firstBot.handle(reply);

    expect(secondBot.received[0].extraMedia).toBeUndefined();
    expect(firstBot.received[0].extraMedia).toEqual([{
      messageId: 'isolated-file',
      fileKey: 'isolated-key',
      fileName: 'isolated.pdf',
    }]);
  });

  it('uses cached fallback only with exact same-chat provenance when lookup is unavailable', async () => {
    const messageSender = { getMessage: vi.fn(async () => undefined) };
    const { received, handle } = messageHandler(messageSender);
    await handle(event({
      messageId: 'same-chat-file',
      messageType: 'file',
      content: { file_key: 'same-chat-key', file_name: 'same-chat.pdf' },
    }));
    await handle(event({
      messageId: 'reply-same-chat-file',
      content: { text: '@_bot_open_id inspect' },
      parentId: 'same-chat-file',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].extraMedia).toEqual([{
      messageId: 'same-chat-file',
      fileKey: 'same-chat-key',
      fileName: 'same-chat.pdf',
    }]);
  });

  it('fails closed when a fetched snapshot has no chat provenance, including cached media', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'missing-chat-file',
        messageType: 'file',
        content: JSON.stringify({ file_key: 'lookup-key', file_name: 'lookup.pdf' }),
      })),
    };
    const { received, logger: testLogger, handle } = messageHandler(messageSender);
    await handle(event({
      messageId: 'missing-chat-file',
      messageType: 'file',
      content: { file_key: 'cached-key', file_name: 'cached.pdf' },
    }));
    await handle(event({
      messageId: 'reply-missing-chat-file',
      content: { text: '@_bot_open_id inspect' },
      parentId: 'missing-chat-file',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toBeUndefined();
    expect(received[0].extraMedia).toBeUndefined();
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'missing-chat-file', chatId: 'chat-1' }),
      'Ignoring reply reference without chat provenance',
    );
  });

  it.each([
    [
      'text',
      { text: 'original text' },
      { messageId: 'parent', messageType: 'text', text: 'original text' },
      undefined,
    ],
    [
      'post',
      { zh_cn: { title: 'Report', content: [[{ tag: 'text', text: 'Body ' }, { tag: 'img', image_key: 'post-image' }]] } },
      { messageId: 'parent', messageType: 'post', text: 'Report\nBody [Image 1]' },
      [{ messageId: 'parent', imageKey: 'post-image' }],
    ],
    [
      'image',
      { image_key: 'image-key' },
      { messageId: 'parent', messageType: 'image' },
      [{ messageId: 'parent', imageKey: 'image-key' }],
    ],
    [
      'file',
      { file_key: 'file-key', file_name: 'paper.pdf' },
      { messageId: 'parent', messageType: 'file' },
      [{ messageId: 'parent', fileKey: 'file-key', fileName: 'paper.pdf' }],
    ],
  ] as const)('resolves a replied %s snapshot into explicit context', async (
    messageType,
    content,
    expectedReplyContext,
    expectedMedia,
  ) => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'parent',
        chatId: 'chat-1',
        messageType,
        content: JSON.stringify(content),
      })),
    };
    const { received, handle } = messageHandler(messageSender);

    await handle(event({
      messageId: `reply-${messageType}`,
      content: { text: '@_bot_open_id inspect this' },
      parentId: 'parent',
      mentions: ['bot-open-id'],
    }));

    expect(messageSender.getMessage).toHaveBeenCalledWith('parent');
    expect(received[0].replyContext).toEqual(expectedReplyContext);
    expect(received[0].extraMedia).toEqual(expectedMedia);
  });

  it('accepts a reply containing only the bot mention', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'mention-only-parent',
        chatId: 'chat-1',
        messageType: 'file',
        content: JSON.stringify({ file_key: 'mention-key', file_name: 'mention.pdf' }),
      })),
    };
    const { received, handle } = messageHandler(messageSender);
    await handle(event({
      messageId: 'mention-only-reply',
      content: { text: '@_bot_open_id' },
      parentId: 'mention-only-parent',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].text).toBe('请处理我回复的消息');
    expect(received[0].extraMedia?.[0]).toMatchObject({
      messageId: 'mention-only-parent',
      fileName: 'mention.pdf',
    });
  });

  it.each([
    ['body.elements', { body: { elements: [{ tag: 'markdown', content: 'schema v2 answer' }] } }, 'schema v2 answer'],
    ['card.elements', { card: { elements: [{ tag: 'markdown', content: 'wrapped answer' }] } }, 'wrapped answer'],
    ['i18n_elements', { i18n_elements: { zh_cn: [{ tag: 'markdown', content: '中文答案' }] } }, '中文答案'],
    ['legacy rows', { elements: [[{ tag: 'text', text: 'row one' }], [{ tag: 'a', text: 'row two' }]] }, 'row one\n\nrow two'],
    [
      'table values',
      {
        body: {
          elements: [{
            tag: 'table',
            columns: [
              { name: 'metric', display_name: 'Metric' },
              { name: 'count', display_name: 'Count' },
              { name: 'passed', display_name: 'Passed' },
            ],
            rows: [{ metric: 'tests', count: 42, passed: true }],
          }],
        },
      },
      'Metric | Count | Passed\n\ntests | 42 | true',
    ],
    [
      'control-label fallback',
      { elements: [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Approve' } }] }] },
      'Approve',
    ],
    ['summary fallback', { config: { summary: { content: 'summary answer' } }, body: { elements: [] } }, 'summary answer'],
    ['generic fallback', { unknown: { rows: [{ tag: 'plain_text', content: 'deep answer' }] } }, 'deep answer'],
  ])('extracts an interactive card from the %s read-back shape', async (_shape, card, expected) => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'card-parent',
        chatId: 'chat-1',
        messageType: 'interactive',
        content: JSON.stringify(card),
      })),
    };
    const { received, handle } = messageHandler(messageSender);

    await handle(event({
      messageId: `reply-card-${_shape}`,
      content: { text: '@_bot_open_id continue' },
      parentId: 'card-parent',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'card-parent',
      messageType: 'interactive',
      text: expected,
    });
  });

  it.each([
    ['schema-v1', buildCard],
    ['schema-v2', buildCardV2],
  ])('strips MetaBot status chrome from a referenced %s card', async (_schema, cardBuilder) => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'metabot-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        content: cardBuilder({
          status: 'complete',
          userPrompt: 'question',
          responseText: '**Actual answer**',
          toolCalls: [],
          goalCondition: 'finish the review',
          teamState: {
            name: 'review-team',
            teammates: [{ name: 'reviewer', status: 'working' }],
            tasks: [{ taskId: '1', subject: 'review', status: 'in_progress', teammate: 'reviewer' }],
          },
          totalTokens: 1_000,
          contextWindow: 1_000_000,
          model: 'test-model',
        }),
      })),
    };
    const { received, handle } = messageHandler(messageSender);

    await handle(event({
      messageId: `reply-${_schema}`,
      content: { text: '@_bot_open_id continue' },
      parentId: 'metabot-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'metabot-card',
      messageType: 'interactive',
      text: '**Actual answer**',
    });
  });

  it.each([
    ['another bot', { id: 'cli_other_app', sender_type: 'app' }],
    ['an unidentified third party', undefined],
  ])('preserves a same-chat card authored by %s', async (_author, sender) => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'foreign-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender,
        content: JSON.stringify({ elements: [{ tag: 'markdown', content: 'foreign visible answer' }] }),
      })),
    };
    const { received, handle } = messageHandler(messageSender);
    await handle(event({
      messageId: `reply-${_author}`,
      content: { text: '@_bot_open_id use this' },
      parentId: 'foreign-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext?.text).toBe('foreign visible answer');
  });

  it('rejects cross-chat context and bounds long referenced text', async () => {
    const getMessage = vi.fn()
      .mockResolvedValueOnce({
        messageId: 'cross-chat',
        chatId: 'chat-2',
        messageType: 'text',
        content: JSON.stringify({ text: 'must not leak' }),
      })
      .mockResolvedValueOnce({
        messageId: 'long-parent',
        chatId: 'chat-1',
        messageType: 'interactive',
        content: JSON.stringify({ elements: [{ tag: 'markdown', content: 'x'.repeat(20_000) }] }),
      });
    const { received, logger: testLogger, handle } = messageHandler({ getMessage });

    await handle(event({
      messageId: 'cross-chat',
      messageType: 'file',
      content: { file_key: 'cached-cross-chat-key', file_name: 'cached-cross-chat.pdf' },
    }));
    await handle(event({
      messageId: 'reply-cross-chat',
      content: { text: '@_bot_open_id quote it' },
      parentId: 'cross-chat',
      mentions: ['bot-open-id'],
    }));
    expect(received[0].replyContext).toBeUndefined();
    expect(received[0].extraMedia).toBeUndefined();
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ referencedChatId: 'chat-2' }),
      'Ignoring cross-chat reply reference',
    );

    await handle(event({
      messageId: 'reply-long-parent',
      content: { text: '@_bot_open_id summarize' },
      parentId: 'long-parent',
      mentions: ['bot-open-id'],
    }));
    expect(received[1].replyContext?.truncated).toBe(true);
    expect(received[1].replyContext?.text).toHaveLength(16_031);
  });
});

describe('Feishu event handler mention routing', () => {
  it('only treats an exact mention of the current bot as addressed to it', () => {
    const foreignMentions = [
      { id: { open_id: 'ou_other_bot' }, name: 'Other Bot' },
      { id: { open_id: 'ou_group_member' }, name: 'Group Member' },
    ];

    expect(isBotMentioned(foreignMentions, 'ou_current_bot')).toBe(false);
    expect(
      isBotMentioned(
        [...foreignMentions, { id: { open_id: 'ou_current_bot' }, name: 'Current Bot' }],
        'ou_current_bot',
      ),
    ).toBe(true);
  });

  it('fails closed when the current bot open_id or mention shape is unavailable', () => {
    expect(isBotMentioned([{ id: { open_id: 'ou_other_bot' } }])).toBe(false);
    expect(isBotMentioned(undefined, 'ou_current_bot')).toBe(false);
    expect(isBotMentioned([null, {}, { id: {} }], 'ou_current_bot')).toBe(false);
  });
});

describe('Feishu group reply mode policy', () => {
  it('parses supported English and Chinese commands without matching unrelated commands', () => {
    expect(parseGroupReplyModeCommand('/group-reply all')).toEqual({ action: 'set', mode: 'all' });
    expect(parseGroupReplyModeCommand('/group-reply mention')).toEqual({ action: 'set', mode: 'mention' });
    expect(parseGroupReplyModeCommand('/group_mode @')).toEqual({ action: 'set', mode: 'mention' });
    expect(parseGroupReplyModeCommand('/群回复 全部')).toEqual({ action: 'set', mode: 'all' });
    expect(parseGroupReplyModeCommand('/群回复 仅@')).toEqual({ action: 'set', mode: 'mention' });
    expect(parseGroupReplyModeCommand('/group-reply status')).toEqual({ action: 'status' });
    expect(parseGroupReplyModeCommand('/group-reply invalid')).toEqual({ action: 'help' });
    expect(parseGroupReplyModeCommand('/status')).toBeUndefined();
    expect(parseGroupReplyModeCommand('please /group-reply all')).toBeUndefined();
  });

  it('gives an explicit Agent-and-group mode precedence over global and two-person defaults', () => {
    expect(shouldProcessGroupMessage({ botMentioned: true, storedMode: 'mention' })).toBe(true);
    expect(
      shouldProcessGroupMessage({
        botMentioned: false,
        storedMode: 'mention',
        configGroupNoMention: true,
        privateLikeGroup: true,
      }),
    ).toBe(false);
    expect(shouldProcessGroupMessage({ botMentioned: false, storedMode: 'all' })).toBe(true);
    expect(shouldProcessGroupMessage({ botMentioned: false, configGroupNoMention: true })).toBe(true);
    expect(shouldProcessGroupMessage({ botMentioned: false, privateLikeGroup: true })).toBe(true);
    expect(shouldProcessGroupMessage({ botMentioned: false })).toBe(false);
  });
});
