import { useEffect, useState } from 'react';
import { api, ApiError, type AgentSummary } from '../lib/api';
import { formatAbsolute, formatRelative } from '../lib/format';

export function AgentsList() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.listAgents()
      .then(({ agents }) => { if (live) setAgents(agents); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (live) setErr(e instanceof Error ? e.message : 'failed');
      });
    return () => { live = false; };
  }, []);

  return (
    <div className="main">
      <aside className="sidebar">
        <div className="sidebar-section">
          <span>agents</span>
          <span className="count">{agents?.length ?? '—'}</span>
        </div>
        <div style={{ padding: '0 18px', color: 'var(--bone-300)', fontSize: 11, lineHeight: 1.6 }}>
          registered bot agents reachable via the talk-bus. read-only — register,
          rotate visibility, or talk to an agent via the <code style={{ color: 'var(--amber)' }}>metabot</code> CLI.
        </div>
      </aside>
      <div className="content">
        <div className="page-head">
          <div>
            <div className="kicker">registry</div>
            <h1>agents</h1>
          </div>
          <span className="crumbs">/ agents</span>
        </div>
        {err && <div className="state err">{err}</div>}
        {!err && !agents && <div className="state"><span className="cursor">loading</span></div>}
        {!err && agents && agents.length === 0 && (
          <div className="state">no agents registered · run <code>metabot agents register</code> from a bot host</div>
        )}
        {!err && agents && agents.length > 0 && (
          <table className="agents-table">
            <thead>
              <tr>
                <th className="idx">#</th>
                <th>name</th>
                <th>url</th>
                <th>last seen</th>
                <th>visibility</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a, i) => (
                <tr key={a.botName}>
                  <td className="idx">{String(i + 1).padStart(3, '0')}</td>
                  <td className="name">{a.botName}</td>
                  <td className="url"><code>{a.url}</code></td>
                  <td className="ts" title={formatAbsolute(a.lastSeenAt)}>{formatRelative(a.lastSeenAt)}</td>
                  <td>
                    <span className={`badge ${a.visible ? 'vis-published' : 'vis-private'}`}>
                      {a.visible ? 'visible' : 'hidden'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
