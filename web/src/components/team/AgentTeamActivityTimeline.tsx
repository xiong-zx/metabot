import { useMemo } from 'react';
import type { AgentTeamActivityRecord } from '../../types';
import s from './ActivityTimeline.module.css';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return isToday ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function statusLabel(record: AgentTeamActivityRecord): string {
  const stage = record.lifecycleStage ? `/${record.lifecycleStage}` : '';
  return `${record.status}${stage}`;
}

function ActivityIcon({ record }: { record: AgentTeamActivityRecord }) {
  if (record.status === 'complete' || record.status === 'agent_activity') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (record.status === 'error') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-error, #ef4444)" strokeWidth="2.5" strokeLinecap="round">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

interface Props {
  records: AgentTeamActivityRecord[];
  agentFilter?: string;
}

export function AgentTeamActivityTimeline({ records, agentFilter }: Props) {
  const filtered = useMemo(() => {
    const safeRecords = Array.isArray(records) ? records : [];
    const scoped = agentFilter
      ? safeRecords.filter((record) => record.agentName === agentFilter)
      : safeRecords;
    return scoped.slice(0, 50);
  }, [records, agentFilter]);

  if (filtered.length === 0) {
    return (
      <div className={s.empty}>
        <span className={s.emptyText}>No Agent Team activity yet</span>
      </div>
    );
  }

  return (
    <div className={s.timeline}>
      {filtered.map((record) => (
        <div key={record.lifecycleKey} className={`${s.event} ${s.teamEvent}`}>
          <div className={s.iconCol}>
            <ActivityIcon record={record} />
            <div className={s.line} />
          </div>
          <div className={s.content}>
            <div className={s.header}>
              <span className={s.botName}>
                {record.teamName || record.instanceId || record.botName}
                {record.agentName ? ` / ${record.agentName}` : ''}
              </span>
              <span className={s.time}>{formatTime(record.updatedAt)}</span>
            </div>
            <div className={s.prompt}>
              {record.responsePreview || record.checkpointNote || record.userPrompt || record.lifecycleKey}
            </div>
            <div className={s.meta}>
              <span className={s.metaItem}>{statusLabel(record)}</span>
              {record.runId && <span className={s.metaItem}>run {record.runId}</span>}
              {record.restartRequestId && <span className={s.metaItem}>restart {record.restartRequestId}</span>}
              {record.finalDeliveryStatus && <span className={s.metaItem}>final {record.finalDeliveryStatus}</span>}
              {record.taskIds?.length ? <span className={s.metaItem}>tasks #{record.taskIds.join(', #')}</span> : null}
              {record.checkpointNote && (
                <span className={s.metaItem}>checkpoint: {record.checkpointNote.slice(0, 80)}</span>
              )}
              {record.leaseExpiresAt && Date.now() < record.leaseExpiresAt && (
                <span className={s.metaItem}>lease active</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
