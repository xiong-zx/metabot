import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/config.js';
import {
  createEventDispatcher,
  isBotMentioned,
  parseGroupReplyModeCommand,
  shouldProcessGroupMessage,
} from '../src/feishu/event-handler.js';
import { buildCard } from '../src/feishu/card-builder.js';
import { buildCardV2 } from '../src/feishu/card-builder-v2.js';
import { buildPromptWithReplyContext } from '../src/bridge/message-bridge.js';
import type { IncomingMessage } from '../src/types.js';

function config(groupNoMention = false): BotConfig {
  return {
    name: 'test-bot',
    groupNoMention,
    feishu: { appId: 'cli_self_app', appSecret: 'secret' },
  } as BotConfig;
}

/** Feishu reports this bot's own cards with `sender.id` = app_id or open_id. */
const SELF_CARD_SENDER = { id: 'cli_self_app', idType: 'app_id', senderType: 'app' };

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
  messageType?: 'text' | 'file';
  text?: string;
  fileKey?: string;
  fileName?: string;
  mentions?: string[];
  parentId?: string;
  senderType?: string;
}) {
  const messageType = input.messageType ?? 'text';
  return {
    sender: {
      sender_type: input.senderType ?? 'user',
      sender_id: { open_id: 'user-open-id' },
    },
    message: {
      message_id: input.messageId,
      message_type: messageType,
      chat_id: 'chat-1',
      chat_type: 'group',
      parent_id: input.parentId,
      mentions: input.mentions?.map(openId => ({ id: { open_id: openId } })),
      content: messageType === 'file'
        ? JSON.stringify({ file_key: input.fileKey, file_name: input.fileName })
        : JSON.stringify({ text: input.text ?? 'hello' }),
    },
  };
}

function messageHandler(
  groupNoMention = false,
  botOpenId: string | undefined = 'bot-open-id',
  messageSender?: any,
) {
  const received: IncomingMessage[] = [];
  const testLogger = logger();
  const dispatcher = createEventDispatcher(
    config(groupNoMention),
    testLogger,
    msg => received.push(msg),
    botOpenId,
    messageSender,
  );
  const handle = dispatcher.handles.get('im.message.receive_v1');
  if (!handle) throw new Error('message handler was not registered');
  return { received, logger: testLogger, handle: (data: unknown) => handle(data) };
}

describe('Feishu inbound message routing', () => {
  it('does not send unmentioned group text into the bot context', async () => {
    const { received, handle } = messageHandler();

    await handle(event({ messageId: 'text-1', text: 'not for the bot' }));

    expect(received).toEqual([]);
  });

  it('attaches only the file referenced by the replied message', async () => {
    const { received, handle } = messageHandler();
    await handle(event({
      messageId: 'file-1',
      messageType: 'file',
      fileKey: 'key-1',
      fileName: 'first.pdf',
    }));
    await handle(event({
      messageId: 'file-2',
      messageType: 'file',
      fileKey: 'key-2',
      fileName: 'second.pdf',
    }));
    expect(received).toEqual([]);

    await handle(event({
      messageId: 'reply-1',
      text: 'read this file',
      parentId: 'file-2',
      mentions: ['bot-open-id'],
    }));

    expect(received).toHaveLength(1);
    expect(received[0].extraMedia).toEqual([{
      messageId: 'file-2',
      fileKey: 'key-2',
      fileName: 'second.pdf',
    }]);

    await handle(event({
      messageId: 'reply-2',
      text: 'do not attach unreferenced files',
      mentions: ['bot-open-id'],
    }));
    expect(received[1].extraMedia).toBeUndefined();

    await handle(event({
      messageId: 'reply-3',
      text: 'read the first file',
      parentId: 'file-1',
      mentions: ['bot-open-id'],
    }));
    expect(received[2].extraMedia).toEqual([{
      messageId: 'file-1',
      fileKey: 'key-1',
      fileName: 'first.pdf',
    }]);
  });

  it('loads an unmentioned replied text message into explicit reply context', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'original-text',
        chatId: 'chat-1',
        messageType: 'text',
        content: JSON.stringify({ text: 'original message without a mention' }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-text',
      text: 'analyze the quoted message',
      parentId: 'original-text',
      mentions: ['bot-open-id'],
    }));

    expect(messageSender.getMessage).toHaveBeenCalledWith('original-text');
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('analyze the quoted message');
    expect(received[0].replyContext).toEqual({
      messageId: 'original-text',
      messageType: 'text',
      text: 'original message without a mention',
    });
  });

  it('loads a referenced schema-v2 interactive card into explicit reply context', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'bot-card-v2',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: SELF_CARD_SENDER,
        content: JSON.stringify({
          schema: '2.0',
          config: { summary: { content: 'short fallback' } },
          body: {
            elements: [
              { tag: 'markdown', content: '**Main answer**' },
              {
                tag: 'div',
                text: { tag: 'lark_md', content: 'Detailed explanation' },
                fields: [{
                  is_short: true,
                  text: { tag: 'lark_md', content: 'Field detail' },
                }],
              },
              {
                tag: 'table',
                columns: [
                  { name: 'name', display_name: 'Name' },
                  { name: 'value', display_name: 'Value' },
                ],
                rows: [{ name: 'alpha', value: '42' }],
              },
              {
                tag: 'column_set',
                columns: [{
                  tag: 'column',
                  elements: [{ tag: 'markdown', content: 'Column answer' }],
                }],
              },
              {
                tag: 'column_set',
                background_style: 'grey',
                columns: [{
                  tag: 'column',
                  elements: [{
                    tag: 'markdown',
                    content: '<font color="grey" size="2">_ctx: 1k/1m | $0.01_</font>',
                  }],
                }],
              },
            ],
          },
        }),
      })),
    };
    const { received, logger: testLogger, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-card-v2',
      text: 'continue from this answer',
      parentId: 'bot-card-v2',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'bot-card-v2',
      messageType: 'interactive',
      text: '**Main answer**\n\nDetailed explanation\n\nField detail\n\nName | Value\n\nalpha | 42\n\nColumn answer',
    });
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: 'bot-card-v2',
        referencedMessageType: 'interactive',
        parsedMessageType: 'interactive',
      }),
      'Resolved replied message context',
    );
  });

  it('loads a referenced schema-v1 interactive card into explicit reply context', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'bot-card-v1',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: SELF_CARD_SENDER,
        content: JSON.stringify({
          elements: [
            { tag: 'markdown', content: 'Original answer' },
            {
              tag: 'note',
              elements: [{ tag: 'plain_text', content: 'model and token footer' }],
            },
          ],
        }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-card-v1',
      text: 'use this',
      parentId: 'bot-card-v1',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'bot-card-v1',
      messageType: 'interactive',
      text: 'Original answer',
    });
  });

  it.each([
    ['schema-v1', buildCard],
    ['schema-v2', buildCardV2],
  ])('strips MetaBot status chrome from a referenced %s card', async (_schema, cardBuilder) => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'full-metabot-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: SELF_CARD_SENDER,
        content: cardBuilder({
          status: 'complete',
          userPrompt: 'question',
          responseText: '**Actual answer**',
          toolCalls: [],
          lifecycleStage: 'responding',
          lifecycleKey: 'turn-123',
          goalCondition: 'finish the investigation',
          teamState: {
            name: 'review-team@chat:chat-1',
            agents: [{ name: 'reviewer', status: 'working', lastSubject: 'audit parser' }],
            tasks: [{ taskId: 'task-1', subject: 'audit parser', status: 'in_progress', agent: 'reviewer' }],
          },
          backgroundEvents: [{
            taskId: 'background-123',
            description: 'watch tests',
            status: 'running',
            lastEvent: 'still running',
          }],
          totalTokens: 1_000,
          contextWindow: 1_000_000,
          model: 'test-model',
        }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-full-card',
      text: 'continue from the answer',
      parentId: 'full-metabot-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'full-metabot-card',
      messageType: 'interactive',
      text: '**Actual answer**',
    });
  });

  // F-4: the tool-status line is only emitted while a turn is in flight, so the
  // chrome test above (status: 'complete') never exercises it. Drive the REAL
  // builders with a running tool call to keep METABOT_TOOL_STATUS_PATTERN
  // coupled to the format the builders actually emit.
  it.each([
    ['schema-v1', buildCard],
    ['schema-v2', buildCardV2],
  ])('strips in-flight tool status chrome from a referenced %s card', async (_schema, cardBuilder) => {
    const content = cardBuilder({
      status: 'running',
      userPrompt: 'question',
      responseText: 'partial answer so far',
      toolCalls: [
        { name: 'Read', status: 'done' },
        { name: 'Bash', status: 'running' },
      ],
      totalTokens: 1_000,
      contextWindow: 1_000_000,
      model: 'test-model',
    } as any);
    // Guard the coupling itself: if the builder stops emitting the line, this
    // test would pass vacuously.
    expect(content).toContain('**Bash**');

    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'in-flight-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: SELF_CARD_SENDER,
        content,
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-in-flight-card',
      text: 'what are you doing',
      parentId: 'in-flight-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'in-flight-card',
      messageType: 'interactive',
      text: 'partial answer so far',
    });
  });

  // F-1: Feishu does not contractually guarantee the read-back envelope for an
  // interactive message, so extraction must recover text from every plausible
  // shape rather than only the one our card builders emit.
  it.each([
    [
      'bare elements wrapper',
      { elements: [{ tag: 'markdown', content: 'wrapped answer' }] },
      'wrapped answer',
    ],
    [
      'card.elements wrapper',
      { card: { elements: [{ tag: 'markdown', content: 'wrapped answer' }] } },
      'wrapped answer',
    ],
    [
      'card.body.elements wrapper',
      { card: { body: { elements: [{ tag: 'markdown', content: 'wrapped answer' }] } } },
      'wrapped answer',
    ],
    [
      'i18n_elements variant',
      {
        header: { title: { tag: 'plain_text', content: 'Header chrome' } },
        i18n_elements: {
          zh_cn: [{ tag: 'markdown', content: '中文答案' }],
          en_us: [{ tag: 'markdown', content: 'english answer' }],
        },
      },
      '中文答案',
    ],
    [
      'legacy nested-array rows of columns',
      {
        title: 'legacy card',
        elements: [
          [{ tag: 'text', text: 'legacy row one' }],
          [{ tag: 'text', text: 'legacy row two' }, { tag: 'a', text: 'legacy link' }],
        ],
      },
      'legacy row one\n\nlegacy row two\n\nlegacy link',
    ],
    [
      'div with a plain string text field',
      { elements: [{ tag: 'div', text: 'string div answer' }] },
      'string div answer',
    ],
    [
      'summary-only card',
      { schema: '2.0', config: { summary: { content: 'summary fallback' } }, body: { elements: [] } },
      'summary fallback',
    ],
    [
      'unknown envelope recovered by the generic walk',
      {
        schema: '2.0',
        unknown_container: { rows: [{ blocks: [{ tag: 'plain_text', content: 'deep answer' }] }] },
      },
      'deep answer',
    ],
    [
      'button-only card recovered by the fallback passes',
      { elements: [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Approve' } }] }] },
      'Approve',
    ],
  ])('recovers referenced card text from the %s read-back shape', async (_shape, card, expected) => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'shape-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: SELF_CARD_SENDER,
        content: JSON.stringify(card),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-shape-card',
      text: 'continue',
      parentId: 'shape-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'shape-card',
      messageType: 'interactive',
      text: expected,
    });
  });

  it('keeps numeric and boolean table cells in the quoted row', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'table-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: SELF_CARD_SENDER,
        content: JSON.stringify({
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
        }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-table-card',
      text: 'read the table',
      parentId: 'table-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext?.text).toBe('Metric | Count | Passed\n\ntests | 42 | true');
  });

  it('accepts a replied card authored by this bot under its open_id', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'own-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: { id: 'bot-open-id', idType: 'open_id', senderType: 'app' },
        content: JSON.stringify({ elements: [{ tag: 'markdown', content: 'my own answer' }] }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-own-card',
      text: 'continue',
      parentId: 'own-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'own-card',
      messageType: 'interactive',
      text: 'my own answer',
    });
  });

  // F-3: bot-to-bot content belongs on the agent bus, not scraped out of
  // another app's card. Fails closed when the author cannot be confirmed.
  it.each([
    ['another bot in the same group', { id: 'cli_other_app', idType: 'app_id', senderType: 'app' }],
    ['an unidentified author', undefined],
  ])('does not preserve a replied card authored by %s', async (_case, cardSender) => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'foreign-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: cardSender,
        content: JSON.stringify({ elements: [{ tag: 'markdown', content: 'SECRET from other-bot session' }] }),
      })),
    };
    const { received, logger: testLogger, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-foreign-card',
      text: 'continue',
      parentId: 'foreign-card',
      mentions: ['bot-open-id'],
    }));

    expect(received).toHaveLength(1);
    expect(received[0].replyContext).toBeUndefined();
    expect(received[0].extraMedia).toBeUndefined();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'foreign-card', messageType: 'interactive' }),
      'Referenced interactive card was not authored by this bot; skipping context preservation',
    );
  });

  it('records an empty referenced interactive card without warning noise', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'empty-bot-card',
        chatId: 'chat-1',
        messageType: 'interactive',
        sender: SELF_CARD_SENDER,
        content: JSON.stringify({
          elements: [
            { tag: 'hr' },
            {
              // MetaBot's own telemetry footer — the realistic "nothing to
              // quote" card. Must not be mistaken for the answer.
              tag: 'note',
              elements: [{ tag: 'plain_text', content: 'ctx: 1.0k/1000k (0%) | $0.01' }],
            },
          ],
        }),
      })),
    };
    const { received, logger: testLogger, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-empty-card',
      text: 'continue',
      parentId: 'empty-bot-card',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'empty-bot-card',
      messageType: 'interactive',
    });
    expect(testLogger.info).toHaveBeenCalledWith(
      { messageId: 'empty-bot-card', messageType: 'interactive' },
      'Referenced interactive card contained no extractable text',
    );
    // F-2: the empty case must never claim there are attached file paths.
    expect(buildPromptWithReplyContext('continue', received[0].replyContext))
      .not.toContain('see the attached file paths below');
  });

  it('records an unsupported referenced message type without warning noise', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'unsupported-audio',
        chatId: 'chat-1',
        messageType: 'audio',
        content: JSON.stringify({ file_key: 'audio-key' }),
      })),
    };
    const { received, logger: testLogger, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-audio',
      text: 'what was that',
      parentId: 'unsupported-audio',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toBeUndefined();
    expect(testLogger.info).toHaveBeenCalledWith(
      { messageId: 'unsupported-audio', messageType: 'audio' },
      'Referenced message type is unsupported',
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        referencedMessageType: 'audio',
        parsedMessageType: undefined,
      }),
      'Resolved replied message context',
    );
  });

  it('loads a referenced file through message lookup after the cache is unavailable', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'old-file',
        chatId: 'chat-1',
        messageType: 'file',
        content: JSON.stringify({ file_key: 'old-key', file_name: 'old.pdf' }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'reply-old-file',
      text: 'read the referenced file',
      parentId: 'old-file',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext).toEqual({
      messageId: 'old-file',
      messageType: 'file',
    });
    expect(received[0].extraMedia).toEqual([{
      messageId: 'old-file',
      fileKey: 'old-key',
      fileName: 'old.pdf',
    }]);
  });

  it('accepts a reply that contains only the bot mention', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'mention-only-file',
        chatId: 'chat-1',
        messageType: 'file',
        content: JSON.stringify({ file_key: 'mention-key', file_name: 'mention.pdf' }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'mention-only-reply',
      text: '@_bot_open_id',
      parentId: 'mention-only-file',
      mentions: ['bot-open-id'],
    }));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('请处理我回复的消息');
    expect(received[0].extraMedia?.[0]).toMatchObject({
      messageId: 'mention-only-file',
      fileName: 'mention.pdf',
    });
  });

  it('does not inject a referenced message from another chat', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'cross-chat-message',
        chatId: 'another-chat',
        messageType: 'text',
        content: JSON.stringify({ text: 'private context from elsewhere' }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'cross-chat-reply',
      text: 'try to quote another chat',
      parentId: 'cross-chat-message',
      mentions: ['bot-open-id'],
    }));

    expect(received).toHaveLength(1);
    expect(received[0].replyContext).toBeUndefined();
    expect(received[0].extraMedia).toBeUndefined();
  });

  it('bounds quoted text before it enters model context', async () => {
    const messageSender = {
      getMessage: vi.fn(async () => ({
        messageId: 'long-text',
        chatId: 'chat-1',
        messageType: 'text',
        content: JSON.stringify({ text: 'x'.repeat(20_000) }),
      })),
    };
    const { received, handle } = messageHandler(false, 'bot-open-id', messageSender);

    await handle(event({
      messageId: 'long-reply',
      text: 'summarize',
      parentId: 'long-text',
      mentions: ['bot-open-id'],
    }));

    expect(received[0].replyContext?.truncated).toBe(true);
    expect(received[0].replyContext?.text).toHaveLength(16_031);
    expect(received[0].replyContext?.text).toContain('[Referenced message truncated]');
  });

  it('ignores bot-authored messages even when no-mention mode is enabled', async () => {
    const { received, handle } = messageHandler(true);

    await handle(event({
      messageId: 'bot-1',
      text: 'message from another bot',
      senderType: 'app',
      mentions: ['bot-open-id'],
    }));

    expect(received).toEqual([]);
  });

  it('deduplicates repeated Feishu events by message_id', async () => {
    const { received, handle } = messageHandler();
    const data = event({
      messageId: 'duplicate-1',
      text: 'run once',
      mentions: ['bot-open-id'],
    });

    await handle(data);
    await handle(data);

    expect(received).toHaveLength(1);
  });

  it('keeps pending attachment state isolated between bot dispatchers', async () => {
    const first = messageHandler();
    const second = messageHandler();
    const file = event({
      messageId: 'shared-file',
      messageType: 'file',
      fileKey: 'shared-key',
      fileName: 'shared.pdf',
    });
    await first.handle(file);
    await second.handle(file);

    const reply = event({
      messageId: 'shared-reply',
      text: 'read replied file',
      parentId: 'shared-file',
      mentions: ['bot-open-id'],
    });
    await first.handle(reply);
    await second.handle(reply);

    expect(first.received[0].extraMedia).toHaveLength(1);
    expect(second.received[0].extraMedia).toHaveLength(1);
  });

  it('fails closed when the bot open id is unavailable', async () => {
    const { received, handle } = messageHandler(false, undefined);

    await handle(event({
      messageId: 'mention-unknown',
      text: 'mentions another bot',
      mentions: ['some-other-bot'],
    }));

    expect(received).toEqual([]);
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
