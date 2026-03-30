'use client';

import { timeAgo } from '@/lib/mission-helpers';

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

  if (entries.length === 0) return null;

  return (
    <div>
      <h2 className="section-label mb-3">Heartbeat History ({entries.length})</h2>
      <div className="space-y-1">
        {entries.map(task => {
          const hbStatus = getTaskHeartbeatStatus(task);
          const summary = getSummary(task);

          let icon: React.ReactNode;
          let rowClass = '';
          let textClass = 'text-text-muted';

          if (hbStatus === 'ok') {
            icon = (
              <svg className="w-4 h-4 text-status-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            );
          } else if (hbStatus === 'action_taken') {
            icon = (
              <svg className="w-4 h-4 text-status-warning shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            );
            rowClass = 'bg-status-warning/5 border-status-warning/20';
            textClass = 'text-text-primary';
          } else if (hbStatus === 'error') {
            icon = (
              <svg className="w-4 h-4 text-status-error shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            );
            rowClass = 'bg-status-error/5 border-status-error/20';
            textClass = 'text-status-error';
          } else {
            icon = (
              <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
            );
          }

          return (
            <button
              key={task.id}
              data-task-id={task.id}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-card-border hover:border-accent/30 transition-colors text-[12px] text-left ${rowClass}`}
            >
              {icon}
              <span className="text-[11px] text-text-muted shrink-0 w-16">{timeAgo(task.createdAt)}</span>
              <span className={`flex-1 truncate ${textClass}`}>{summary}</span>
              <svg className="w-3.5 h-3.5 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}
