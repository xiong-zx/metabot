import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KimiDaemonClient, KimiDaemonError } from '../src/engines/kimi/daemon-client.js';

function response<T>(data: T): Response {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data, request_id: 'req-test' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('KimiDaemonClient', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'metabot-kimi-client-'));
    previousHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    await writeFile(path.join(home, 'server.token'), 'test-token\n', { mode: 0o600 });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it('uses the official prompt queue and steer endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ prompt_id: 'prompt-steer', user_message_id: 'message-steer', status: 'queued' }))
      .mockResolvedValueOnce(response({ steered: true, prompt_ids: ['prompt-steer'] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KimiDaemonClient();

    await client.steer('session-1', 'also optimize mobile', {
      model: 'kimi-code/k3',
      thinking: 'high',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/sessions/session-1/prompts');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      content: [{ type: 'text', text: 'also optimize mobile' }],
      permission_mode: 'auto',
      model: 'kimi-code/k3',
      thinking: 'high',
    });
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/api/v1/sessions/session-1/prompts:steer');
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toEqual({
      prompt_ids: ['prompt-steer'],
    });
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('resolves short model names against the live Kimi Code config', async () => {
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'default_model = "kimi-code/k3"',
        '',
        '[models."kimi-code/k3"]',
        'display_name = "Kimi K3"',
        '',
        '[models."kimi-code/kimi-for-coding-highspeed"]',
        'display_name = "Kimi Highspeed"',
      ].join('\n'),
    );
    const client = new KimiDaemonClient();

    await expect(client.resolveModel('k3')).resolves.toEqual({ id: 'kimi-code/k3', displayName: 'Kimi K3' });
    await expect(client.resolveModel('kimi-for-coding-highspeed')).resolves.toEqual({
      id: 'kimi-code/kimi-for-coding-highspeed',
      displayName: 'Kimi Highspeed',
    });
  });

  it('rejects non-loopback servers before reading or sending the local daemon token', () => {
    expect(() => new KimiDaemonClient({ serverUrl: 'https://kimi.example.com' })).toThrow(KimiDaemonError);
  });
});
