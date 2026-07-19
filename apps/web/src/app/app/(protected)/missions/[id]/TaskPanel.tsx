'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import AiFeedback from '@/components/AiFeedback';
import LiveWorkerActivity from './LiveWorkerActivity';

interface TaskPanelData {
  id: string;
  title: string;
  status: string;
  description: string | null;
  mode: string | null;
  roleSlug: string | null;
  createdAt: string;
  missionId: string | null;
  backend: 'claude' | 'codex' | null;
  failover: { from: string; reason: string | null } | null;
  worker: {
    id: string;
    status: string;
    currentAction: string | null;
    turns: number | null;
    prUrl: string | null;
    prNumber: number | null;
    prLifecycleStatus: string | null;
    mergedAt: string | null;
    commitCount: number | null;
    filesChanged: number | null;
    linesAdded: number | null;
    linesRemoved: number | null;
    costUsd: string | null;
    startedAt: string | null;
    completedAt: string | null;
    waitingFor: { type: string; prompt: string; options?: string[] } | null;
    branch: string | null;
    milestones: Array<{ type: string; label: string; ts: number; [k: string]: unknown }> | null;
  } | null;
  result: {
    summary: string | null;
    nextSuggestion: string | null;
  } | null;
  lastError: { excerpt: string; pattern: string | null; ts: string } | null;
}

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-text-muted/15 text-text-muted' },
  queued: { label: 'Queued', cls: 'bg-status-info/15 text-status-info' },
  running: { label: 'Running', cls: 'bg-status-info/15 text-status-info' },
  assigned: { label: 'Assigned', cls: 'bg-status-info/15 text-status-info' },
  waiting_input: { label: 'Needs Input', cls: 'bg-status-warning/15 text-status-warning' },
  completed: { label: 'Completed', cls: 'bg-status-success/15 text-status-success' },
  failed: { label: 'Failed', cls: 'bg-status-error/15 text-status-error' },
};

// Mirrors the PR lifecycle pill on the mission timeline (page.tsx) so the peek
// and the row read the same. CI state comes straight from the DB (webhook-fed),
// so no live GitHub call is needed to show whether a PR is safe to merge.
const PR_LIFECYCLE: Record<string, { label: string; cls: string }> = {
  merged:     { label: 'Merged',    cls: 'bg-status-success/15 text-status-success' },
  ci_running: { label: 'CI running', cls: 'bg-status-info/15 text-status-info' },
  ci_failed:  { label: 'CI failing', cls: 'bg-status-error/15 text-status-error' },
  conflict:   { label: 'Conflict',  cls: 'bg-status-warning/15 text-status-warning' },
  closed:     { label: 'Closed',    cls: 'bg-text-muted/15 text-text-muted' },
  pr_open:    { label: 'Open',      cls: 'bg-accent/15 text-accent-text' },
};

const ExternalIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

export default function TaskPanel({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<TaskPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/summary`);
      if (!res.ok) throw new Error('Failed to load task');
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchTask();
    // Poll for updates while panel is open
    const interval = setInterval(fetchTask, 5000);
    return () => clearInterval(interval);
  }, [fetchTask]);

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fire a task action (retry / run), then refetch so the panel reflects the
  // new state immediately instead of waiting for the 5s poll.
  const runAction = useCallback(async (path: string, payload?: Record<string, unknown>) => {
    setActing(true);
    setActionError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Action failed');
      }
      await fetchTask();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActing(false);
    }
  }, [fetchTask]);

  const status = STATUS_LABELS[data?.status || ''] || STATUS_LABELS.pending;
  const w = data?.worker;
  const isWaiting = w?.status === 'waiting_input' && !!w?.waitingFor;
  const isFailed = data?.status === 'failed';
  const isRunning = w?.status === 'running';
  const isQueued = data?.status === 'pending' || data?.status === 'queued';
  const hasPr = !!w?.prUrl;
  const lifecycle = w?.prLifecycleStatus
    ? PR_LIFECYCLE[w.prLifecycleStatus]
    : hasPr ? PR_LIFECYCLE.pr_open : null;
  const diff = w && (w.linesAdded || w.linesRemoved || w.filesChanged);
  // The backend to offer as the one-click alternative on retry.
  const otherBackend = data?.backend === 'codex' ? 'claude' : data?.backend === 'claude' ? 'codex' : null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-surface-1 border-l border-border-default shadow-xl overflow-y-auto animate-slide-in-right">
        {/* Header */}
        <div className="sticky top-0 bg-surface-1 border-b border-border-default px-5 py-4 flex items-center gap-3 z-10">
          <button
            onClick={onClose}
            className="p-1 -ml-1 rounded hover:bg-surface-3 transition-colors"
            aria-label="Close panel"
          >
            <svg className="w-5 h-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <span className="text-[14px] font-semibold text-text-primary truncate flex-1">
            {loading ? 'Loading...' : data?.title || 'Task'}
          </span>
          <Link
            href={`/app/tasks/${taskId}`}
            className="text-[12px] text-accent-text hover:underline shrink-0"
          >
            Full detail &rarr;
          </Link>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <span className="text-[13px] text-text-muted">Loading task...</span>
          </div>
        )}

        {error && (
          <div className="px-5 py-8 text-center">
            <p className="text-[13px] text-status-error">{error}</p>
          </div>
        )}

        {data && !loading && (
          <div className="px-5 py-4 space-y-4">
            {/* Status + meta */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded ${status.cls}`}>
                {status.label}
              </span>
              {data.backend && (
                <span
                  className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded bg-surface-3 text-text-secondary capitalize"
                  title={`Ran on the ${data.backend} backend`}
                >
                  {data.backend}
                </span>
              )}
              {data.roleSlug && (
                <span className="text-[11px] text-text-muted font-mono">{data.roleSlug}</span>
              )}
              <span className="text-[11px] text-text-muted">{timeAgo(data.createdAt)}</span>
            </div>

            {/* Failover note — a Claude task that got flipped to Codex mid-life */}
            {data.failover && (
              <p className="text-[11px] text-text-muted">
                Switched to <span className="capitalize text-text-secondary">{data.backend}</span> after{' '}
                <span className="capitalize">{data.failover.from}</span>
                {data.failover.reason === 'budget_exhausted' ? ' hit its budget' : ' failed'}.
              </p>
            )}

            {/* ── Action zone — the one decision this state needs, done here ── */}

            {/* Needs input → respond inline */}
            {isWaiting && w?.waitingFor && (
              <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-4">
                <span className="text-[11px] font-semibold text-status-warning uppercase tracking-wider">Needs Input</span>
                <WorkerRespondInput
                  workerId={w.id}
                  question={w.waitingFor.prompt}
                  options={w.waitingFor.options}
                />
              </div>
            )}

            {/* Failed → why + retry */}
            {isFailed && !isWaiting && (
              <div className="rounded-lg border border-status-error/30 bg-status-error/5 p-4 space-y-3">
                {data.lastError ? (
                  <p className="text-[12px] text-status-error leading-relaxed font-mono break-words">
                    {data.lastError.excerpt}
                  </p>
                ) : (
                  <p className="text-[12px] text-text-secondary">This task failed. Retry to run it again.</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Single click retries on the backend it already ran on — the
                      common case. The switch is one extra click, never a menu. */}
                  <button
                    onClick={() => runAction(`/api/tasks/${taskId}/reassign?force=true`)}
                    disabled={acting}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md bg-status-warning/15 text-status-warning hover:bg-status-warning/25 disabled:opacity-50 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {acting ? 'Retrying…' : `Retry${data.backend ? ` on ${data.backend}` : ''}`}
                  </button>
                  {otherBackend && (
                    <button
                      onClick={() => runAction(`/api/tasks/${taskId}/reassign?force=true`, { backend: otherBackend })}
                      disabled={acting}
                      className="px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-3 disabled:opacity-50 transition-colors capitalize"
                      title={`Retry this task on the ${otherBackend} backend instead`}
                    >
                      Switch to {otherBackend}
                    </button>
                  )}
                  <Link
                    href={`/app/tasks/${taskId}`}
                    className="px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-3 transition-colors"
                  >
                    View history
                  </Link>
                </div>
              </div>
            )}

            {/* Queued / pending → run now */}
            {isQueued && !isWaiting && (
              <div className="rounded-lg border border-border-default p-4 flex items-center justify-between gap-3">
                <span className="text-[12px] text-text-secondary">Waiting to be picked up by a runner.</span>
                <button
                  onClick={() => runAction(`/api/tasks/${taskId}/start`)}
                  disabled={acting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md bg-accent/15 text-accent-text hover:bg-accent/25 disabled:opacity-50 transition-colors shrink-0"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  {acting ? 'Starting…' : 'Run now'}
                </button>
              </div>
            )}

            {/* Live worker → first-class view: watch what it's doing, steer or stop it */}
            {isRunning && w && (
              <LiveWorkerActivity
                workerId={w.id}
                currentAction={w.currentAction}
                turns={w.turns}
                costUsd={w.costUsd}
                milestones={(w.milestones ?? []) as never}
                onWorkerEvent={fetchTask}
              />
            )}

            {/* PR → review CI state + merge (in GitHub) without leaving to find it */}
            {hasPr && w && (
              <div className="rounded-lg border border-border-default p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-text-primary">Pull request</span>
                  {lifecycle && (
                    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${lifecycle.cls}`}>
                      {lifecycle.label}
                    </span>
                  )}
                </div>

                {diff ? (
                  <div className="flex items-center gap-3 text-[12px] tabular-nums">
                    {w.linesAdded != null && <span className="text-status-success">+{w.linesAdded}</span>}
                    {w.linesRemoved != null && <span className="text-status-error">&minus;{w.linesRemoved}</span>}
                    {w.filesChanged != null && w.filesChanged > 0 && (
                      <span className="text-text-muted">{w.filesChanged} file{w.filesChanged !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                ) : null}

                <a
                  href={w.prUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md bg-surface-3 text-text-primary hover:bg-card-hover transition-colors"
                >
                  {w.prLifecycleStatus === 'merged' ? 'View PR' : 'Review & merge'} #{w.prNumber} on GitHub
                  <ExternalIcon />
                </a>
              </div>
            )}

            {actionError && (
              <p className="text-[12px] text-status-error">{actionError}</p>
            )}

            {/* ── Details ── */}

            {/* Description */}
            {data.description && (
              <p className="text-[13px] text-text-secondary leading-relaxed line-clamp-4">
                {data.description}
              </p>
            )}

            {/* Worker stats — the run's shape once it's not live (live view owns these) */}
            {w && !isRunning && (w.turns != null || w.commitCount || w.costUsd != null || w.branch) && (
              <div className="rounded-lg border border-border-default p-4 space-y-3">
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  {w.turns != null && (
                    <div>
                      <span className="text-text-muted">Turns:</span>{' '}
                      <span className="text-text-primary">{w.turns}</span>
                    </div>
                  )}
                  {w.commitCount != null && w.commitCount > 0 && (
                    <div>
                      <span className="text-text-muted">Commits:</span>{' '}
                      <span className="text-text-primary">{w.commitCount}</span>
                    </div>
                  )}
                  {w.costUsd != null && (
                    <div>
                      <span className="text-text-muted">Cost:</span>{' '}
                      <span className="text-text-primary">${Number(w.costUsd).toFixed(3)}</span>
                    </div>
                  )}
                </div>
                {w.branch && (
                  <div className="text-[12px]">
                    <span className="text-text-muted">Branch:</span>{' '}
                    <span className="text-text-primary font-mono text-[11px] break-all">{w.branch}</span>
                  </div>
                )}
              </div>
            )}

            {/* Result summary */}
            {data.result?.summary && (
              <div>
                <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Summary</span>
                <p className="text-[13px] text-text-secondary leading-relaxed mt-1">
                  {data.result.summary}
                </p>
                <div className="mt-1.5 flex justify-end">
                  <AiFeedback entityType="summary" entityId={`task-${data.id}-summary`} compact />
                </div>
              </div>
            )}

            {/* Next suggestion */}
            {data.result?.nextSuggestion && (
              <div className="flex items-start gap-2">
                <p className="text-[12px] text-text-muted italic flex-1">
                  <span className="text-text-secondary">Suggested:</span>{' '}
                  &ldquo;{data.result.nextSuggestion}&rdquo;
                </p>
                <AiFeedback entityType="summary" entityId={`task-${data.id}-suggestion`} compact />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
