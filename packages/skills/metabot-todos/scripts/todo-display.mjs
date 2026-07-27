#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_FOLDER_PATH = '/cargo1/todo';
const ACTIVE_STATUSES = new Set(['in_progress', 'waiting', 'blocked']);
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
const REQUIRED_FIELDS = [
  'id',
  'status',
  'priority',
  'category',
  'task',
  'context',
  'next_action',
  'owner',
  'source',
  'references',
  'reminder',
  'updated_at',
];
const SECTION_STATUS = {
  active: ACTIVE_STATUSES,
  completed: new Set(['done']),
  cancelled: new Set(['cancelled']),
};

export class TodoParseError extends Error {
  constructor(message, context = {}) {
    const prefix = context.path ? `${context.path}: ` : '';
    super(`${prefix}${message}`);
    this.name = 'TodoParseError';
    this.context = context;
  }
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

function stripCodeScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scanHeadings(content) {
  const headings = [];
  const lines = normalizeNewlines(content).split('\n');
  let offset = 0;
  let fence = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    } else if (fence === null) {
      const heading = line.match(/^(#{2,4})\s+(.+?)\s*$/);
      if (heading) {
        headings.push({
          level: heading[1].length,
          text: heading[2],
          start: offset,
          lineEnd: offset + line.length,
        });
      }
    }
    offset += line.length + 1;
  }

  return headings;
}

function parseFieldRows(block, context) {
  const fields = {};
  const lines = normalizeNewlines(block).split('\n');
  const tableStart = lines.findIndex((line) => /^\|\s*Field\s*\|\s*Value\s*\|\s*$/.test(line));
  if (tableStart < 0) {
    throw new TodoParseError(`${context.id} has no core Field/Value table`, context);
  }

  for (const line of lines.slice(tableStart + 1)) {
    if (line.trim() === '') {
      if (Object.keys(fields).length > 0) break;
      continue;
    }
    if (!line.trimStart().startsWith('|')) break;
    const row = line.match(/^\|\s*`([^`]+)`\s*\|\s*(.*)\s*\|\s*$/);
    if (!row) continue;
    const name = row[1].trim();
    if (Object.hasOwn(fields, name)) {
      throw new TodoParseError(`duplicate field \`${name}\` in ${context.id}`, context);
    }
    fields[name] = row[2].trim();
  }
  return fields;
}

function parseItem(block, section, heading, context) {
  const match = heading.text.match(/^([A-Z][A-Z0-9_]*-\d+):\s*(.+)$/);
  if (!match) {
    throw new TodoParseError(`invalid item heading: ${heading.text}`, context);
  }
  const id = match[1];
  const title = match[2];
  const itemContext = { ...context, id, section };
  const rawFields = parseFieldRows(block, itemContext);

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(rawFields, field) || rawFields[field].trim() === '') {
      throw new TodoParseError(`${id} is missing required field \`${field}\``, itemContext);
    }
  }

  const fields = Object.fromEntries(Object.entries(rawFields).map(([name, value]) => [name, stripCodeScalar(value)]));
  if (fields.id !== id) {
    throw new TodoParseError(`${id} heading disagrees with field id ${fields.id}`, itemContext);
  }
  const allowed = SECTION_STATUS[section];
  if (!allowed.has(fields.status)) {
    throw new TodoParseError(`${id} has status ${fields.status} in ${section} section`, itemContext);
  }
  if (fields.status === 'blocked' && !stripCodeScalar(rawFields.blocked_by ?? '')) {
    throw new TodoParseError(`${id} is blocked but has no \`blocked_by\` field`, itemContext);
  }
  const priority = Number(fields.priority);
  if (!Number.isInteger(priority) || priority < 0) {
    throw new TodoParseError(`${id} has invalid priority ${fields.priority}`, itemContext);
  }

  return {
    id,
    title,
    section,
    status: fields.status,
    priority,
    category: fields.category,
    task: fields.task,
    context: fields.context,
    nextAction: fields.next_action,
    blockedBy: fields.blocked_by ?? null,
    owner: fields.owner,
    source: fields.source,
    references: fields.references,
    reminder: fields.reminder,
    updatedAt: fields.updated_at,
    fields,
    raw: block.trim(),
  };
}

function categoryName(document) {
  const aliases = {
    '/cargo1/todo/general-fix-todos': 'General Fixes',
    '/cargo1/todo/long-running-task-todos': 'Long-Running Tasks',
    '/cargo1/todo/memory-todos': 'Memory / MetaMemory',
  };
  if (aliases[document.path]) return aliases[document.path];
  return document.title
    .replace(/\s+ToDos?$/i, '')
    .replace(/\s+Todos?$/i, '')
    .trim();
}

export function parseTodoDocument(document) {
  if (!document || typeof document.content !== 'string') {
    throw new TodoParseError('document content must be a string', {
      path: document?.path,
    });
  }
  const content = normalizeNewlines(document.content);
  const headings = scanHeadings(content);
  const wanted = new Map([
    ['Active Items', 'active'],
    ['Completed Items', 'completed'],
    ['Cancelled Items', 'cancelled'],
  ]);
  const sectionHeadings = headings.filter((heading) => heading.level === 2 && wanted.has(heading.text));

  if (sectionHeadings.length === 0) return null;
  for (const name of wanted.keys()) {
    const matches = sectionHeadings.filter((heading) => heading.text === name);
    if (matches.length !== 1) {
      throw new TodoParseError(`expected one "${name}" section, found ${matches.length}`, {
        path: document.path,
      });
    }
  }
  const ordered = Array.from(wanted.keys()).map((name) => sectionHeadings.find((heading) => heading.text === name));
  if (!(ordered[0].start < ordered[1].start && ordered[1].start < ordered[2].start)) {
    throw new TodoParseError('ToDo sections are out of order', { path: document.path });
  }

  const items = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const sectionHeading = ordered[index];
    const section = wanted.get(sectionHeading.text);
    const sectionEnd = ordered[index + 1]?.start ?? content.length;
    const itemHeadings = headings.filter(
      (heading) => heading.level === 3 && heading.start > sectionHeading.start && heading.start < sectionEnd,
    );

    for (let itemIndex = 0; itemIndex < itemHeadings.length; itemIndex += 1) {
      const heading = itemHeadings[itemIndex];
      const blockEnd = itemHeadings[itemIndex + 1]?.start ?? sectionEnd;
      const block = content.slice(heading.start, blockEnd);
      items.push(parseItem(block, section, heading, { path: document.path }));
    }
  }

  return {
    documentId: document.id,
    path: document.path,
    title: document.title,
    category: categoryName(document),
    updatedAt: document.updated_at ?? null,
    items,
  };
}

function compareItems(left, right) {
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.id.localeCompare(right.id, undefined, { numeric: true });
}

export function buildSnapshot(documents, folderPath = DEFAULT_FOLDER_PATH) {
  const categories = [];
  const ids = new Map();

  for (const document of documents) {
    const category = parseTodoDocument(document);
    if (!category) continue;
    for (const item of category.items) {
      const prior = ids.get(item.id);
      if (prior) {
        throw new TodoParseError(`duplicate ToDo ID ${item.id}; first seen in ${prior}`, {
          path: category.path,
          id: item.id,
        });
      }
      ids.set(item.id, category.path);
    }
    category.items.sort(compareItems);
    categories.push(category);
  }

  categories.sort((left, right) => left.category.localeCompare(right.category));
  return { folderPath, categories };
}

function findFolder(tree, folderPath) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.path === folderPath) return tree;
  for (const child of tree.children ?? []) {
    const found = findFolder(child, folderPath);
    if (found) return found;
  }
  return null;
}

function runJson(metabotBin, args) {
  let output;
  try {
    output = execFileSync(metabotBin, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim();
    throw new TodoParseError(`metabot command failed: ${detail}`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new TodoParseError(`metabot returned invalid JSON for: ${args.join(' ')}`);
  }
}

export function loadSnapshot(options = {}) {
  const metabotBin = options.metabotBin ?? process.env.METABOT_BIN ?? 'metabot';
  const folderPath = options.folderPath ?? DEFAULT_FOLDER_PATH;
  const folders = runJson(metabotBin, ['memory', 'folders']);
  const folder = findFolder(folders, folderPath);
  if (!folder) throw new TodoParseError(`folder not found: ${folderPath}`);

  const listing = runJson(metabotBin, ['memory', 'list', folder.id]);
  const summaries = listing.documents;
  if (!Array.isArray(summaries)) {
    throw new TodoParseError(`memory list returned no documents for ${folderPath}`);
  }
  const documents = summaries
    .filter((summary) => summary.path?.startsWith(`${folderPath}/`))
    .map((summary) => runJson(metabotBin, ['memory', 'get', summary.id]));
  return buildSnapshot(documents, folderPath);
}

function shorten(value, maxLength) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function selectedItems(category, includeTerminal) {
  return category.items.filter((item) => includeTerminal || ACTIVE_STATUSES.has(item.status)).sort(compareItems);
}

export function renderSnapshot(snapshot, options = {}) {
  const includeTerminal = options.includeTerminal ?? false;
  const maxNext = options.maxNext ?? 180;
  const statusOrder = includeTerminal
    ? ['in_progress', 'waiting', 'blocked', 'done', 'cancelled']
    : ['in_progress', 'waiting', 'blocked'];
  const categories = snapshot.categories.map((category) => ({
    ...category,
    selected: selectedItems(category, includeTerminal),
  }));
  const items = categories.flatMap((category) => category.selected);
  const counts = Object.fromEntries(
    statusOrder.map((status) => [status, items.filter((item) => item.status === status).length]),
  );
  const scope = includeTerminal ? 'ToDo' : '有效 ToDo';
  const summary = statusOrder.map((status) => `\`${status}\` ${counts[status]}`).join('，');
  const lines = [`当前共有 **${items.length} 个${scope}**：${summary}`];

  for (const category of categories.filter((entry) => entry.selected.length > 0)) {
    lines.push('', `**${category.category}（${category.selected.length}）**`);
    for (const item of category.selected) {
      let line = `- \`${item.id}\`｜P${item.priority}｜\`${item.status}\`｜${shorten(item.task, maxNext)}`;
      if (item.status === 'blocked') {
        line += `；阻塞于：${shorten(item.blockedBy, maxNext)}`;
      } else if (!TERMINAL_STATUSES.has(item.status) && item.nextAction !== 'None') {
        line += `；下一步：${shorten(item.nextAction, maxNext)}`;
      }
      if (item.reminder && !['not set', 'None'].includes(item.reminder)) {
        line += `；提醒：${shorten(item.reminder, maxNext)}`;
      }
      lines.push(line);
    }
  }

  if (!includeTerminal) {
    const empty = categories.filter((entry) => entry.selected.length === 0).map((entry) => entry.category);
    if (empty.length > 0) {
      lines.push('', `当前没有有效任务的类别：**${empty.join('、')}**。`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function findItem(snapshot, id) {
  for (const category of snapshot.categories) {
    const item = category.items.find((candidate) => candidate.id === id);
    if (item) return { category, item };
  }
  return null;
}

export function selectSnapshot(snapshot, includeTerminal = false) {
  return {
    ...snapshot,
    categories: snapshot.categories.map((category) => ({
      ...category,
      items: selectedItems(category, includeTerminal),
    })),
  };
}

function usage() {
  return [
    'Usage: node todo-display.mjs [options]',
    '',
    '  --all                 Include completed and cancelled items',
    '  --id <TODO-ID>        Print one complete canonical item',
    '  --json                Emit structured JSON',
    '  --folder-path <path>  Override /cargo1/todo',
    '  --max-next <chars>    Limit task and next-action text (default: 180)',
    '  --help                Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    includeTerminal: false,
    json: false,
    id: null,
    folderPath: DEFAULT_FOLDER_PATH,
    maxNext: 180,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') options.includeTerminal = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--id' || arg === '--folder-path' || arg === '--max-next') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new TodoParseError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === '--id') options.id = value;
      else if (arg === '--folder-path') options.folderPath = value;
      else options.maxNext = Number(value);
    } else throw new TodoParseError(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.maxNext) || options.maxNext < 20) {
    throw new TodoParseError('--max-next must be an integer of at least 20');
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshot = loadSnapshot({ folderPath: options.folderPath });
  if (options.id) {
    const found = findItem(snapshot, options.id);
    if (!found) throw new TodoParseError(`ToDo not found: ${options.id}`);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    } else {
      process.stdout.write(`${found.item.raw}\n`);
    }
    return;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(selectSnapshot(snapshot, options.includeTerminal), null, 2)}\n`);
  } else {
    process.stdout.write(
      renderSnapshot(snapshot, {
        includeTerminal: options.includeTerminal,
        maxNext: options.maxNext,
      }),
    );
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`metabot-todos: ${error.message}\n`);
    process.exitCode = 1;
  }
}
