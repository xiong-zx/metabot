import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openServers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        }),
    ),
  );
  openServers.clear();
});

describe('bin/metabot execution capability', () => {
  it('forwards the scoped capability and never forwards the bridge admin secret', async () => {
    let request:
      | {
          url?: string;
          authorization?: string;
          capability?: string;
          botName?: string;
          chatId?: string;
        }
      | undefined;
    const server = createServer((req, res) => {
      request = {
        url: req.url,
        authorization: req.headers.authorization,
        capability: stringHeader(req.headers['x-metabot-team-capability']),
        botName: stringHeader(req.headers['x-metabot-bot-name']),
        chatId: stringHeader(req.headers['x-metabot-chat-id']),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"templates":[]}');
    });
    openServers.add(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

    const { stdout } = await execFileAsync('bash', ['bin/metabot', 'teams', 'templates', 'list'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        METABOT_HOME: repoRoot,
        METABOT_URL: `http://127.0.0.1:${address.port}`,
        API_SECRET: 'bridge-admin-secret-must-not-leak',
        METABOT_TEAM_CAPABILITY: 'signed-execution-capability',
        METABOT_BOT_NAME: 'pm-codex',
        METABOT_CHAT_ID: 'teaminst:one:lead',
      },
    });

    expect(JSON.parse(stdout)).toEqual({ templates: [] });
    expect(request).toEqual({
      url: '/api/agent-team-governance/templates',
      authorization: 'Bearer execution-capability',
      capability: 'signed-execution-capability',
      botName: 'pm-codex',
      chatId: 'teaminst:one:lead',
    });
  });

  it('forwards capability binding for normal scoped read commands without administrator secrets', async () => {
    const requests: Array<{
      url?: string;
      authorization?: string;
      capability?: string;
      botName?: string;
      chatId?: string;
      rawHeaders: string[];
    }> = [];
    const server = createServer((req, res) => {
      requests.push({
        url: req.url,
        authorization: req.headers.authorization,
        capability: stringHeader(req.headers['x-metabot-team-capability']),
        botName: stringHeader(req.headers['x-metabot-bot-name']),
        chatId: stringHeader(req.headers['x-metabot-chat-id']),
        rawHeaders: req.rawHeaders,
      });
      res.writeHead(200, { 'content-type': req.url === '/api/metrics' ? 'text/plain' : 'application/json' });
      res.end(req.url === '/api/metrics' ? 'metabot_test_metric 1\n' : '{}');
    });
    openServers.add(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

    const env = {
      ...process.env,
      METABOT_HOME: repoRoot,
      METABOT_URL: `http://127.0.0.1:${address.port}`,
      API_SECRET: 'api-secret-must-not-leak',
      METABOT_API_SECRET: 'alternate-api-secret-must-not-leak',
      METABOT_TEAM_CAPABILITY: 'signed-read-capability',
      METABOT_BOT_NAME: 'pm-codex',
      METABOT_CHAT_ID: 'teaminst:one:reader',
    };
    for (const command of [['bots'], ['peers'], ['stats'], ['metrics'], ['schedule', 'list']]) {
      await execFileAsync('bash', ['bin/metabot', ...command], { cwd: repoRoot, env });
    }

    expect(requests.map((request) => request.url)).toEqual([
      '/api/bots',
      '/api/peers',
      '/api/stats',
      '/api/metrics',
      '/api/schedule',
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({
        authorization: 'Bearer execution-capability',
        capability: 'signed-read-capability',
        botName: 'pm-codex',
        chatId: 'teaminst:one:reader',
      });
      expect(request.rawHeaders.join('\n')).not.toContain('api-secret-must-not-leak');
      expect(request.rawHeaders.join('\n')).not.toContain('alternate-api-secret-must-not-leak');
    }
  });

  it('forwards scoped capability headers for every schedule mutation', async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      authorization?: string;
      capability?: string;
      botName?: string;
      chatId?: string;
      body: string;
      rawHeaders: string[];
    }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        capability: stringHeader(req.headers['x-metabot-team-capability']),
        botName: stringHeader(req.headers['x-metabot-bot-name']),
        chatId: stringHeader(req.headers['x-metabot-chat-id']),
        body,
        rawHeaders: req.rawHeaders,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    openServers.add(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

    const env = {
      ...process.env,
      METABOT_HOME: repoRoot,
      METABOT_URL: `http://127.0.0.1:${address.port}`,
      API_SECRET: 'schedule-admin-secret-must-not-leak',
      METABOT_TEAM_CAPABILITY: 'signed-schedule-capability',
      METABOT_BOT_NAME: 'pm-codex',
      METABOT_CHAT_ID: 'oc_schedule',
    };
    const commands = [
      ['schedule', 'add', 'pm-codex', 'oc_schedule', '60', 'one time'],
      ['schedule', 'cron', 'pm-codex', 'oc_schedule', '0 8 * * *', 'recurring'],
      ['schedule', 'pause', 'recurring-id'],
      ['schedule', 'resume', 'recurring-id'],
      ['schedule', 'cancel', 'task-id'],
    ];
    for (const command of commands) {
      await execFileAsync('bash', ['bin/metabot', ...command], { cwd: repoRoot, env });
    }

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ['POST', '/api/schedule'],
      ['POST', '/api/schedule'],
      ['POST', '/api/schedule/recurring-id/pause'],
      ['POST', '/api/schedule/recurring-id/resume'],
      ['DELETE', '/api/schedule/task-id'],
    ]);
    expect(JSON.parse(requests[0].body)).toMatchObject({
      botName: 'pm-codex',
      chatId: 'oc_schedule',
      delaySeconds: 60,
    });
    expect(JSON.parse(requests[1].body)).toMatchObject({
      botName: 'pm-codex',
      chatId: 'oc_schedule',
      cronExpr: '0 8 * * *',
    });
    for (const request of requests) {
      expect(request).toMatchObject({
        authorization: 'Bearer execution-capability',
        capability: 'signed-schedule-capability',
        botName: 'pm-codex',
        chatId: 'oc_schedule',
      });
      expect(request.rawHeaders.join('\n')).not.toContain('schedule-admin-secret-must-not-leak');
    }
  });
});

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
