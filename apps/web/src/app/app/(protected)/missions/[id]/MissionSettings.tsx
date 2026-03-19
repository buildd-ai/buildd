'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { cronToHuman, timeAgo } from '@/lib/mission-helpers';

interface MissionSettingsProps {
  missionId: string;
  currentStatus: string;
  cronExpression: string | null;
  defaultRoleSlug: string | null;
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
  defaultRoleSlug,
  workspaceId,
  roles,
  schedule,
  hasSchedule,
}: MissionSettingsProps) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [roleSlug, setRoleSlug] = useState(defaultRoleSlug);
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [roleLoading, setRoleLoading] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskLoading, setTaskLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRunLoading, setManualRunLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!roleDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setRoleDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [roleDropdownOpen]);

  const currentRole = roles.find((r) => r.slug === roleSlug);

  async function patchMission(body: Record<string, unknown>) {
    try {
      const res = await fetch(`/api/objectives/${missionId}`, {
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

  async function handleRoleChange(slug: string | null) {
    setRoleDropdownOpen(false);
    setRoleLoading(true);
    const ok = await patchMission({ defaultRoleSlug: slug });
    if (ok) {
      setRoleSlug(slug);
      router.refresh();
    }
    setRoleLoading(false);
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
          objectiveId: missionId,
          ...(roleSlug ? { roleSlug } : {}),
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
      const res = await fetch(`/api/objectives/${missionId}/run`, {
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
      {/* Mission Controls Bar */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Status Toggle */}
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
          {status === 'paused' && (
            <span className="text-text-muted">(paused)</span>
          )}
        </button>

        <div className="h-4 border-r border-card-border" />

        {/* Role Badge */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setRoleDropdownOpen(!roleDropdownOpen)}
            disabled={roleLoading}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          >
            {currentRole ? (
              <>
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: currentRole.color }}
                />
                <span>{currentRole.name}</span>
              </>
            ) : (
              <span className="text-text-muted">No role</span>
            )}
            <svg
              className="w-3 h-3 text-text-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>

          {roleDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 min-w-[160px] bg-surface-3 border border-card-border rounded-lg shadow-lg z-10 py-1">
              <button
                onClick={() => handleRoleChange(null)}
                className="w-full text-left px-3 py-1.5 text-[12px] text-text-muted hover:bg-card-hover transition-colors"
              >
                None
              </button>
              {roles.map((role) => (
                <button
                  key={role.slug}
                  onClick={() => handleRoleChange(role.slug)}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-card-hover transition-colors flex items-center gap-2"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: role.color }}
                  />
                  <span>{role.name}</span>
                  {role.slug === roleSlug && (
                    <svg className="w-3 h-3 ml-auto text-accent-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Schedule Info */}
        {cronExpression && (
          <>
            <div className="h-4 border-r border-card-border" />
            <div className="flex items-center gap-2 text-[12px] text-text-muted">
              <svg
                className="w-3.5 h-3.5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="font-mono text-[11px] text-text-secondary">
                {cronToHuman(cronExpression)}
              </span>
              {schedule?.nextRunAt && (
                <span>
                  &middot; Next: {timeAgo(schedule.nextRunAt)}
                </span>
              )}
              <span>
                &middot; Last:{' '}
                {schedule?.lastRunAt ? timeAgo(schedule.lastRunAt) : 'Never run'}
              </span>
            </div>
          </>
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

      {error && (
        <p className="text-[12px] text-status-error">{error}</p>
      )}

      {/* Quick Task Creation */}
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
    </div>
  );
}
