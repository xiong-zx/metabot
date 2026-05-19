import { useState } from 'react';
import { api, ApiError, type IssueTokenResponse } from '../lib/api';

// Bare-root host the CLI will hit — dedicated front-door domain (P4-MR6
// pivot). Matches the CLI's METABOT_CORE_URL default in `@xvirobotics/cli-core`.
// The shared multi-tenant `metabot.xvirobotics.com` is a different host and is
// not used as the CLI default; old configs against `…/core` keep working.
const CLI_ROOT_URL = 'https://metabot-core.xvirobotics.com';

export function CliAccess() {
  const [issued, setIssued] = useState<IssueTokenResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setErr(null);
    setCopied(false);
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

  return (
    <div className="main">
      <aside className="sidebar">
        <div className="sidebar-section">
          <span>cli access</span>
        </div>
        <div style={{ padding: '0 18px', color: 'var(--bone-300)', fontSize: 11, lineHeight: 1.6 }}>
          self-service token for the <code style={{ color: 'var(--amber)' }}>metabot</code> CLI.
          generating issues a fresh credential for your 飞连 identity and
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
