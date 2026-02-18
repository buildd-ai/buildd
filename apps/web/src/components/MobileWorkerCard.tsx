'use client';

import Link from 'next/link';

interface Props {
  workerId: string;
  name: string;
  status: string;
  taskTitle: string | null;
  workspaceName: string | null;
  milestones: Array<{ label: string; timestamp: number; type?: string; event?: string }>;
  turns: number;
  costUsd: string | null;
  startedAt: string | null;
  taskId: string;
}

const STATUS_DOT_COLORS: Record<string, string> = {
  running: 'bg-status-success',
  starting: 'bg-status-success',
  waiting_input: 'bg-status-warning',
  awaiting_plan_approval: 'bg-status-warning',
  completed: 'bg-status-info',
  failed: 'bg-status-error',
  idle: 'bg-text-muted',
};

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return '-';
  const mins = Math.round((Date.now() - new Date(startedAt).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function MobileWorkerCard({
  name,
  status,
  taskTitle,
  workspaceName,
  milestones,
  turns,
  costUsd,
  startedAt,
  taskId,
}: Props) {
  const CHECKPOINT_ORDER = ['session_started', 'first_read', 'first_edit', 'first_commit', 'task_completed'];
  const checkpointEvents = new Set(
    milestones
      .filter(m => m.type === 'checkpoint')
      .map(m => m.event)
  );
  const checkpointCount = CHECKPOINT_ORDER.filter(e => checkpointEvents.has(e)).length;
  const progressWidth = checkpointCount > 0
    ? Math.round((checkpointCount / CHECKPOINT_ORDER.length) * 100)
    : Math.min(100, milestones.length * 10); // Fallback for workers without checkpoints
  const isWaiting = status === 'waiting_input' || status === 'awaiting_plan_approval';

  return (
    <Link href={`/app/tasks/${taskId}`} className="block">
      <div
        className={`rounded-md bg-surface-2 p-4 border border-border-default animate-card-enter ${
          isWaiting ? 'animate-pulse-border' : ''
        }`}
      >
        {/* Header: status dot + name */}
        <div className="flex items-center gap-2 mb-1">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT_COLORS[status] || 'bg-text-muted'}`} />
          <span className="text-base font-semibold text-text-primary truncate">
            {taskTitle || name}
          </span>
        </div>

        {/* Workspace name */}
        {workspaceName && (
          <p className="text-sm text-text-secondary mb-3 truncate">{workspaceName}</p>
        )}

        {/* Progress bar */}
        <div className="mb-3">
          <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500 ease-in-out"
              style={{ width: `${progressWidth}%` }}
            />
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 font-mono text-xs text-text-muted">
            <span>${parseFloat(costUsd || '0').toFixed(2)}</span>
            <span>{turns} turns</span>
            <span>{formatElapsed(startedAt)}</span>
          </div>

          {isWaiting && (
            <span className="text-xs font-medium text-status-warning">
              Review Plan &rarr;
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
