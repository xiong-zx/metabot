import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type ProjectDetailResponse } from '../lib/api';
import { formatRelative } from '../lib/format';
import { StatusPill } from '../components/t5t/StatusPill';
import { GoalBanner } from '../components/t5t/GoalBanner';
import { EvaluatorPanel } from '../components/t5t/EvaluatorPanel';
import { BottleneckCallout } from '../components/t5t/BottleneckCallout';
import { VerticalWIPBoard } from '../components/t5t/VerticalWIPBoard';
import { T5TTimeline } from '../components/t5t/T5TTimeline';
import { FeedbackThread } from '../components/t5t/FeedbackThread';

export function T5tProject() {
  const { slug = '' } = useParams();
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback((live: () => boolean) => {
    api.getT5tProject(slug)
      .then((d) => { if (live()) setDetail(d); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (e instanceof ApiError && e.status === 404) {
          if (live()) setErr(`project_not_found · ${slug}`);
          return;
        }
        if (live()) setErr(e instanceof Error ? e.message : 'failed');
      });
  }, [slug]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setErr(null);
    load(() => alive);
    return () => { alive = false; };
  }, [load]);

  const refresh = useCallback(() => {
    load(() => true);
  }, [load]);

  return (
    <div className="main">
      <aside className="sidebar">
        <div className="sidebar-section">
          <span>project</span>
          <span className="count">{detail?.entries.length ?? '—'}</span>
        </div>
        <div style={{ padding: '0 18px' }}>
          <Link to="/t5t" style={{ fontSize: 12 }}>‹ back to board</Link>
        </div>
      </aside>
      <div className="content">
        <div className="page-head">
          <div>
            <div className="kicker">project</div>
            <h1>{detail?.project.name || slug}</h1>
          </div>
          <span className="crumbs">
            <Link to="/t5t">/ t5t</Link> ›{' '}
            {detail ? detail.project.slug : slug}
          </span>
        </div>

        {err && <div className="state err">{err}</div>}
        {!err && !detail && (
          <div className="state"><span className="cursor">loading</span></div>
        )}

        {!err && detail && (
          <div className="t5t-grid">
            <div
              className="doc-meta"
              style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}
            >
              <StatusPill status={detail.project.status} />
              <span>
                负责人 ·{' '}
                <strong>{detail.project.leaderEmail || '无 owner'}</strong>
              </span>
              <span>
                最后活动 ·{' '}
                {detail.project.lastPush
                  ? formatRelative(detail.project.lastPush)
                  : '—'}
              </span>
              {detail.project.killCriteria && (
                <span>kill · {detail.project.killCriteria}</span>
              )}
            </div>

            <GoalBanner goal={detail.project.goal} slug={detail.project.slug} />
            <BottleneckCallout bottleneck={detail.project.bottleneck} />

            <div className="t5t-cols">
              <div className="t5t-grid">
                <VerticalWIPBoard
                  columns={detail.wipBoard}
                  slug={detail.project.slug}
                />
                <div className="section">
                  <h2>
                    timeline{' '}
                    <span className="count">{detail.entries.length}</span>
                  </h2>
                  <T5TTimeline entries={detail.entries} />
                </div>
              </div>
              <div className="t5t-grid">
                <EvaluatorPanel
                  evaluators={detail.project.evaluators}
                  slug={detail.project.slug}
                />
                <FeedbackThread
                  feedback={detail.feedback}
                  entries={detail.entries}
                  onPosted={refresh}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
