import { request } from './client.js';
import type { Config } from './config.js';
import { print } from '@xvirobotics/cli-core/print';
import type { ParsedArgs } from '@xvirobotics/cli-core/args';

export { parseArgs } from '@xvirobotics/cli-core/args';
export type { ParsedArgs } from '@xvirobotics/cli-core/args';

function parseTags(s: string | true | undefined): string[] | undefined {
  if (typeof s !== 'string') return undefined;
  return s
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const ALLOWED_CONTENT_TYPES = ['text/markdown', 'text/html'] as const;
type ContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/**
 * Resolve `--html` / `--content-type <mime>` into a single content_type value.
 * Conflict (both set) or unknown mime → throws; caller bubbles to exit 2.
 */
export function resolveContentTypeFlag(flags: Record<string, string | true>): ContentType | undefined {
  const html = flags.html;
  const explicit = flags['content-type'];
  if (html !== undefined && explicit !== undefined) {
    const err = new Error('--html and --content-type are mutually exclusive');
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  if (html !== undefined) return 'text/html';
  if (explicit === undefined) return undefined;
  if (typeof explicit !== 'string') {
    const err = new Error('--content-type requires a value (text/markdown or text/html)');
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(explicit)) {
    const err = new Error(`unsupported content_type '${explicit}'. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}`);
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  return explicit as ContentType;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
    process.stdin.on('error', reject);
  });
}

function encodeIdOrPath(s: string): string {
  // Server distinguishes path (leading '/') from id (no slash). URL-encode the
  // whole thing as a single path segment so the leading '/' survives as '%2F'.
  return encodeURIComponent(s);
}

function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

interface Whoami {
  botName: string;
  role: string;
  /**
   * Server returns this for member bots that have an agent-registry row.
   * `true` flips the CLI default write target from `/users/<botName>/...`
   * (private) to `/shared/<botName>/...` (visible to every member).
   * Absent / `false` keeps the safe private default.
   */
  memoryPublic?: boolean;
}

/**
 * Resolve the caller's identity via GET /api/whoami.
 *
 * Used lazily by `create`/`mkdir` to default a write into the caller's own
 * namespace (`/users/<botName>/...` or `/shared/<botName>/...` when the bot
 * has opted into public-default via `metabot memory visibility public`). Root
 * is not in a member credential's writableNamespaces, so without this
 * defaulting every member write 403s.
 */
async function whoami(cfg: Config): Promise<Whoami> {
  const body = await request<Whoami>(cfg, { path: '/api/whoami' });
  return body;
}

/**
 * Decide the default folder prefix for `create`/`mkdir` when the caller
 * didn't pass `--path` or `--folder`. Members → `/users/<bot>` (private) or
 * `/shared/<bot>` (public-default). Admins fall back to root (their
 * `writableNamespaces` already contains `/`).
 *
 * Exported for tests; production callers should use it via `cmdCreate` /
 * `cmdMkdir`.
 */
export function defaultWritePrefix(me: Whoami): string | undefined {
  if (me.role === 'admin') return undefined;
  const base = me.memoryPublic ? '/shared' : '/users';
  return `${base}/${me.botName}`;
}

// ---- Commands ----

export async function cmdSearch(cfg: Config, args: ParsedArgs): Promise<void> {
  const q = args.positional[0];
  if (!q) throw new Error('search: <query> required');
  const limit = typeof args.flags.limit === 'string' ? args.flags.limit : '20';
  const body = await request(cfg, {
    path: '/api/memory/search',
    query: { q, limit },
  });
  print(body);
}

export async function cmdGet(cfg: Config, args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error('get: <doc_id> required');
  const body = await request(cfg, {
    path: `/api/memory/documents/${encodeIdOrPath(id)}`,
  });
  print(body);
}

export async function cmdPath(cfg: Config, args: ParsedArgs): Promise<void> {
  const p = args.positional[0];
  if (!p || !p.startsWith('/')) throw new Error('path: </absolute/path/to/doc> required');
  const body = await request(cfg, {
    path: `/api/memory/documents/${encodeIdOrPath(p)}`,
  });
  print(body);
}

export async function cmdList(cfg: Config, args: ParsedArgs): Promise<void> {
  const folder = args.positional[0];
  const limit = typeof args.flags.limit === 'string' ? args.flags.limit : undefined;
  const offset = typeof args.flags.offset === 'string' ? args.flags.offset : undefined;
  const body = await request(cfg, {
    path: '/api/memory/documents',
    query: { folder_id: folder, limit, offset },
  });
  print(body);
}

export async function cmdFolders(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/api/memory/folders/tree' });
  print(body);
}

export async function cmdCreate(cfg: Config, args: ParsedArgs): Promise<void> {
  const title = args.positional[0];
  if (!title) throw new Error('create: <title> required');
  let content = args.positional[1];
  if (content === undefined) {
    content = await readStdin();
  }
  const contentType = resolveContentTypeFlag(args.flags);
  const folderId = typeof args.flags.folder === 'string' ? args.flags.folder : undefined;
  let docPath = typeof args.flags.path === 'string' ? args.flags.path : undefined;
  // No explicit target → default the write into the caller's own namespace.
  // Root is not in a member's writableNamespaces, so without this the POST
  // would 403. Admins keep the legacy root default. whoami is lazy — only
  // called when neither --folder nor --path was given.
  if (docPath === undefined && folderId === undefined) {
    const me = await whoami(cfg);
    const prefix = defaultWritePrefix(me);
    if (prefix !== undefined) {
      docPath = `${prefix}/${slugify(title)}`;
    }
  }
  const body = await request(cfg, {
    method: 'POST',
    path: '/api/memory/documents',
    body: {
      title,
      content,
      path: docPath,
      folder_id: folderId,
      tags: parseTags(args.flags.tags),
      created_by: typeof args.flags.by === 'string' ? args.flags.by : undefined,
      content_type: contentType,
    },
  });
  print(body);
}

export async function cmdUpdate(cfg: Config, args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error('update: <doc_id> required');
  let content = args.positional[1];
  if (content === undefined && !process.stdin.isTTY) {
    content = await readStdin();
  }
  const contentType = resolveContentTypeFlag(args.flags);
  const patch: Record<string, unknown> = {};
  if (typeof args.flags.title === 'string') patch.title = args.flags.title;
  const tags = parseTags(args.flags.tags);
  if (tags !== undefined) patch.tags = tags;
  if (content !== undefined && content !== '') patch.content = content;
  if (contentType !== undefined) patch.content_type = contentType;
  const body = await request(cfg, {
    method: 'PATCH',
    path: `/api/memory/documents/${encodeIdOrPath(id)}`,
    body: patch,
  });
  print(body);
}

export async function cmdMkdir(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('mkdir: <folder-name> required');
  const parent_id = args.positional[1];
  let folderPath = typeof args.flags.path === 'string' ? args.flags.path : undefined;
  // No explicit target (no --path, no parent_id) → default into the caller's
  // own namespace. Members can't write root; admins keep the root default.
  if (folderPath === undefined && parent_id === undefined) {
    const me = await whoami(cfg);
    const prefix = defaultWritePrefix(me);
    if (prefix !== undefined) {
      folderPath = `${prefix}/${name}`;
    }
  }
  const body = await request(cfg, {
    method: 'POST',
    path: '/api/memory/folders',
    body: { name, parent_id, path: folderPath },
  });
  print(body);
}

export async function cmdDelete(cfg: Config, args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error('delete: <doc_id> required');
  const body = await request(cfg, {
    method: 'DELETE',
    path: `/api/memory/documents/${encodeIdOrPath(id)}`,
  });
  print(body);
}

export async function cmdHealth(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/health' });
  print(body);
}

/**
 * `metabot memory visibility [public|private]` — read or toggle whether the
 * calling bot's default-write path is `/shared/<bot>/...` (public) or
 * `/users/<bot>/...` (private). With no argument, reports the current state.
 *
 * Auth: owner-credential of the bot (or admin). The server enforces this on
 * PATCH /api/agents/:botName/memory-visibility.
 */
export async function cmdVisibility(cfg: Config, args: ParsedArgs): Promise<void> {
  const arg = args.positional[0];
  const me = await whoami(cfg);
  if (!arg) {
    const state = me.memoryPublic ? 'public' : 'private';
    print({ botName: me.botName, memoryPublic: !!me.memoryPublic, state });
    return;
  }
  if (arg !== 'public' && arg !== 'private') {
    const err = new Error(`visibility: expected 'public' or 'private', got '${arg}'`);
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  const body = await request(cfg, {
    method: 'PATCH',
    path: `/api/agents/${encodeURIComponent(me.botName)}/memory-visibility`,
    body: { memoryPublic: arg === 'public' },
  });
  print(body);
}

export function printHelp(): void {
  process.stdout.write(
    `metabot memory — metabot-core memory CLI

Usage: metabot memory <command> [args]

Commands:
  search <query>              [--limit N]
  get <doc_id>
  path </abs/path/to/doc>
  list [folder_id]            [--limit N] [--offset N]
  folders
  create <title> [content]    [--folder <id>] [--path </abs/path>]
                              [--tags a,b,c] [--by <name>]
                              [--html | --content-type <mime>]
  update <doc_id> [content]   [--title <t>] [--tags a,b,c]
                              [--html | --content-type <mime>]
  mkdir <name> [parent_id]    [--path </abs/path>]
  delete <doc_id>
  visibility [public|private] read or toggle this bot's default write target
                              (public → /shared/<bot>/..., private → /users/<bot>/...)
  health
  help

Env:
  METABOT_CORE_URL    default https://metabot-core.xvirobotics.com
  METABOT_CORE_TOKEN  bearer token (or write to ~/.metabot-core/token)

Stdin: 'create' and 'update' read content from stdin if no content arg given.

Content type:
  Documents default to 'text/markdown'. Pass --html (sugar) or
  --content-type text/html to store HTML natively. Using both → exit 2.

Write target (create / mkdir):
  Pass --path </absolute/path> to write at an explicit path; the server
  ACL-checks it and auto-creates ancestor folders. With neither --folder
  nor --path (nor a parent_id for mkdir), the write defaults into your own
  namespace — /users/<botName>/... (private) by default. Run
  'metabot memory visibility public' to flip the default to /shared/<bot>/...
  Admins keep the root default.
`,
  );
}
