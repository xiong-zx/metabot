import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, ApiError, type DocumentFull, type DocumentSummary } from '../lib/api';
import { FolderTree } from '../components/FolderTree';
import { DocRow } from '../components/DocRow';
import { renderMarkdown } from '../lib/render-markdown';
import { HtmlDocFrame } from '../lib/render-html';
import { contentTypeBadge, formatAbsolute } from '../lib/format';

type View =
  | { kind: 'loading' }
  | { kind: 'doc'; doc: DocumentFull }
  | { kind: 'folder'; folderPath: string; folderId: string; docs: DocumentSummary[] }
  | { kind: 'error'; msg: string };

export function MemoryPath() {
  const loc = useLocation();
  // /memory/foo/bar  → path '/foo/bar'   ;  /memory → '/'
  const raw = loc.pathname.replace(/^\/memory/, '');
  const path = raw && raw !== '/' ? raw : '/';

  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    setView({ kind: 'loading' });
    resolve(path)
      .then((v) => { if (live) setView(v); })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (live) setView({ kind: 'error', msg: e instanceof Error ? e.message : 'failed' });
      });
    return () => { live = false; };
  }, [path]);

  return (
    <div className="main">
      <aside className="sidebar">
        <FolderTree activePath={view.kind === 'folder' ? view.folderPath : undefined} />
      </aside>
      <div className="content">
        <Body view={view} path={path} />
      </div>
    </div>
  );
}

async function resolve(path: string): Promise<View> {
  // Try document first; if 404, try folder.
  try {
    const doc = await api.getDocument(path);
    return { kind: 'doc', doc };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
  }
  try {
    const folder = await api.getFolder(path);
    const { documents } = await api.listDocumentsByFolder(folder.id);
    return { kind: 'folder', folderPath: folder.path, folderId: folder.id, docs: documents };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return { kind: 'error', msg: `not found · ${path}` };
    }
    throw e;
  }
}

function Crumbs({ path }: { path: string }) {
  const segments = path.split('/').filter(Boolean);
  const parts: { label: string; href: string }[] = [{ label: '/', href: '/memory' }];
  let acc = '';
  for (const seg of segments) {
    acc += '/' + seg;
    parts.push({ label: seg, href: '/memory' + acc });
  }
  return (
    <span className="crumbs">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span style={{ opacity: 0.4, margin: '0 6px' }}>›</span>}
          <Link to={p.href}>{p.label}</Link>
        </span>
      ))}
    </span>
  );
}

function Body({ view, path }: { view: View; path: string }) {
  if (view.kind === 'loading') {
    return (
      <>
        <div className="page-head">
          <div>
            <div className="kicker">resolving</div>
            <h1>{path}</h1>
          </div>
          <Crumbs path={path} />
        </div>
        <div className="state"><span className="cursor">loading</span></div>
      </>
    );
  }
  if (view.kind === 'error') {
    return (
      <>
        <div className="page-head">
          <div>
            <div className="kicker">error</div>
            <h1>{path}</h1>
          </div>
          <Crumbs path={path} />
        </div>
        <div className="state err">{view.msg}</div>
      </>
    );
  }
  if (view.kind === 'folder') {
    return (
      <>
        <div className="page-head">
          <div>
            <div className="kicker">folder</div>
            <h1>{view.folderPath === '/' ? '/' : view.folderPath}</h1>
          </div>
          <Crumbs path={view.folderPath} />
        </div>
        {view.docs.length === 0 ? (
          <div className="state">empty folder</div>
        ) : view.docs.map((d, i) => <DocRow key={d.id} doc={d} index={i} />)}
      </>
    );
  }
  const { doc } = view;
  const badgeClass = doc.content_type === 'text/html' ? 'badge html' : 'badge md';
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">document</div>
          <Crumbs path={doc.path} />
        </div>
        <span className={badgeClass}>{contentTypeBadge(doc.content_type)}</span>
      </div>
      <header className="doc-header">
        <h2 className="doc-title">{doc.title || doc.path}</h2>
        <div className="doc-meta">
          <span><strong>{doc.created_by || 'unknown'}</strong></span>
          <span>updated · {formatAbsolute(doc.updated_at)}</span>
          {doc.tags.map((t) => <span key={t} className="badge tag">#{t}</span>)}
        </div>
      </header>
      {doc.content_type === 'text/html' ? (
        <HtmlDocFrame content={doc.content} />
      ) : (
        <div
          className="md"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content || '') }}
        />
      )}
    </>
  );
}
