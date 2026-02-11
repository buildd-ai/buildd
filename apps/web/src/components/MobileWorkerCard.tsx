'use client';

import Link from 'next/link';

interface Props {
  workerId: string;
  name: string;
  status: string;
  taskTitle: string | null;
  workspaceName: string | null;
  milestones: Array<{ label: string; timestamp: number }>;
  turns: number;
  costUsd: string | null;
  startedAt: string | null;
  taskId: string;
}

const STATUS_DOT_COLORS: Record<string, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-emerald-500',
  waiting_input: 'bg-amber-500',
  awaiting_plan_approval: 'bg-amber-500',
  completed: 'bg-blue-500',
  failed: 'bg-red-500',
  idle: 'bg-slate-500',
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
  const progressWidth = Math.min(100, milestones.length * 10);
  const isWaiting = status === 'waiting_input' || status === 'awaiting_plan_approval';

  return (
    <Link href={`/app/tasks/${taskId}`} className="block">
      <div
        className={`rounded-xl bg-slate-800 p-4 border border-slate-700 animate-card-enter ${
          isWaiting ? 'animate-pulse-border' : ''
        }`}
      >
        {/* Header: status dot + name */}
        <div className="flex items-center gap-2 mb-1">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT_COLORS[status] || 'bg-slate-500'}`} />
          <span className="text-base font-semibold text-white truncate">
            {taskTitle || name}
          </span>
        </div>

        {/* Workspace name */}
        {workspaceName && (
          <p className="text-sm text-slate-400 mb-3 truncate">{workspaceName}</p>
        )}

        {/* Progress bar */}
        <div className="mb-3">
          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 rounded-full transition-all duration-500 ease-in-out"
              style={{ width: `${progressWidth}%` }}
            />
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>${parseFloat(costUsd || '0').toFixed(2)}</span>
            <span>{turns} turns</span>
            <span>{formatElapsed(startedAt)}</span>
          </div>

          {isWaiting && (
            <span className="text-xs font-medium text-amber-400">
              Review Plan &rarr;
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
