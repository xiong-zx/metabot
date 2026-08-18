import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleBotRoutes } from '../src/api/routes/bot-routes.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

function request(body: Record<string, unknown> = {}, headers: Record<string, string> = {}): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
  req.headers = headers;
  return req;
}

function response() {
  const output: { status: number; body?: any } = { status: 0 };
  const res = {
    writeHead: vi.fn((status: number) => {
      output.status = status;
      return res;
    }),
    end: vi.fn((body?: string) => {
      if (body) output.body = JSON.parse(body);
      return res;
    }),
  } as unknown as http.ServerResponse;
  return { res, output };
}

describe('RulesPack operator and transport routes', () => {
  it('exposes authenticated bot-scoped status and mode controls through the operator', async () => {
    const operator = {
      status: vi.fn(() => ({ mode: 'off' })),
      setMode: vi.fn((mode: string) => ({ mode })),
    };
    const ctx = {
      registry: {
        get: () => ({
          config: { claude: { defaultWorkingDirectory: '/tmp' } },
          bridge: { getRulesPackOperator: () => operator },
        }),
      },
      logger: {},
      ws: {},
    } as unknown as RouteContext;

    const status = response();
    expect(await handleBotRoutes(ctx, request(), status.res, 'GET', '/api/bots/admin/rulespack/status')).toBe(true);
    expect(status.output).toEqual({ status: 200, body: { mode: 'off' } });

    const mode = response();
    expect(await handleBotRoutes(
      ctx,
      request({ mode: 'shadow' }),
      mode.res,
      'PATCH',
      '/api/bots/admin/rulespack/mode',
    )).toBe(true);
    expect(operator.setMode).toHaveBeenCalledWith('shadow');
    expect(mode.output).toEqual({ status: 200, body: { mode: 'shadow' } });
  });

  it('rejects a dispatch whose claimed issuer is not bound by authenticated transport', async () => {
    const ctx = {
      resolveRulesPackTransportIssuer: () => 'authenticated-peer',
    } as unknown as RouteContext;
    const { res, output } = response();
    const handled = await handleTaskRoutes(
      ctx,
      request(
        { botName: 'admin', chatId: 'chat', prompt: 'work', rulesPackDispatch: {} },
        { 'x-metabot-origin': 'peer', 'x-metabot-rulespack-issuer': 'spoofed-peer' },
      ),
      res,
      'POST',
      '/api/talk',
    );
    expect(handled).toBe(true);
    expect(output).toEqual({
      status: 400,
      body: { error: 'RulesPack dispatch requires authenticated peer transport headers' },
    });
  });
});
