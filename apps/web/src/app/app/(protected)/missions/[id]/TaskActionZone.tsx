'use client';

/**
 * TaskActionZone: the one decision a task's phase needs, done in place
 * (docs/design/mission-feed-mobile-continuity.md W4/W6). Answer when it asks,
 * retry (or switch backend) when it failed, run now when it is queued, and say
 * why when it is blocked. Shared by the task sheet and — from slice S6 — the
 * full task page, so the two can never disagree about what a state offers.
 *
 * Self-contained: it owns the in-flight action and its error, and calls
 * `onChanged` after a successful action so the host can refetch.
 */
import { useCallback, useState } from 'react';
import Link from 'next/link';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import type { TaskPhase } from '@/lib/task-presentation';

export interface TaskActionZoneProps {
  taskId: string;
  /** Canonical phase from `deriveTaskPhase`. */
  phase: TaskPhase;
  isBlocked: boolean;
  blockedByCount: number;
  backend: 'claude' | 'codex' | null;
  lastError: { excerpt: string } | null;
  worker: { id: string; waitingFor: { prompt: string; options?: string[] } | null } | null;
  /** "View history" target on failure; omitted on the full page itself. */
  historyHref?: string | null;
  onChanged?: () => void | Promise<void>;
}

export default function TaskActionZone({
  taskId,
  phase,
  isBlocked,
  blockedByCount,
  backend,
  lastError,
  worker,
  historyHref,
  onChanged,
}: TaskActionZoneProps) {
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
      await onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActing(false);
    }
  }, [onChanged]);

  const isWaiting = phase === 'waiting_input';
  const isFailed = phase === 'failed';
  const isQueued = phase === 'pending';
  const otherBackend = backend === 'codex' ? 'claude' : backend === 'claude' ? 'codex' : null;

  return (
    <div data-testid="task-action-zone" data-phase={phase} className="space-y-3 empty:hidden">
      {/* Needs input → respond inline */}
      {isWaiting && worker?.waitingFor && (
        <div className="border-2 border-status-warning p-4">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-status-warning">Needs input</span>
          <WorkerRespondInput
            workerId={worker.id}
            question={worker.waitingFor.prompt}
            options={worker.waitingFor.options}
          />
        </div>
      )}

      {/* Failed → why + retry */}
      {isFailed && !isWaiting && (
        <div className="space-y-3 border-2 border-status-error p-4">
          {lastError ? (
            <p className="break-words font-mono text-[12px] leading-relaxed text-status-error">{lastError.excerpt}</p>
          ) : (
            <p className="font-mono text-[12px] text-text-secondary">This task failed. Retry to run it again.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {/* Single click retries on the backend it already ran on — the
                common case. The switch is one extra click, never a menu. */}
            <button
              type="button"
              onClick={() => runAction(`/api/tasks/${taskId}/reassign?force=true`)}
              disabled={acting}
              className="inline-flex min-h-11 items-center gap-1.5 border-2 border-border-strong px-3 font-mono text-[12px] font-medium text-text-primary hover:bg-surface-3 disabled:opacity-50"
            >
              {acting ? 'Retrying…' : `Retry${backend ? ` on ${backend}` : ''}`}
            </button>
            {otherBackend && (
              <button
                type="button"
                onClick={() => runAction(`/api/tasks/${taskId}/reassign?force=true`, { backend: otherBackend })}
                disabled={acting}
                className="min-h-11 px-3 font-mono text-[12px] capitalize text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
                title={`Retry this task on the ${otherBackend} backend instead`}
              >
                Switch to {otherBackend}
              </button>
            )}
            {historyHref && (
              <Link
                href={historyHref}
                className="flex min-h-11 items-center px-3 font-mono text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                View history
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Blocked — dep gate not satisfied */}
      {isBlocked && (
        <div className="border border-status-warning p-4">
          <p className="font-mono text-[12px] font-medium text-status-warning">
            Blocked — waiting on {blockedByCount} {blockedByCount === 1 ? 'dependency' : 'dependencies'}
          </p>
          <p className="mt-1 font-mono text-[11px] text-text-muted">
            This task will start automatically once its dependencies complete.
          </p>
        </div>
      )}

      {/* Queued / pending → run now */}
      {isQueued && !isWaiting && !isBlocked && (
        <div className="flex items-center justify-between gap-3 border border-border-default p-4">
          <span className="font-mono text-[12px] text-text-secondary">Waiting to be picked up by a runner.</span>
          <button
            type="button"
            onClick={() => runAction(`/api/tasks/${taskId}/start`)}
            disabled={acting}
            className="btn btn-primary min-h-11 shrink-0"
          >
            {acting ? 'Starting…' : 'Run now'}
          </button>
        </div>
      )}

      {actionError && <p className="font-mono text-[12px] text-status-error">{actionError}</p>}
    </div>
  );
}
