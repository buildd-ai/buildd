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
  const [editingCron, setEditingCron] = useState(false);
  const [cronValue, setCronValue] = useState(cronExpression || '');
  const [cronSaving, setCronSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

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
        setError('Failed to update mission');
        setTimeout(() => setError(null), 3000);
        return false;
      }
      setError(null);
      return true;
    } catch {
      setError('Failed to update mission');
      setTimeout(() => setError(null), 3000);
      return false;
    }
  }

  async function handleStatusChange(newStatus: string) {
    setStatusLoading(true);
    const ok = await patchMission({ status: newStatus });
    if (ok) {
      setStatus(newStatus);
      router.refresh();
    }
    setStatusLoading(false);
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
    } catch {
      setError('Failed to trigger run');
      setTimeout(() => setError(null), 3000);
    }
    setManualRunLoading(false);
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
        body: JSON.stringify({ title, workspaceId, missionId }),
      });
      if (res.ok) {
        setTaskTitle('');
        setError(null);
        router.refresh();
      } else {
        setError('Failed to create task');
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError('Failed to create task');
      setTimeout(() => setError(null), 3000);
    }
    setTaskLoading(false);
  }

  async function handleSaveCron() {
    const trimmed = cronValue.trim();
    setCronSaving(true);
    const ok = await patchMission({ cronExpression: trimmed || null });
    if (ok) {
      setEditingCron(false);
      router.refresh();
    }
    setCronSaving(false);
  }

  async function handleDelete() {
    setDeleteLoading(true);
    try {
      await fetch(`/api/missions/${missionId}`, { method: 'DELETE', credentials: 'include' });
      router.push('/app/missions');
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Mission Controls Bar */}
      {!isTerminal && (
        <div className="flex items-center gap-3 flex-wrap">
          {/* Monitoring toggle for missions with a schedule */}
          {hasSchedule ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => handleStatusChange(status === 'active' ? 'paused' : 'active')}
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
            /* Simple status button for missions without a schedule */
            <button
              onClick={() => handleStatusChange(status === 'active' ? 'paused' : 'active')}
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

          <div className="h-4 border-r border-card-border" />

          {/* Run Now */}
          {workspaceId && (
            <button
              onClick={handleManualRun}
              disabled={manualRunLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
              </svg>
              {manualRunLoading ? 'Running...' : 'Run now'}
            </button>
          )}

          {/* Schedule editor */}
          {!editingCron && (
            <button
              onClick={() => setEditingCron(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {cronExpression ? 'Edit schedule' : 'Add schedule'}
            </button>
          )}

          {/* Complete */}
          <button
            onClick={() => handleStatusChange('completed')}
            disabled={statusLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-success/10 border border-status-success/20 text-[12px] text-status-success hover:bg-status-success/20 transition-colors disabled:opacity-50"
          >
            Complete
          </button>

          {/* Delete */}
          {!deleteConfirm ? (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="px-3 py-1.5 rounded-lg text-[12px] text-status-error/60 hover:text-status-error hover:bg-status-error/5 transition-colors"
            >
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-text-muted">Confirm?</span>
              <button
                onClick={handleDelete}
                disabled={deleteLoading}
                className="px-2 py-1 rounded-lg bg-status-error/10 text-[11px] text-status-error hover:bg-status-error/20 transition-colors disabled:opacity-50"
              >
                {deleteLoading ? 'Deleting...' : 'Yes, delete'}
              </button>
              <button
                onClick={() => setDeleteConfirm(false)}
                className="px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
              >
                No
              </button>
            </div>
          )}
        </div>
      )}

      {/* Archived: show archive badge + delete */}
      {currentStatus === 'archived' && (
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-text-muted">Archived</span>
          {!deleteConfirm ? (
            <button onClick={() => setDeleteConfirm(true)} className="px-3 py-1.5 rounded-lg text-[12px] text-status-error/60 hover:text-status-error transition-colors">
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <button onClick={handleDelete} disabled={deleteLoading} className="px-2 py-1 rounded-lg bg-status-error/10 text-[11px] text-status-error disabled:opacity-50">{deleteLoading ? 'Deleting...' : 'Yes, delete'}</button>
              <button onClick={() => setDeleteConfirm(false)} className="px-2 py-1 text-[11px] text-text-secondary">No</button>
            </div>
          )}
        </div>
      )}

      {/* Completed: show archive + delete */}
      {currentStatus === 'completed' && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleStatusChange('archived')}
            disabled={statusLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-50"
          >
            Archive
          </button>
          {!deleteConfirm ? (
            <button onClick={() => setDeleteConfirm(true)} className="px-3 py-1.5 rounded-lg text-[12px] text-status-error/60 hover:text-status-error transition-colors">
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <button onClick={handleDelete} disabled={deleteLoading} className="px-2 py-1 rounded-lg bg-status-error/10 text-[11px] text-status-error disabled:opacity-50">{deleteLoading ? 'Deleting...' : 'Yes, delete'}</button>
              <button onClick={() => setDeleteConfirm(false)} className="px-2 py-1 text-[11px] text-text-secondary">No</button>
            </div>
          )}
        </div>
      )}

      {/* Inline cron editor */}
      {editingCron && (
        <div className="flex flex-wrap items-center gap-2 p-3 card">
          <input
            type="text"
            value={cronValue}
            onChange={e => setCronValue(e.target.value)}
            placeholder="e.g. 0 9 * * 1"
            className="w-40 px-2 py-1 bg-surface-3 border border-card-border rounded-lg text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/40 font-mono"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') handleSaveCron();
              if (e.key === 'Escape') setEditingCron(false);
            }}
          />
          {!workspaceId && cronValue.trim() && (
            <span className="text-[11px] text-status-warning">Needs workspace</span>
          )}
          <button onClick={handleSaveCron} disabled={cronSaving} className="px-2 py-1 text-[11px] font-medium bg-accent/20 text-accent-text rounded-lg hover:bg-accent/30 disabled:opacity-50">
            {cronSaving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={() => { setCronValue(cronExpression || ''); setEditingCron(false); }} className="px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          {cronExpression && (
            <button onClick={() => { setCronValue(''); handleSaveCron(); }} disabled={cronSaving} className="px-2 py-1 text-[11px] text-status-error hover:text-status-error/80">
              Remove
            </button>
          )}
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
