import * as lark from '@larksuiteoapi/node-sdk';
import { DEFAULT_FEISHU_DOMAIN, parseFeishuDomain, type FeishuDomain } from './domain.js';

type RestClientOptions = ConstructorParameters<typeof lark.Client>[0];
type WsClientOptions = ConstructorParameters<typeof lark.WSClient>[0];

/** Map MetaBot's tenant label to the official SDK endpoint selector. */
export function toLarkSdkDomain(domain: FeishuDomain = DEFAULT_FEISHU_DOMAIN): lark.Domain {
  return parseFeishuDomain(domain) === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
}

/** Build a REST client while preserving the existing Feishu channel naming. */
export function createFeishuRestClient(domain: FeishuDomain, options: Omit<RestClientOptions, 'domain'>): lark.Client {
  return new lark.Client({
    ...options,
    domain: toLarkSdkDomain(domain),
  });
}

/**
 * Build the long-connection client with a tenant fixed at construction time.
 * The SDK reuses this value for its initial handshake and all reconnects.
 */
export function createFeishuWsClient(domain: FeishuDomain, options: Omit<WsClientOptions, 'domain'>): lark.WSClient {
  return new lark.WSClient({
    ...options,
    domain: toLarkSdkDomain(domain),
  });
}
