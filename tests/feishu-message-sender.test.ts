import { describe, expect, it, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

describe('MessageSender.getMessage', () => {
  it('returns the message snapshot needed to resolve a reply', async () => {
    const get = vi.fn(async () => ({
      data: {
        items: [{
          message_id: 'om-parent',
          chat_id: 'oc-chat',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'quoted body' }) },
        }],
      },
    }));
    const sender = new MessageSender({ im: { v1: { message: { get } } } } as any, logger());

    await expect(sender.getMessage('om-parent')).resolves.toEqual({
      messageId: 'om-parent',
      chatId: 'oc-chat',
      messageType: 'text',
      content: JSON.stringify({ text: 'quoted body' }),
    });
    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om-parent' },
      params: { user_id_type: 'open_id' },
    });
  });

  it('returns undefined instead of fabricating context when lookup fails', async () => {
    const log = logger();
    const sender = new MessageSender({
      im: { v1: { message: { get: vi.fn(async () => { throw new Error('forbidden'); }) } } },
    } as any, log);

    await expect(sender.getMessage('om-parent')).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
