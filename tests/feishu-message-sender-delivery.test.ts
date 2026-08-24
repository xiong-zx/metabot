import { describe, expect, it, vi } from 'vitest';
import { MessageSender, classifyFeishuDeliveryError } from '../src/feishu/message-sender.js';

describe('Feishu delivery error classification', () => {
  it('classifies a table-limit response as non-retryable and logs no request credentials', async () => {
    const credential = 'credential-must-not-appear';
    const patch = vi.fn().mockRejectedValue({
      response: {
        status: 400,
        data: {
          code: 230099,
          msg: 'Failed to create card content, ErrCode: 11310; card table number over limit',
        },
        headers: { 'x-request-id': 'req-card-limit' },
      },
      config: {
        headers: {
          Authorization: `Bearer ${credential}`,
          tenant_access_token: credential,
          Cookie: `session=${credential}`,
        },
      },
    });
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as any;
    const client = { im: { v1: { message: { patch } } } } as any;
    const sender = new MessageSender(client, logger);

    await expect(sender.updateCard('om_test', '{}')).resolves.toEqual({
      ok: false,
      category: 'payload',
      retryable: false,
      httpStatus: 400,
      providerCode: 230099,
      providerSubcode: '11310',
      requestId: 'req-card-limit',
    });

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('om_test');
    expect(logged).toContain('req-card-limit');
    expect(logged).toContain('230099');
    expect(logged).not.toContain(credential);
    expect(logged).not.toContain('Authorization');
    expect(logged).not.toContain('tenant_access_token');
    expect(logged).not.toContain('Cookie');
  });

  it('classifies HTTP 504 and network failures as retryable', () => {
    expect(classifyFeishuDeliveryError({ response: { status: 504 } })).toMatchObject({
      category: 'transient',
      retryable: true,
      httpStatus: 504,
    });
    expect(classifyFeishuDeliveryError({ code: 'ECONNRESET' })).toMatchObject({
      category: 'unknown',
      retryable: true,
      providerCode: 'ECONNRESET',
    });
  });
});
