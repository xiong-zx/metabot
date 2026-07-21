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
) {
  const received: IncomingMessage[] = [];
  const dispatcher = createEventDispatcher(
    config(groupNoMention),
    logger(),
    msg => received.push(msg),
    botOpenId,
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
      text: 'read remaining files',
      mentions: ['bot-open-id'],
    }));
    expect(received[1].extraMedia).toEqual([{
      messageId: 'file-1',
      fileKey: 'key-1',
      fileName: 'first.pdf',
    }]);
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
