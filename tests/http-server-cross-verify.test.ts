import { describe, it, expect } from 'vitest';
import { isCrossVerifyRoute, summarizeChannelStatuses } from '../src/api/http-server.js';

describe('isCrossVerifyRoute', () => {
  it('accepts the talk RPC routes', () => {
    expect(isCrossVerifyRoute('POST', '/api/talk')).toBe(true);
    expect(isCrossVerifyRoute('POST', '/api/talk?async=true')).toBe(true);
    expect(isCrossVerifyRoute('POST', '/api/tasks')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/talk/abc-123')).toBe(true);
  });

  it('keeps core-chat delivery out of generic cross-verified bearer routes', () => {
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs?source=core')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs/run-123/cancel')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs/run-123/cancel?retry=1')).toBe(false);
  });

  it('accepts the read-only peer-discovery routes', () => {
    expect(isCrossVerifyRoute('GET', '/api/bots')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/bots?foo=1')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/skills')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/peers')).toBe(true);
  });

  it('rejects write operations on the read-only routes', () => {
    expect(isCrossVerifyRoute('POST', '/api/bots')).toBe(false);
    expect(isCrossVerifyRoute('PUT', '/api/bots/goku')).toBe(false);
    expect(isCrossVerifyRoute('DELETE', '/api/bots/goku')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/skills')).toBe(false);
  });

  it('rejects per-name detail routes (only the list endpoint is shared)', () => {
    expect(isCrossVerifyRoute('GET', '/api/bots/goku')).toBe(false);
    expect(isCrossVerifyRoute('GET', '/api/bots/goku/profile')).toBe(false);
  });

  it('rejects unrelated routes', () => {
    expect(isCrossVerifyRoute('GET', '/api/health')).toBe(false);
    expect(isCrossVerifyRoute('GET', '/api/schedule')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/schedule')).toBe(false);
    expect(isCrossVerifyRoute('GET', '/api/core-chat/runs')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs/run-123/events')).toBe(false);
  });
});

describe('authenticated channel status aggregation', () => {
  it('counts connected, reconnecting, idle, and failed channels', () => {
    const items = [
      { name: 'ready', platform: 'feishu' as const, state: 'connected' as const, reconnectAttempts: 0 },
      { name: 'starting', platform: 'feishu' as const, state: 'connecting' as const, reconnectAttempts: 1 },
      { name: 'retrying', platform: 'feishu' as const, state: 'reconnecting' as const, reconnectAttempts: 2 },
      { name: 'idle', platform: 'feishu' as const, state: 'idle' as const, reconnectAttempts: 0 },
      { name: 'failed', platform: 'feishu' as const, state: 'failed' as const, reconnectAttempts: 3 },
    ];

    expect(summarizeChannelStatuses(items)).toEqual({
      total: 5,
      connected: 1,
      reconnecting: 2,
      idle: 1,
      failed: 1,
      items,
    });
  });

  it('treats a Web-only personal install as an empty healthy inventory', () => {
    expect(summarizeChannelStatuses([])).toEqual({
      total: 0,
      connected: 0,
      reconnecting: 0,
      idle: 0,
      failed: 0,
      items: [],
    });
  });
});
