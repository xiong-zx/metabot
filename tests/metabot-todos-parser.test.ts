import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The bundled parser is intentionally standalone JavaScript so installed skills
// do not depend on the MetaBot repository's TypeScript build.
// @ts-expect-error The standalone skill script does not ship TypeScript declarations.
import {
  TodoParseError,
  buildSnapshot,
  findItem,
  parseTodoDocument,
  renderSnapshot,
} from '../packages/skills/metabot-todos/scripts/todo-display.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'packages', 'skills', 'metabot-todos', 'scripts', 'todo-display.mjs');
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function item(options: {
  id: string;
  status?: string;
  priority?: number;
  category?: string;
  task?: string;
  blockedBy?: string;
  detail?: string;
}): string {
  const status = options.status ?? 'waiting';
  const rows = [
    `### ${options.id}: Test item`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| \`id\` | \`${options.id}\` |`,
    `| \`status\` | \`${status}\` |`,
    `| \`priority\` | \`${options.priority ?? 1}\` |`,
    `| \`category\` | \`${options.category ?? 'test'}\` |`,
    `| \`task\` | ${options.task ?? 'Test task'} |`,
    '| `context` | Context with `inline code` and an internal `a|b` pipe. |',
    '| `next_action` | Read 中文 files, then keep the literal `x|y` value. |',
    '| `owner` | memory |',
    '| `source` | unit test |',
    '| `references` | `/cargo1/todo` |',
    '| `reminder` | not set |',
    '| `updated_at` | 2026-07-27 |',
  ];
  if (options.blockedBy !== undefined) {
    rows.push(`| \`blocked_by\` | ${options.blockedBy} |`);
  }
  if (options.detail) rows.push('', options.detail);
  return rows.join('\n');
}

function document(active: string, completed = 'None.', cancelled = 'None.') {
  return {
    id: 'doc-1',
    title: 'Test ToDos',
    path: '/cargo1/todo/test-todos',
    updated_at: '2026-07-27T00:00:00Z',
    content: [
      '# Test ToDos',
      '',
      '## Active Items',
      '',
      active,
      '',
      '## Completed Items',
      '',
      completed,
      '',
      '## Cancelled Items',
      '',
      cancelled,
      '',
    ].join('\n'),
  };
}

describe('metabot-todos parser', () => {
  it('treats backticks, internal pipes, Unicode, nested headings, and fenced headings as data', () => {
    const detail = [
      '#### Evidence',
      '',
      'Multiple lines stay inside the item.',
      '',
      '```md',
      '### FAKE-999: Not an item',
      '## Completed Items',
      '```',
      '',
      '| `status` | `done` |',
    ].join('\n');
    const parsed = parseTodoDocument(document(item({ id: 'TEST-001', task: 'Handle `code|pipe` 与中文', detail })));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('TEST-001');
    expect(parsed.items[0].task).toBe('Handle `code|pipe` 与中文');
    expect(parsed.items[0].context).toContain('`a|b`');
    expect(parsed.items[0].raw).toContain('### FAKE-999: Not an item');
  });

  it('rejects terminal status in Active Items without mutating input', () => {
    const source = document(item({ id: 'TEST-001', status: 'done' }));
    const before = source.content;

    expect(() => parseTodoDocument(source)).toThrowError(TodoParseError);
    expect(() => parseTodoDocument(source)).toThrow('status done in active section');
    expect(source.content).toBe(before);
  });

  it('requires blocked_by for blocked items', () => {
    expect(() => parseTodoDocument(document(item({ id: 'TEST-001', status: 'blocked' })))).toThrow(
      'blocked but has no `blocked_by` field',
    );
  });

  it('fails explicitly on malformed section structure and missing core fields', () => {
    const missingSection = document(item({ id: 'TEST-001' }));
    missingSection.content = missingSection.content.replace('## Cancelled Items', '## Archive');
    expect(() => parseTodoDocument(missingSection)).toThrow('expected one "Cancelled Items" section, found 0');

    const missingOwner = document(item({ id: 'TEST-002' }));
    missingOwner.content = missingOwner.content.replace('| `owner` | memory |', '');
    expect(() => parseTodoDocument(missingOwner)).toThrow('TEST-002 is missing required field `owner`');
  });

  it('rejects duplicate IDs across category documents', () => {
    const first = document(item({ id: 'TEST-001' }));
    const second = {
      ...document(item({ id: 'TEST-001' })),
      id: 'doc-2',
      title: 'Other ToDos',
      path: '/cargo1/todo/other-todos',
    };
    expect(() => buildSnapshot([first, second])).toThrow('duplicate ToDo ID TEST-001');
  });

  it('sorts by priority and ID, summarizes non-done statuses, and names empty categories', () => {
    const active = [
      item({ id: 'TEST-010', priority: 2 }),
      item({ id: 'TEST-002', priority: 1, status: 'blocked', blockedBy: 'TEST-001' }),
      item({ id: 'TEST-001', priority: 1, status: 'in_progress' }),
    ].join('\n\n');
    const empty = {
      ...document('None.'),
      id: 'doc-empty',
      title: 'Empty ToDos',
      path: '/cargo1/todo/empty-todos',
    };
    const snapshot = buildSnapshot([document(active), empty]);
    const rendered = renderSnapshot(snapshot);

    expect(rendered).toContain('**3 个非 done ToDo**');
    expect(rendered).toContain('`in_progress` 1，`waiting` 1，`blocked` 1，`cancelled` 0');
    expect(rendered.indexOf('`TEST-001`')).toBeLessThan(rendered.indexOf('`TEST-002`'));
    expect(rendered.indexOf('`TEST-002`')).toBeLessThan(rendered.indexOf('`TEST-010`'));
    expect(rendered).toContain('当前没有非 done 任务的类别：**Empty**');
    expect(findItem(snapshot, 'TEST-002')?.item.blockedBy).toBe('TEST-001');
  });
});

describe('metabot-todos CLI', () => {
  it('rejects options whose values are missing instead of consuming the next flag', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--id', '--json'], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--id requires a value');
  });

  it('loads JSON through execFile arguments and hides done unless explicitly requested', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-todos-cli-'));
    cleanup.push(dir);
    const fake = join(dir, 'metabot');
    const todoDoc = document(
      item({ id: 'TEST-001', status: 'in_progress' }),
      item({ id: 'TEST-002', status: 'done' }),
      item({ id: 'TEST-003', status: 'cancelled' }),
    );
    const responses = {
      folders: {
        id: 'root',
        path: '/',
        children: [{ id: 'todo-folder', path: '/cargo1/todo', children: [] }],
      },
      list: {
        documents: [
          {
            id: 'doc-1',
            path: '/cargo1/todo/test-todos',
            tags: ['todo'],
          },
        ],
      },
      get: todoDoc,
    };
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        `const responses = ${JSON.stringify(responses)};`,
        'const args = process.argv.slice(2);',
        "if (args.join(' ') === 'memory folders') console.log(JSON.stringify(responses.folders));",
        "else if (args[0] === 'memory' && args[1] === 'list') console.log(JSON.stringify(responses.list));",
        "else if (args[0] === 'memory' && args[1] === 'get') console.log(JSON.stringify(responses.get));",
        "else { console.error('unexpected args: ' + JSON.stringify(args)); process.exit(2); }",
      ].join('\n'),
    );
    chmodSync(fake, 0o755);

    const output = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, METABOT_BIN: fake },
    });

    expect(output).toContain('**2 个非 done ToDo**');
    expect(output).toContain('`TEST-001`｜P1｜`in_progress`');
    expect(output).toContain('`TEST-003`｜P1｜`cancelled`');
    expect(output).not.toContain('TEST-002');

    const defaultJson = JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, METABOT_BIN: fake },
      }),
    );
    const allJson = JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--all', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, METABOT_BIN: fake },
      }),
    );
    const doneJson = JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--status', 'done', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, METABOT_BIN: fake },
      }),
    );
    const includeDoneJson = JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--include-done', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, METABOT_BIN: fake },
      }),
    );
    expect(defaultJson.categories[0].items.map((entry: any) => entry.id)).toEqual(['TEST-001', 'TEST-003']);
    expect(allJson.categories[0].items.map((entry: any) => entry.id)).toEqual(['TEST-001', 'TEST-003']);
    expect(doneJson.categories[0].items.map((entry: any) => entry.id)).toEqual(['TEST-002']);
    expect(includeDoneJson.categories[0].items.map((entry: any) => entry.id)).toEqual([
      'TEST-001',
      'TEST-002',
      'TEST-003',
    ]);
  });

  it('rejects an unknown status filter', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--status', 'open'], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--status must be one of');
  });
});
