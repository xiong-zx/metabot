import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/config.js';
import { createEventDispatcher } from '../src/feishu/event-handler.js';
import type { IncomingMessage } from '../src/types.js';

function config(groupNoMention = false): BotConfig {
  return {
    name: 'test-bot',
    groupNoMention,
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
  const dispatcher = createEventDispatcher(
    config(groupNoMention),
    logger(),
    msg => received.push(msg),
    botOpenId,
    messageSender,
  );
  const handle = dispatcher.handles.get('im.message.receive_v1');
  if (!handle) throw new Error('message handler was not registered');
  return { received, handle: (data: unknown) => handle(data) };
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
