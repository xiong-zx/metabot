import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  Client: vi.fn(function Client(options: unknown) {
    return { options };
  }),
  WSClient: vi.fn(function WSClient(options: unknown) {
    return { options };
  }),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: sdk.Client,
  WSClient: sdk.WSClient,
  Domain: { Feishu: 0, Lark: 1 },
}));

import { createFeishuRestClient, createFeishuWsClient, toLarkSdkDomain } from '../src/feishu/client-factory.js';

beforeEach(() => vi.clearAllMocks());

describe('Feishu/Lark SDK client factory', () => {
  it('maps the compatibility config to official SDK domains', () => {
    expect(toLarkSdkDomain('feishu')).toBe(0);
    expect(toLarkSdkDomain('lark')).toBe(1);
    expect(toLarkSdkDomain()).toBe(0);
  });

  it('passes the Lark domain to REST clients', () => {
    createFeishuRestClient('lark', {
      appId: 'cli_test',
      appSecret: 'test-only',
      disableTokenCache: false,
    });

    expect(sdk.Client).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'cli_test',
        domain: 1,
      }),
    );
  });

  it('passes the domain through the WebSocket watchdog and reconnect setup', () => {
    createFeishuWsClient('lark', {
      appId: 'cli_test',
      appSecret: 'test-only',
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 20 },
    });

    expect(sdk.WSClient).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 1,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        wsConfig: { pingTimeout: 20 },
      }),
    );
  });
});
