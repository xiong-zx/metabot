export type FeishuDomain = 'feishu' | 'lark';

export const DEFAULT_FEISHU_DOMAIN: FeishuDomain = 'feishu';

/**
 * Resolve the API tenant for the existing Feishu-compatible channel.
 * Omitted values keep the historical Feishu endpoint; any explicit unknown
 * value fails closed so credentials are never sent to the wrong API host.
 */
export function parseFeishuDomain(value: unknown, source = 'feishuDomain'): FeishuDomain {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_FEISHU_DOMAIN;
  }
  if (value === 'feishu' || value === 'lark') return value;
  throw new Error(`${source} must be "feishu" or "lark"`);
}
