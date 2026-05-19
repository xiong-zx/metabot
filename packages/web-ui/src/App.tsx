import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, type Manifest } from './lib/api';
import { Home } from './routes/home';
import { MemoryPath } from './routes/memory-path';
import { SkillsList } from './routes/skills-list';
import { SkillDetail } from './routes/skill-detail';
import { Search } from './routes/search';
import { T5tBoard } from './routes/t5t-board';
import { T5tProject } from './routes/t5t-project';
import { AgentsList } from './routes/agents';
import { UsersMemory } from './routes/users-memory';
import { CliAccess } from './routes/cli-access';

function Brand() {
  return (
    <div className="brand">
      <span className="glyph" />
      <span className="name">metabot-core</span>
      <span className="tag">archive console</span>
    </div>
  );
}

function SearchBar() {
  const nav = useNavigate();
  const loc = useLocation();
  const initial = new URLSearchParams(loc.search).get('q') || '';
  const [q, setQ] = useState(initial);

  useEffect(() => {
    setQ(new URLSearchParams(loc.search).get('q') || '');
  }, [loc.search]);

  return (
    <form
      className="search-bar"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = q.trim();
        if (!trimmed) return;
        nav(`/search?q=${encodeURIComponent(trimmed)}`);
      }}
    >
      <span className="prompt">›</span>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search memory + skills…  ( / to focus )"
        spellCheck={false}
        autoComplete="off"
      />
    </form>
  );
}

function MetaBar({ manifest }: { manifest: Manifest | null }) {
  const ct = manifest?.capabilities.content_types?.join(' · ') || '—';
  return (
    <div className="meta-bar">
      <span><span className="dot" />{manifest ? `${manifest.instance.name}` : 'connecting…'}</span>
      <span>schema v{manifest?.schemaVersion ?? '?'}</span>
      <span>content · {ct}</span>
      <span>飞连 SSO</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const [manifest, setManifest] = useState<Manifest | null>(null);

  useEffect(() => {
    let live = true;
    api.manifest()
      .then((m) => { if (live) setManifest(m); })
      .catch(() => {
        // 401 is handled inside api.request → hard redirect to /oauth2/sign_in.
        // Other errors leave manifest null; the MetaBar shows "connecting…".
      });
    return () => { live = false; };
  }, [loc.pathname]);

  // global '/' to focus the search input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        const el = document.querySelector<HTMLInputElement>('.search-bar input');
        if (el) { e.preventDefault(); el.focus(); el.select(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell">
      <header className="top-bar">
        <Brand />
        <SearchBar />
        <nav className="actions">
          <NavLink to="/" end>memory</NavLink>
          <NavLink to="/users">users</NavLink>
          <NavLink to="/skills">skills</NavLink>
          <NavLink to="/t5t">t5t</NavLink>
          <NavLink to="/agents">agents</NavLink>
          <NavLink to="/cli">cli</NavLink>
          <a className="signout" href="/oauth2/sign_out" title="end 飞连 SSO session">
            sign out
          </a>
        </nav>
      </header>
      <MetaBar manifest={manifest} />
      {children}
    </div>
  );
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/memory/*" element={<MemoryPath />} />
        <Route path="/skills" element={<SkillsList />} />
        <Route path="/skills/:name" element={<SkillDetail />} />
        <Route path="/t5t" element={<T5tBoard />} />
        <Route path="/t5t/:slug" element={<T5tProject />} />
        <Route path="/users" element={<UsersMemory />} />
        <Route path="/agents" element={<AgentsList />} />
        <Route path="/cli" element={<CliAccess />} />
        <Route path="/search" element={<Search />} />
        <Route path="*" element={<div className="content state">404 · no such route</div>} />
      </Routes>
    </Shell>
  );
}
