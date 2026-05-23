export type ContentType = 'text/markdown' | 'text/html';

export interface FolderTreeNode {
  id: string;
  name: string;
  path: string;
  children: FolderTreeNode[];
  document_count: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content_type: ContentType;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentFull extends DocumentSummary {
  content: string;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  content_type: ContentType;
  snippet: string;
  tags: string[];
  created_by: string;
  updated_at: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  ownerBotName?: string;
  visibility: 'private' | 'published' | 'shared';
  contentHash: string;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
}

export interface SkillRecord extends SkillSummary {
  ownerCredentialId?: string;
  userInvocable: boolean;
  context?: string;
  allowedTools?: string;
  skillMd: string;
  hasReferences: boolean;
}

export interface SkillSearchResult extends SkillSummary {
  snippet: string;
}

export interface Manifest {
  schemaVersion: number;
  instance: { name: string };
  capabilities: {
    memory: boolean;
    skills: boolean;
    content_types: ContentType[];
  };
}

// ---- t5t (mirror of packages/server/src/t5t/types.ts — camelCase only) ----

export type ProjectStatus = 'green' | 'yellow' | 'red' | 'killed' | 'unknown';
export type WipStatus = 'queued' | 'doing' | 'done';
export type AnomalyReason =
  | 'no_owner'
  | 'stale'
  | 'kill_red'
  | 'no_goal'
  | 'stale_bottleneck';

export interface Evaluator {
  project: string;
  evaluatorId: string;
  description: string;
  met: boolean;
  seq: number;
  author: string;
  authorCanonical: string;
  createdAt: string;
  docId: string;
}

export interface Bottleneck {
  project: string;
  bottleneckId: string;
  text: string;
  cleared: boolean;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  docId: string;
}

export interface WIPItem {
  project: string;
  evaluatorId: string;
  wipId: string;
  description: string;
  status: WipStatus;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  docId: string;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  leaderEmail: string | null;
  allowedUsers: string[];
  status: ProjectStatus;
  killCriteria: string | null;
  goal: string | null;
  bottleneck: Bottleneck | null;
  evaluators: Evaluator[];
  lastPush: string | null;
  lastAuthor: string | null;
}

export interface T5TEntry {
  entryId: string;
  docId: string;
  author: string;
  authorCanonical: string;
  project: string;
  date: string;
  items: string[];
  retracts: string | null;
  createdAt: string;
}

export interface FeedbackEntry {
  feedbackId: string;
  docId: string;
  onEntry: string;
  from: string;
  fromCanonical: string;
  mentions: string[];
  comment: string;
  createdAt: string;
}

export interface AnomalyItem {
  project: string;
  reason: AnomalyReason;
  detail: string;
  lastPush: string | null;
}

export interface BoardResponse {
  generatedAt: string;
  projects: ProjectSummary[];
  recentEntries: T5TEntry[];
  anomalies: AnomalyItem[];
}

export interface WIPBoardColumn {
  evaluator: Evaluator;
  items: WIPItem[];
}

export interface ProjectDetailResponse {
  project: ProjectSummary;
  entries: T5TEntry[];
  feedback: FeedbackEntry[];
  wipBoard: WIPBoardColumn[];
}

export interface FeedbackRequest {
  onEntry: string;
  comment: string;
  mentions: string[];
}

// ---- agents (mirror of packages/server/src/agents/agent-routes.ts public shape) ----

export interface AgentSummary {
  botName: string;
  url: string;
  visible: boolean;
  lastSeenAt: string;
}

// ---- self-service web token (mirror of packages/server/src/web/web-routes.ts) ----

export interface IssueTokenResponse {
  token: string;
  botName: string;
  credentialId: string;
  rotatedFrom: number;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(`${status} ${code}${detail ? ` — ${detail}` : ''}`);
  }
}

function redirectToSignIn(): never {
  // Auth is provided by oauth2-proxy (飞连 OIDC) via session cookie. A 401
  // means the browser has no valid session — bounce through oauth2-proxy's
  // sign-in, preserving the deep link so the user lands back where they were.
  const rd = encodeURIComponent(location.pathname + location.search);
  window.location.href = `/oauth2/sign_in?rd=${rd}`;
  // Block the calling code path until the navigation takes effect.
  throw new ApiError(401, 'unauthenticated');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!res.ok) {
    if (res.status === 401) redirectToSignIn();
    const code = (body && typeof body === 'object' && 'error' in body)
      ? String((body as { error: unknown }).error)
      : res.statusText || 'request_failed';
    throw new ApiError(res.status, code);
  }
  return body as T;
}

// Memory routes accept either a UUID id or a slash-prefixed path. UUIDs never
// contain `/`, so we can branch on that. Paths are encoded per-segment so the
// `/` separators remain literal — single-segment encodeURIComponent would
// emit `%2F`, which oauth2-proxy v7 silently decodes back to `/` upstream,
// stripping the leading `/` and turning the lookup into an id-miss.
//
// `encodePathSegment` then un-encodes characters that are RFC-3986-safe in
// path segments (pchar sub-delims + `@` + `:`). The cookie-auth chain
// (Caddy → oauth2-proxy v7 → backend) re-encodes every `%XX` it sees to
// `%25XX` (Caddy sends pre-escaped Path without RawPath; downstream
// re-escapes the literal `%`). Audit-log evidence: only `%25` ever reaches
// the backend over cookie auth, no other `%XX`. Sending literal `@` for
// emails dodges the mangle entirely; Bearer-bypass path is unaffected.
function encodePathSegment(seg: string): string {
  return encodeURIComponent(seg)
    .replace(/%40/g, '@')
    .replace(/%3A/g, ':')
    .replace(/%24/g, '$')
    .replace(/%26/g, '&')
    .replace(/%2B/g, '+')
    .replace(/%2C/g, ',')
    .replace(/%3B/g, ';')
    .replace(/%3D/g, '=')
    .replace(/%21/g, '!')
    .replace(/%27/g, "'")
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2A/g, '*');
}

function encodeIdOrPath(idOrPath: string): string {
  if (idOrPath.includes('/')) {
    return idOrPath.split('/').map(encodePathSegment).join('/');
  }
  return encodePathSegment(idOrPath);
}

export const api = {
  manifest: () => request<Manifest>('/api/manifest'),
  health: () => request<{ ok: true; uptime: number; version: string }>('/health'),

  folderTree: () => request<FolderTreeNode>('/api/memory/folders/tree'),
  listDocuments: (limit = 50) =>
    request<{ documents: DocumentSummary[] }>(`/api/memory/documents?limit=${limit}`),
  listDocumentsByFolder: (folderId: string, limit = 200) =>
    request<{ documents: DocumentSummary[] }>(
      `/api/memory/documents?folder_id=${encodeURIComponent(folderId)}&limit=${limit}`,
    ),
  getDocument: (idOrPath: string) =>
    request<DocumentFull>(`/api/memory/documents/${encodeIdOrPath(idOrPath)}`),
  getFolder: (idOrPath: string) =>
    request<{ id: string; name: string; path: string; parent_id: string | null }>(
      `/api/memory/folders/${encodeIdOrPath(idOrPath)}`,
    ),
  searchMemory: (q: string, limit = 20) =>
    request<{ results: SearchResult[] }>(
      `/api/memory/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  listSkills: () => request<{ skills: SkillSummary[] }>('/api/skills'),
  getSkill: (name: string) =>
    request<SkillRecord>(`/api/skills/${encodeURIComponent(name)}`),
  searchSkills: (q: string) =>
    request<{ skills: SkillSearchResult[] }>(`/api/skills/search?q=${encodeURIComponent(q)}`),

  listAgents: () => request<{ agents: AgentSummary[] }>('/api/agents'),

  issueWebToken: () =>
    request<IssueTokenResponse>('/api/web/issue-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),

  getT5tBoard: () => request<BoardResponse>('/api/t5t/board'),
  getT5tProject: (slug: string) =>
    request<ProjectDetailResponse>(`/api/t5t/projects/${encodeURIComponent(slug)}`),
  postT5tFeedback: (body: FeedbackRequest) =>
    request<FeedbackEntry>('/api/t5t/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  killT5tProject: (slug: string) =>
    request<ProjectSummary>(`/api/t5t/projects/${encodeURIComponent(slug)}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
};
