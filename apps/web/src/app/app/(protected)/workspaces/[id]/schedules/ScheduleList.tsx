'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  taskTemplate: { title: string; description?: string };
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  totalRuns: number;
  consecutiveFailures: number;
  lastError: string | null;
}

interface Props {
  workspaceId: string;
  initialSchedules: Schedule[];
}

function formatRelative(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiff = Math.abs(diffMs);

  if (absDiff < 60000) return diffMs > 0 ? 'in <1m' : '<1m ago';
  if (absDiff < 3600000) {
    const mins = Math.round(absDiff / 60000);
    return diffMs > 0 ? `in ${mins}m` : `${mins}m ago`;
  }
  if (absDiff < 86400000) {
    const hours = Math.round(absDiff / 3600000);
    return diffMs > 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(absDiff / 86400000);
  return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
}

export function ScheduleList({ workspaceId, initialSchedules }: Props) {
  const router = useRouter();
  const [schedules, setSchedules] = useState(initialSchedules);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function toggleEnabled(schedule: Schedule) {
    setToggling(schedule.id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });

      if (res.ok) {
        const data = await res.json();
        setSchedules((prev) =>
          prev.map((s) => (s.id === schedule.id ? data.schedule : s))
        );
      }
    } catch {
      // Silent failure
    } finally {
      setToggling(null);
    }
  }

  async function deleteSchedule(id: string) {
    if (!confirm('Delete this schedule? Existing tasks will not be affected.')) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/schedules/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setSchedules((prev) => prev.filter((s) => s.id !== id));
      }
    } catch {
      // Silent failure
    } finally {
      setDeleting(null);
    }
  }

  if (schedules.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p className="text-lg mb-2">No schedules yet</p>
        <p className="text-sm">Create a schedule to automatically run tasks on a cron cadence.</p>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
      {schedules.map((schedule) => (
        <div key={schedule.id} className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-medium truncate">{schedule.name}</h3>
                {!schedule.enabled && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    Paused
                  </span>
                )}
                {schedule.consecutiveFailures > 0 && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                    {schedule.consecutiveFailures} failure{schedule.consecutiveFailures !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-0.5">
                <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">{schedule.cronExpression}</code>
                {' '}{schedule.timezone}
              </p>
              <p className="text-sm text-gray-500 mt-0.5">
                Creates: {schedule.taskTemplate.title}
              </p>
              <div className="flex items-center gap-4 mt-1 text-xs text-gray-400">
                <span>Next: {formatRelative(schedule.nextRunAt)}</span>
                <span>Last: {formatRelative(schedule.lastRunAt)}</span>
                <span>{schedule.totalRuns} total runs</span>
                {schedule.lastTaskId && (
                  <a
                    href={`/app/tasks/${schedule.lastTaskId}`}
                    className="text-blue-500 hover:underline"
                  >
                    Last task
                  </a>
                )}
              </div>
              {schedule.lastError && (
                <p className="text-xs text-red-500 mt-1 truncate">{schedule.lastError}</p>
              )}
            </div>

            <div className="flex items-center gap-2 ml-4">
              {/* Enable/Disable toggle */}
              <button
                type="button"
                role="switch"
                aria-checked={schedule.enabled}
                onClick={() => toggleEnabled(schedule)}
                disabled={toggling === schedule.id}
                className={`relative w-10 h-6 rounded-full transition-colors ${
                  schedule.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'
                } ${toggling === schedule.id ? 'opacity-50' : ''}`}
              >
                <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${
                  schedule.enabled ? 'translate-x-4' : ''
                }`} />
              </button>

              {/* Edit */}
              <button
                onClick={() => router.push(`/app/workspaces/${workspaceId}/schedules?edit=${schedule.id}`)}
                className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                title="Edit"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>

              {/* Delete */}
              <button
                onClick={() => deleteSchedule(schedule.id)}
                disabled={deleting === schedule.id}
                className="p-1.5 text-gray-400 hover:text-red-500"
                title="Delete"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
