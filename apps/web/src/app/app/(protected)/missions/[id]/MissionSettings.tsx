'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { timeAgo } from '@/lib/mission-helpers';

interface MissionSettingsProps {
  missionId: string;
  currentStatus: string;
  cronExpression: string | null;
  workspaceId: string | null;
  roles: { slug: string; name: string; color: string }[];
  schedule: {
    nextRunAt: string | null;
    lastRunAt: string | null;
  } | null;
  hasSchedule: boolean;
}

export default function MissionSettings({
  missionId,
  currentStatus,
  cronExpression,
  workspaceId,
  roles,
  schedule,
  hasSchedule,
}: MissionSettingsProps) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [statusLoading, setStatusLoading] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskLoading, setTaskLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRunLoading, setManualRunLoading] = useState(false);

  const isTerminal = ['completed', 'archived'].includes(currentStatus);

  async function patchMission(body: Record<string, unknown>) {
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error('Failed to update mission:', res.status);
        setError('Failed to update mission');
        setTimeout(() => setError(null), 3000);
        return false;
      }
      setError(null);
      return true;
    } catch (err) {
      console.error('Failed to update mission:', err);
      setError('Failed to update mission');
      setTimeout(() => setError(null), 3000);
      return false;
    }
  }

  async function handleStatusToggle() {
    const newStatus = status === 'active' ? 'paused' : 'active';
    setStatusLoading(true);
    const ok = await patchMission({ status: newStatus });
    if (ok) {
      setStatus(newStatus);
      router.refresh();
    }
    setStatusLoading(false);
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    const title = taskTitle.trim();
    if (!title || !workspaceId) return;

    setTaskLoading(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title,
          workspaceId,
          missionId: missionId,
        }),
      });
      if (res.ok) {
        setTaskTitle('');
        setError(null);
        router.refresh();
      } else {
        console.error('Failed to create task:', res.status);
        setError('Failed to create task');
        setTimeout(() => setError(null), 3000);
      }
    } catch (err) {
      console.error('Failed to create task:', err);
      setError('Failed to create task');
      setTimeout(() => setError(null), 3000);
    }
    setTaskLoading(false);
  }

  async function handleManualRun() {
    setManualRunLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}/run`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        router.refresh();
      } else {
        setError('Failed to trigger run');
        setTimeout(() => setError(null), 3000);
      }
    } catch (err) {
      console.error('Failed to trigger run:', err);
      setError('Failed to trigger run');
      setTimeout(() => setError(null), 3000);
    }
    setManualRunLoading(false);
  }

  return (
    <div className="space-y-5">
      {/* Mission Controls Bar — hidden for completed/archived missions */}
      {!isTerminal && (
        <div className="flex items-center gap-4 flex-wrap">
          {/* Monitoring toggle for missions with a schedule */}
          {hasSchedule ? (
            <div className="flex items-center gap-3">
              <button
                onClick={handleStatusToggle}
                disabled={statusLoading}
                className="group relative flex items-center"
                aria-label={status === 'active' ? 'Pause monitoring' : 'Resume monitoring'}
              >
                <span
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                    status === 'active' ? 'bg-status-success/60' : 'bg-surface-3'
                  } ${statusLoading ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      status === 'active' ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </span>
              </button>
              <span className="text-[12px] text-text-secondary">
                {status === 'active' ? 'Monitoring active' : 'Monitoring paused'}
              </span>
              {status === 'active' && (
                <span className="flex items-center gap-1.5 text-[12px] text-text-muted">
                  {schedule?.lastRunAt && (
                    <span>Last: {timeAgo(schedule.lastRunAt)}</span>
                  )}
                  {schedule?.nextRunAt && (
                    <span>&middot; Next: {timeAgo(schedule.nextRunAt)}</span>
                  )}
                </span>
              )}
            </div>
          ) : (
            /* Simple status toggle for missions without a schedule */
            <button
              onClick={handleStatusToggle}
              disabled={statusLoading}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  status === 'active'
                    ? 'bg-status-success'
                    : status === 'paused'
                      ? 'bg-status-warning'
                      : 'bg-text-muted'
                }`}
              />
              <span className="capitalize">{status}</span>
            </button>
          )}

          {/* Evaluate now */}
          <div className="h-4 border-r border-card-border" />
          <button
            onClick={handleManualRun}
            disabled={manualRunLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
            {manualRunLoading ? 'Evaluating...' : 'Evaluate now'}
          </button>
        </div>
      )}

      {error && (
        <p className="text-[12px] text-status-error">{error}</p>
      )}

      {/* Quick Task Creation — hidden for completed/archived missions */}
      {!isTerminal && (
        <div>
          <h2 className="section-label mb-2">Quick Task</h2>
          {workspaceId ? (
            <form onSubmit={handleAddTask} className="flex gap-2">
              <input
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Add a task to this mission..."
                className="flex-1 px-3 py-2 rounded-lg bg-surface-3 border border-card-border text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/40 transition-colors"
              />
              <button
                type="submit"
                disabled={taskLoading || !taskTitle.trim()}
                className="px-4 py-2 rounded-lg bg-accent/20 text-accent-text text-[13px] font-medium hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {taskLoading ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Adding
                  </span>
                ) : (
                  'Add'
                )}
              </button>
            </form>
          ) : (
            <p className="text-[12px] text-text-muted">
              Set a workspace to add tasks.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
