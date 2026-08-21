'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import type { MissionDisplayState } from '@/lib/mission-helpers';

/**
 * Every way a manual orchestrator run can end. `runMission` has five distinct
 * no-op paths; showing them is the difference between "the button is broken"
 * and "the mission is deliberately paused, here's why".
 */
type RunOutcome =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'planning'; taskId: string | null; turns?: number }
  | { kind: 'deduped'; taskId: string | null }
  | { kind: 'pr_open' }
  | { kind: 'blocked'; reason: string | null }
  | { kind: 'budget' }
  | { kind: 'error'; message: string };

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
  const [runOutcome, setRunOutcome] = useState<RunOutcome>({ kind: 'idle' });
  const [editingCron, setEditingCron] = useState(false);
  const [cronValue, setCronValue] = useState(cronExpression || '');
  const [cronSaving, setCronSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const isTerminal = ['completed', 'archived'].includes(currentStatus);

  // Live turn counter for the planning task we just started. The organizer can
  // think for minutes; without this the button settles back to idle and the work
  // is invisible.
  const planningTaskId = runOutcome.kind === 'planning' ? runOutcome.taskId : null;
  useEffect(() => {
    if (!planningTaskId || !workspaceId) return;

    const channelName = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;

    const matches = (d: { taskId?: string; worker?: { taskId?: string } }) =>
      (d.taskId ?? d.worker?.taskId) === planningTaskId;

    const onProgress = (d: { taskId?: string; turns?: number; worker?: { taskId?: string; turns?: number } }) => {
      if (!matches(d)) return;
      const turns = d.turns ?? d.worker?.turns;
      setRunOutcome((prev) =>
        prev.kind === 'planning' ? { ...prev, turns: turns ?? prev.turns } : prev,
      );
    };
    const onDone = (d: { taskId?: string; worker?: { taskId?: string } }) => {
      if (!matches(d)) return;
      setRunOutcome({ kind: 'idle' });
      router.refresh();
    };

    channel.bind('worker:progress', onProgress);
    channel.bind('worker:completed', onDone);
    channel.bind('worker:failed', onDone);

    return () => {
      channel.unbind('worker:progress', onProgress);
      channel.unbind('worker:completed', onDone);
      channel.unbind('worker:failed', onDone);
      unsubscribeFromChannel(channelName);
    };
  }, [planningTaskId, workspaceId, router]);

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

  // Arming a mission means both things a stalled mission needs: the orchestrator
  // ticks itself (orchestrationMode) and workers may claim its tasks (isHeld).
  // These used to be separate controls — one an 11px text link labelled "Auto
  // mode", the other a button labelled "Arm mission" that only appeared when
  // held — and "armed but held" is not a state anyone asks for.
  async function handleArm() {
    setModeLoading(true);
    const ok = await patchMission({ arm: true, orchestrationMode: 'auto' });
    if (ok) {
      setIsHeld(false);
      setOrchestrationMode('auto');
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
    setRunOutcome({ kind: 'starting' });
    try {
      const res = await fetch(`/api/missions/${missionId}/run`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));

      if (!res.ok) {
        setRunOutcome({ kind: 'error', message: (data.error as string) || 'Failed to trigger run' });
      } else if (data.deduped) {
        setRunOutcome({ kind: 'deduped', taskId: (data.task as any)?.id ?? null });
      } else if (data.skippedPrOpen) {
        setRunOutcome({ kind: 'pr_open' });
      } else if (data.skippedBlocked) {
        setRunOutcome({ kind: 'blocked', reason: (data.blockedReason as string) ?? null });
      } else if (data.skippedBudgetExhausted) {
        setRunOutcome({ kind: 'budget' });
      } else {
        setRunOutcome({ kind: 'planning', taskId: (data.task as any)?.id ?? null });
        router.refresh();
      }
    } catch {
      setRunOutcome({ kind: 'error', message: 'Network error' });
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

          {/* Manual + not held + not review-ready: arming is the primary action.
              "Plan once" was the primary CTA here, which put a one-shot poke
              above the durable state change people actually came to make. */}
          {!isHeld && displayState !== 'review' && orchestrationMode === 'manual' && (
            <div className="flex flex-wrap items-center gap-3">
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
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                )}
                {modeLoading ? 'Arming…' : 'Arm mission'}
              </button>
              {workspaceId && (
                <button
                  onClick={handleManualRun}
                  disabled={manualRunLoading}
                  title="Run the orchestrator once, then return to idle"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                  </svg>
                  Plan once
                </button>
              )}
            </div>
          )}

          {/* Auto + not held + not review-ready: an extra tick is secondary */}
          {!isHeld && displayState !== 'review' && orchestrationMode === 'auto' && workspaceId && (
            <button
              onClick={handleManualRun}
              disabled={manualRunLoading}
              title="Tick the orchestrator now instead of waiting for the schedule"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-card-border text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
              </svg>
              Plan now
            </button>
          )}

          <RunOutcomeStrip outcome={runOutcome} onDismiss={() => setRunOutcome({ kind: 'idle' })} />

          {/* ── Secondary actions row ── */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Disarm — the inverse of Arm mission. Arming is a primary button
                above, so this side of the toggle is the only text link left. */}
            {!isHeld && displayState !== 'review' && orchestrationMode === 'auto' && (
              <>
                <button
                  onClick={handleToggleOrchestrationMode}
                  disabled={modeLoading}
                  className="text-[11px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-50"
                  title="Stop the orchestrator from ticking itself; you drive it with Plan now"
                >
                  {modeLoading ? '…' : 'Disarm'}
                </button>
                <span className="h-3 border-r border-card-border" />
              </>
            )}

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

/**
 * Reports what a manual orchestrator run actually did. "Run now" used to call
 * router.refresh() for every outcome, so a deliberate skip and a started
 * planning cycle looked identical: nothing visibly happened.
 */
function RunOutcomeStrip({
  outcome,
  onDismiss,
}: {
  outcome: RunOutcome;
  onDismiss: () => void;
}) {
  if (outcome.kind === 'idle') return null;

  const spinner = (
    <span className="w-2.5 h-2.5 rounded-full border-2 border-accent border-t-transparent animate-spin inline-block flex-shrink-0" />
  );

  const shell = (tone: string, children: React.ReactNode) => (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] ${tone}`}>
      {children}
    </div>
  );

  const taskLink = (taskId: string | null, label: string) =>
    taskId ? (
      <Link href={`/app/tasks/${taskId}`} className="font-medium text-primary hover:underline">
        {label}
      </Link>
    ) : null;

  switch (outcome.kind) {
    case 'starting':
      return shell('border-card-border bg-surface-3 text-text-secondary', <>{spinner}<span>Starting the orchestrator…</span></>);

    case 'planning':
      return shell(
        'border-accent/30 bg-accent/5 text-text-secondary',
        <>
          {spinner}
          <span>
            Planning{outcome.turns ? ` · ${outcome.turns} turn${outcome.turns === 1 ? '' : 's'}` : ''} — it
            decides what to run next, which can take a few minutes.
          </span>
          {taskLink(outcome.taskId, 'View organizer →')}
        </>,
      );

    case 'deduped':
      return shell(
        'border-card-border bg-surface-3 text-text-secondary',
        <>
          {spinner}
          <span>Already planning — nothing new was started.</span>
          {taskLink(outcome.taskId, 'View organizer →')}
        </>,
      );

    case 'pr_open':
      return shell(
        'border-status-warning/30 bg-status-warning/5 text-text-secondary',
        <>
          <span className="text-status-warning font-mono">⏸</span>
          <span>Paused: the mission PR is still open. Planning resumes when it merges.</span>
        </>,
      );

    case 'blocked':
      return shell(
        'border-status-warning/30 bg-status-warning/5 text-text-secondary',
        <>
          <span className="text-status-warning font-mono">⏸</span>
          <span>{outcome.reason || 'Blocked by an upstream mission.'}</span>
        </>,
      );

    case 'budget':
      return shell(
        'border-status-error/30 bg-status-error/5 text-text-secondary',
        <>
          <span className="text-status-error font-mono">✕</span>
          <span>Cost budget exhausted — raise it to keep planning.</span>
        </>,
      );

    case 'error':
      return shell(
        'border-status-error/30 bg-status-error/5 text-status-error',
        <>
          <span className="font-mono">✕</span>
          <span className="min-w-0">{outcome.message}</span>
          <button onClick={onDismiss} className="text-text-muted hover:text-text-secondary underline flex-shrink-0">
            Dismiss
          </button>
        </>,
      );
  }
}
