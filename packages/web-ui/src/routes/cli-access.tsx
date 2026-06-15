import { useState } from 'react';
import { api, ApiError, type IssueTokenResponse } from '../lib/api';

// Bare-root host the CLI will hit. Personal edition: derive from the page
// origin so the snippet matches wherever the user actually hosts metabot-core
// (localhost, LAN, or their own reverse proxy). Override server-side with
// METABOT_CORE_URL if the CLI must target a different host than the web UI.
const CLI_ROOT_URL =
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost:9200';

export function CliAccess() {
  const [issued, setIssued] = useState<IssueTokenResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);

  async function generate() {
    setBusy(true);
    setErr(null);
    setCopied(false);
    setCopiedInstall(false);
    try {
      const res = await api.issueWebToken();
      setIssued(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const envBlock = issued
    ? `METABOT_CORE_URL=${CLI_ROOT_URL}\nMETABOT_CORE_TOKEN=${issued.token}`
    : '';

  const installCmd = issued
    ? `curl -fsSL ${CLI_ROOT_URL}/cli/install.sh | METABOT_CORE_TOKEN=${issued.token} bash`
    : '';

  async function copyEnv() {
    if (!envBlock) return;
    try {
      await navigator.clipboard.writeText(envBlock);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  async function copyInstall() {
    if (!installCmd) return;
    try {
      await navigator.clipboard.writeText(installCmd);
      setCopiedInstall(true);
      setTimeout(() => setCopiedInstall(false), 1800);
    } catch {
      setCopiedInstall(false);
    }
  }

  return (
    <div className="main">
      <aside className="sidebar">
        <div className="sidebar-section">
          <span>cli access</span>
        </div>
        <div style={{ padding: '0 18px', color: 'var(--bone-300)', fontSize: 11, lineHeight: 1.6 }}>
          self-service token for the <code style={{ color: 'var(--amber)' }}>metabot</code> CLI.
          generating issues a fresh credential for your account and
          revokes any previous self-service token you held.
        </div>
        <div style={{ padding: '12px 18px 0', color: 'var(--bone-300)', fontSize: 11, lineHeight: 1.6 }}>
          admin- and CLI-issued tokens are not touched by this flow.
        </div>
      </aside>
      <div className="content">
        <div className="page-head">
          <div>
            <div className="kicker">onboarding</div>
            <h1>cli access</h1>
          </div>
          <span className="crumbs">/ cli</span>
        </div>

        <div className="cli-access">
          <p className="cli-access-lead">
            Get a personal <code>metabot</code> token, paste it into your project's <code>.env</code>,
            and the CLI is ready. Regenerate any time — the old token is invalidated.
          </p>

          <div className="cli-access-actions">
            <button className="btn" disabled={busy} onClick={generate}>
              {busy ? 'generating…' : issued ? 'regenerate' : 'generate token'}
            </button>
            {issued && (
              <span className="cli-access-warn">
                regenerate rotates your token and invalidates the previous one
              </span>
            )}
          </div>

          {err && <div className="state err" style={{ padding: '40px 0' }}>{err}</div>}

          {issued && (
            <div className="cli-access-result">
              <div className="env-block-head">
                <span className="kicker">.env</span>
                <button className="btn secondary" onClick={copyEnv}>
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              <pre className="env-block">{envBlock}</pre>

              <div className="env-block-head" style={{ marginTop: 18 }}>
                <span className="kicker">一键安装（仅 CLI）</span>
                <button className="btn secondary" onClick={copyInstall}>
                  {copiedInstall ? 'copied' : 'copy'}
                </button>
              </div>
              <pre className="env-block">{installCmd}</pre>
              <div className="cli-access-meta" style={{ marginBottom: 12 }}>
                <span style={{ color: 'var(--bone-300)', fontSize: 11 }}>
                  token 会出现在 shell 历史里，需要换可随时点
                  上方 regenerate；要求 node ≥ 20。
                </span>
              </div>

              <div className="cli-access-meta">
                <span><span className="key">identity</span> {issued.botName}</span>
                <span><span className="key">credential</span> <code>{issued.credentialId}</code></span>
                {issued.rotatedFrom > 0 && (
                  <span><span className="key">rotated</span> {issued.rotatedFrom} prior token{issued.rotatedFrom === 1 ? '' : 's'}</span>
                )}
              </div>
              <div className="cli-access-once">
                this token is shown once. close this page and we cannot retrieve it —
                regenerate to mint a new one.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
