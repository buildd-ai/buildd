'use client';

import { useState } from 'react';
import { timeAgo } from '@/lib/mission-helpers';
import AiFeedback from '@/components/AiFeedback';

interface HeartbeatTimelineProps {
  tasks: Array<{
    id: string;
    createdAt: Date | string;
    status: string;
    result: any;
  }>;
}

type HeartbeatStatus = 'ok' | 'action_taken' | 'error';

function getTaskHeartbeatStatus(task: HeartbeatTimelineProps['tasks'][0]): HeartbeatStatus | null {
  const status = task.result?.structuredOutput?.status;
  if (status === 'ok' || status === 'action_taken' || status === 'error') return status;
  return null;
}

function getSummary(task: HeartbeatTimelineProps['tasks'][0]): string {
  const summary = task.result?.structuredOutput?.summary || task.result?.summary;
  if (summary) return summary;
  const status = getTaskHeartbeatStatus(task);
  if (status === 'ok') return 'All systems nominal';
  if (status === 'action_taken') return 'Action was taken';
  if (status === 'error') return 'Error occurred';
  return task.status === 'completed' ? 'Completed' : task.status;
}

export default function HeartbeatTimeline({ tasks }: HeartbeatTimelineProps) {
  const entries = tasks.slice(0, 20);
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  return (
    <div className="card p-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          {/* EKG/pulse wave icon — distinct from task icons */}
          <svg className="w-3.5 h-3.5 text-[#059669] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12h3l2-7 4 14 3-10 2 3h4" />
          </svg>
          <h2 className="section-label">Evaluation Log</h2>
          <span className="text-[11px] text-text-muted shrink-0">({entries.length})</span>
        </span>
        <svg
          className={`w-4 h-4 text-text-muted shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <p className="text-[11px] text-text-muted mt-0.5">
        Periodic re-evaluation cycles — not task executions
      </p>

      {expanded && (
        <div className="space-y-1 mt-3 border-t border-border-default pt-3">
          {entries.map(task => {
            const hbStatus = getTaskHeartbeatStatus(task);
            const summary = getSummary(task);

            let statusLabel = '';
            let statusClass = 'text-text-muted';
            let rowClass = '';

            if (hbStatus === 'ok') {
              statusLabel = 'OK';
              statusClass = 'text-status-success';
            } else if (hbStatus === 'action_taken') {
              statusLabel = 'ACTED';
              statusClass = 'text-status-warning';
              rowClass = 'bg-status-warning/5';
            } else if (hbStatus === 'error') {
              statusLabel = 'ERROR';
              statusClass = 'text-status-error';
              rowClass = 'bg-status-error/5';
            } else {
              statusLabel = '—';
            }

            return (
              <button
                key={task.id}
                data-task-id={task.id}
                className={`w-full flex items-center gap-3 px-2.5 py-1.5 rounded-md hover:bg-card-hover transition-colors text-[12px] text-left ${rowClass}`}
              >
                {/* Evaluation marker — square, not circle (distinct from worker dots) */}
                <span className={`w-2 h-2 rounded-sm shrink-0 ${
                  hbStatus === 'ok' ? 'bg-status-success/60' :
                  hbStatus === 'action_taken' ? 'bg-status-warning/60' :
                  hbStatus === 'error' ? 'bg-status-error/60' :
                  'bg-border-default'
                }`} />
                <span className={`text-[9px] font-bold tracking-wider w-8 shrink-0 ${statusClass}`}>{statusLabel}</span>
                <span className="text-[11px] text-text-muted shrink-0 w-12 tabular-nums">{timeAgo(task.createdAt)}</span>
                <span className="flex-1 truncate text-text-secondary">{summary}</span>
                <span onClick={(e) => e.stopPropagation()}>
                  <AiFeedback entityType="heartbeat" entityId={task.id} showDismiss compact />
                </span>
                <svg className="w-3 h-3 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
