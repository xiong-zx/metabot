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
  it('returns the exact referenced message snapshot through the injected Feishu/Lark client', async () => {
    const get = vi.fn(async () => ({
      data: {
        items: [
          {
            message_id: 'other-message',
            chat_id: 'other-chat',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'not selected' }) },
          },
          {
            message_id: 'om-parent',
            chat_id: 'oc-chat',
            msg_type: 'post',
            body: { content: JSON.stringify({ text: 'quoted body' }) },
          },
        ],
      },
    }));
    const sender = new MessageSender({ im: { v1: { message: { get } } } } as any, logger());

    await expect(sender.getMessage('om-parent')).resolves.toEqual({
      messageId: 'om-parent',
      chatId: 'oc-chat',
      messageType: 'post',
      content: JSON.stringify({ text: 'quoted body' }),
    });
    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om-parent' },
      params: { user_id_type: 'open_id' },
    });
  });

  it('returns undefined when lookup produces no usable item', async () => {
    const log = logger();
    const sender = new MessageSender({
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [{ message_id: 'another-message' }] } })),
          },
        },
      },
    } as any, log);

    await expect(sender.getMessage('om-missing')).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      { messageId: 'om-missing' },
      'Referenced message lookup returned no message',
    );
  });

  it('fails closed instead of fabricating context when lookup fails', async () => {
    const credential = 'snapshot-credential-must-not-appear';
    const log = logger();
    const sender = new MessageSender({
      im: {
        v1: {
          message: {
            get: vi.fn(async () => {
              throw {
                response: {
                  status: 403,
                  data: { code: 230001, msg: 'forbidden' },
                  headers: { 'x-request-id': 'req-snapshot-denied' },
                },
                config: {
                  headers: {
                    Authorization: `Bearer ${credential}`,
                    Cookie: `session=${credential}`,
                  },
                },
              };
            }),
          },
        },
      },
    } as any, log);

    await expect(sender.getMessage('om-parent')).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'om-parent',
        category: 'authentication',
        retryable: false,
        httpStatus: 403,
        providerCode: 230001,
        requestId: 'req-snapshot-denied',
      }),
      'Failed to get referenced message',
    );
    const serialized = JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Cookie');
  });
});
