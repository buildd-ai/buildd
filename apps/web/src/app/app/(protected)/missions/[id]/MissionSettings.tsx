'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MissionDisplayState } from '@/lib/mission-helpers';

interface MissionSettingsProps {
  missionId: string;
  currentStatus: string;
  cronExpression: string | null;
  workspaceId: string | null;
  roles: { slug: string; name: string; color: string }[];
  hasSchedule: boolean;
  orchestrationMode?: 'auto' | 'manual';
  isHeld: boolean;
  displayState: MissionDisplayState;
}

export default function MissionSettings({
  missionId,
  currentStatus,
  cronExpression,
  workspaceId,
  roles,
  hasSchedule,
  orchestrationMode: initialOrchestrationMode = 'auto',
  isHeld: initialIsHeld,
  displayState,
}: MissionSettingsProps) {
  const router = useRouter();
  const [statusLoading, setStatusLoading] = useState(false);
  const [orchestrationMode, setOrchestrationMode] = useState(initialOrchestrationMode);
  const [isHeld, setIsHeld] = useState(initialIsHeld);
  const [modeLoading, setModeLoading] = useState(false);
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
    if (ok) router.refresh();
    setStatusLoading(false);
  }

  async function handleArm() {
    setModeLoading(true);
    const ok = await patchMission({ arm: true });
    if (ok) {
      setIsHeld(false);
      router.refresh();
    }
    setModeLoading(false);
  }

  async function handleToggleOrchestrationMode() {
    const newMode = orchestrationMode === 'auto' ? 'manual' : 'auto';
    setModeLoading(true);
    const ok = await patchMission({ orchestrationMode: newMode });
    if (ok) {
      setOrchestrationMode(newMode);
      router.refresh();
    }
    setModeLoading(false);
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
    <div className="space-y-4">
      {/* ── Primary CTA — state driven ── */}
      {!isTerminal && (
        <>
          {/* Held: Arm mission is the only meaningful action */}
          {isHeld && (
            <button
              onClick={handleArm}
              disabled={modeLoading}
              className="w-full md:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white text-[13px] font-semibold hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {modeLoading ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
              )}
              {modeLoading ? 'Arming…' : 'Arm mission'}
            </button>
          )}

          {/* Review-ready: Complete mission is the primary action */}
          {!isHeld && displayState === 'review' && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => handleStatusChange('completed')}
                disabled={statusLoading}
                className="w-full md:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white text-[13px] font-semibold hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {statusLoading ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                {statusLoading ? 'Completing…' : 'Complete mission'}
              </button>
              {workspaceId && (
                <button
                  onClick={handleManualRun}
                  disabled={manualRunLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                >
                  {manualRunLoading ? 'Running…' : 'Send back · re-run'}
                </button>
              )}
            </div>
          )}

          {/* Manual + not held + not review-ready: Run now is the primary action */}
          {!isHeld && displayState !== 'review' && orchestrationMode === 'manual' && workspaceId && (
            <button
              onClick={handleManualRun}
              disabled={manualRunLoading}
              className="w-full md:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white text-[13px] font-semibold hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {manualRunLoading ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
              )}
              {manualRunLoading ? 'Running…' : 'Run now'}
            </button>
          )}

          {/* Auto + not held + not review-ready: Run now is available but secondary */}
          {!isHeld && displayState !== 'review' && orchestrationMode === 'auto' && workspaceId && (
            <button
              onClick={handleManualRun}
              disabled={manualRunLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
              </svg>
              {manualRunLoading ? 'Running…' : 'Run now'}
            </button>
          )}

          {/* ── Secondary actions row ── */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Arm/Disarm toggle — text link, not prominent */}
            {!isHeld && displayState !== 'review' && (
              <button
                onClick={handleToggleOrchestrationMode}
                disabled={modeLoading}
                className="text-[11px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-50"
                title={orchestrationMode === 'manual' ? 'Switch to auto mode' : 'Switch to manual mode'}
              >
                {modeLoading ? '…' : orchestrationMode === 'manual' ? 'Auto mode' : 'Disarm'}
              </button>
            )}

            {!isHeld && displayState !== 'review' && <span className="h-3 border-r border-card-border" />}

            {/* Schedule editor */}
            {!editingCron && (
              <button
                onClick={() => setEditingCron(true)}
                className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
              >
                {cronExpression ? 'Edit schedule' : 'Add schedule'}
              </button>
            )}

            <span className="h-3 border-r border-card-border" />

            {/* Complete — hidden when review-ready (it's the primary CTA there) */}
            {displayState !== 'review' && (
              <>
                <button
                  onClick={() => handleStatusChange('completed')}
                  disabled={statusLoading}
                  className="text-[11px] text-status-success/70 hover:text-status-success transition-colors disabled:opacity-50"
                >
                  Complete
                </button>
                <span className="h-3 border-r border-card-border" />
              </>
            )}

            {/* Delete */}
            {!deleteConfirm ? (
              <button
                onClick={() => setDeleteConfirm(true)}
                className="text-[11px] text-status-error/50 hover:text-status-error transition-colors"
              >
                Delete
              </button>
            ) : (
              <span className="flex items-center gap-1">
                <span className="text-[10px] text-text-muted">Confirm?</span>
                <button
                  onClick={handleDelete}
                  disabled={deleteLoading}
                  className="px-1.5 py-0.5 rounded bg-status-error/10 text-[10px] text-status-error hover:bg-status-error/20 transition-colors disabled:opacity-50"
                >
                  {deleteLoading ? '…' : 'Delete'}
                </button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  className="text-[10px] text-text-secondary hover:text-text-primary"
                >
                  No
                </button>
              </span>
            )}
          </div>
        </>
      )}

      {/* Archived state */}
      {currentStatus === 'archived' && (
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-text-muted">Archived</span>
          {!deleteConfirm ? (
            <button onClick={() => setDeleteConfirm(true)} className="text-[11px] text-status-error/60 hover:text-status-error transition-colors">
              Delete
            </button>
          ) : (
            <span className="flex items-center gap-1">
              <button onClick={handleDelete} disabled={deleteLoading} className="px-1.5 py-0.5 rounded bg-status-error/10 text-[10px] text-status-error disabled:opacity-50">
                {deleteLoading ? '…' : 'Delete'}
              </button>
              <button onClick={() => setDeleteConfirm(false)} className="text-[10px] text-text-secondary">No</button>
            </span>
          )}
        </div>
      )}

      {/* Completed state */}
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
            <button onClick={() => setDeleteConfirm(true)} className="text-[11px] text-status-error/60 hover:text-status-error transition-colors">
              Delete
            </button>
          ) : (
            <span className="flex items-center gap-1">
              <button onClick={handleDelete} disabled={deleteLoading} className="px-1.5 py-0.5 rounded bg-status-error/10 text-[10px] text-status-error disabled:opacity-50">
                {deleteLoading ? '…' : 'Delete'}
              </button>
              <button onClick={() => setDeleteConfirm(false)} className="text-[10px] text-text-secondary">No</button>
            </span>
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
            className="w-40 px-2 py-1 bg-surface-3 border border-card-border rounded-lg text-[12px] text-text-primary placeholder:text-text-desc focus:outline-none focus:border-accent/40 font-mono"
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
            {cronSaving ? 'Saving…' : 'Save'}
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
                placeholder="Add a task to this mission…"
                className="flex-1 px-3 py-2 rounded-lg bg-surface-3 border border-card-border text-[13px] text-text-primary placeholder:text-text-desc focus:outline-none focus:border-accent/40 transition-colors"
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
                ) : 'Add'}
              </button>
            </form>
          ) : (
            <p className="text-[12px] text-text-muted">Set a workspace to add tasks.</p>
          )}
        </div>
      )}
    </div>
  );
}
