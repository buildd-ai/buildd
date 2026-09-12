'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ActionCardContextLine } from './ActionCardContextLine';
import Spinner from './Spinner';
import { AgentRecommendation } from './AgentRecommendation';
import { ReviewerVerdictBanner } from './ReviewerVerdictBanner';
import type { ActionQueueItem } from '@/lib/action-queue';


interface WaitingOnYouReviewCardProps {
  item: ActionQueueItem;
}

// Everything here is transient client-only UI for the moment of a click —
// what happens AFTER a dispatch (conflict resolution in progress, merged,
// retries exhausted) is never decided here. Home already re-renders this
// card's `item` prop from live server state on every relevant event
// (HomeAutoRefresh subscribes to the workspace's Pusher channel), and once
// that happens the chip itself usually changes (REVIEW → RESOLVING, or the
// item disappears once merged) — so a stale local state that outlives its
// click would either show the wrong thing forever or never even get the
// chance to, once the parent swaps in a different branch. `optimistic` below
// exists only to cover the gap between "the fetch resolved" and "the next
// server-derived props arrived", and is cleared unconditionally the moment
// new props land.
type CardState =
  | 'idle'
  | 'corrections_open'
  | 'applying'
  | 'apply_error'
  | 'confirming_override'
  | 'merging'
  | 'error';

type Optimistic =
  | { kind: 'applied'; taskId: string | null }
  | { kind: 'conflict_dispatched'; taskId: string | null }
  | { kind: 'conflict_exhausted' }
  | { kind: 'merged' };

/**
 * Escalation card for REVIEW-chip items on the Home page.
 *
 * An `escalate` verdict names a concrete recommendation and a reason to stop
 * — not "merge anyway". So the primary action is agreeing with the reviewer
 * (Apply), a secondary action lets the human correct it before it's applied,
 * and merging past the escalation is demoted to a text link that still
 * requires a confirm tap. See the "Escalation card: Apply / Apply-with-
 * corrections / Merge-anyway" decision note for the full spec.
 *
 * An `approve` verdict — reached automatically or via a forced re-review —
 * renders via `ReviewerVerdictBanner` regardless of `state`/`optimistic`: the
 * verdict is server truth (`item.reviewerVerdict`), not something a click can
 * ever invalidate.
 */
export function WaitingOnYouReviewCard({ item }: WaitingOnYouReviewCardProps) {
  const router = useRouter();
  const [state, setState] = useState<CardState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [correctionsText, setCorrectionsText] = useState('');
  const [optimistic, setOptimistic] = useState<Optimistic | null>(null);

  // The moment fresh server props land, whatever `optimistic` was covering is
  // either already reflected in `item` or superseded by it — it must never
  // outlive the click that produced it. (See the module doc above: this is
  // the "never trust local state past the click" rule made mechanical.)
  // `state` itself is untouched here — 'corrections_open'/'confirming_override'
  // are in-progress human input, not a claim about what happened server-side,
  // and a background refresh (any open tab gets these via HomeAutoRefresh)
  // must not wipe text the human is mid-typing.
  useEffect(() => {
    setOptimistic(null);
  }, [item]);

  const handleApply = async (corrections?: string) => {
    setState('applying');
    try {
      const res = await fetch(`/api/prs/${item.prNumber}/apply-recommendation`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: item.workspaceId, corrections }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(data.error || 'Could not apply the recommendation');
        setState('apply_error');
        return;
      }
      setOptimistic({ kind: 'applied', taskId: data.taskId ?? null });
      router.refresh();
    } catch {
      setErrorMsg('Network error');
      setState('apply_error');
    }
  };

  const handleMergeAnyway = async () => {
    setState('merging');
    try {
      const res = await fetch(`/api/prs/${item.prNumber}/merge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: item.workspaceId,
          override: true,
          escalationReason: item.escalationReason ?? null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.conflictRetryDispatched) {
          setOptimistic({ kind: 'conflict_dispatched', taskId: data.conflictRetryTaskId ?? null });
          router.refresh();
          return;
        }
        if (data.conflictExhausted) {
          setOptimistic({ kind: 'conflict_exhausted' });
          router.refresh();
          return;
        }
        setErrorMsg(data.error || 'Merge failed');
        setState('error');
        return;
      }
      setOptimistic({ kind: 'merged' });
      router.refresh();
    } catch {
      setErrorMsg('Network error');
      setState('error');
    }
  };

  return (
    <div className="border-l-2 border-status-error bg-status-error/5 rounded-r-[10px] px-4 py-3">
      {/* Header row: chip label + timestamp */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-[10px] font-mono font-medium text-status-error tracking-wide uppercase">
              Review
            </span>
            {item.waitingMinutes != null && item.waitingMinutes > 0 && (
              <span className="text-[10px] text-text-muted">
                {item.waitingMinutes < 60
                  ? `${item.waitingMinutes}m`
                  : `${Math.floor(item.waitingMinutes / 60)}h`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Task title: always visible so the user knows what's being escalated */}
      {item.taskId ? (
        <Link
          href={`/app/tasks/${item.taskId}`}
          className="text-[13px] font-medium text-text-primary truncate hover:underline block mt-0.5"
        >
          {item.taskTitle}
        </Link>
      ) : (
        <div className="text-[13px] font-medium text-text-primary truncate mt-0.5">{item.taskTitle}</div>
      )}

      <ActionCardContextLine item={item} className="mt-0.5" />
      {item.escalationReason && (
        <p className="text-[12px] text-text-secondary mt-0.5 line-clamp-2">{item.escalationReason}</p>
      )}
      <AgentRecommendation recommendation={item.recommendation} />
      {/* Server truth, not click state — see the module doc above. Renders in
          every branch below, including while a conflict retry is in flight. */}
      <ReviewerVerdictBanner verdict={item.reviewerVerdict} stale={item.approvalStale} />

      {item.prNumber != null && (
        <>
          {optimistic?.kind === 'applied' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-status-success">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Fix task dispatched
              </div>
              {optimistic.taskId && (
                <Link href={`/app/tasks/${optimistic.taskId}`} className="text-[12px] font-medium text-primary hover:underline">
                  View task
                </Link>
              )}
            </div>
          )}

          {optimistic?.kind === 'conflict_dispatched' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Spinner size="xs" className="flex-shrink-0" aria-label="Resolving conflicts" />
                <span className="text-[11px] text-text-secondary">Agent dispatched to resolve merge conflicts.</span>
              </div>
              <div className="flex items-center gap-3">
                {optimistic.taskId && (
                  <Link
                    href={`/app/tasks/${optimistic.taskId}`}
                    className="text-[12px] font-medium text-primary hover:underline"
                  >
                    View task
                  </Link>
                )}
                {item.prUrl && (
                  <a
                    href={item.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-text-muted hover:text-text-secondary underline"
                  >
                    Abandon PR
                  </a>
                )}
              </div>
            </div>
          )}

          {optimistic?.kind === 'conflict_exhausted' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <p className="text-[11px] text-status-error mb-1.5">
                Conflict resolution retries exhausted. Manual action required.
              </p>
              <div className="flex items-center gap-3">
                {item.prUrl && (
                  <a
                    href={item.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] font-medium text-primary hover:underline"
                  >
                    Resolve conflicts on GitHub
                  </a>
                )}
                {item.prUrl && (
                  <a
                    href={item.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-text-muted hover:text-text-secondary underline"
                  >
                    Abandon PR
                  </a>
                )}
              </div>
            </div>
          )}

          {optimistic?.kind === 'merged' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1 text-[12px] font-medium text-status-success">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Merged
            </div>
          )}

          {!optimistic && state === 'idle' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleApply(undefined)}
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-white bg-accent hover:bg-accent/90 transition-colors px-2.5 py-1 rounded"
                >
                  Apply
                </button>
                <button
                  onClick={() => setState('corrections_open')}
                  className="text-[12px] font-medium text-text-secondary hover:text-text-primary transition-colors px-2.5 py-1 border border-border-default rounded"
                >
                  Apply with corrections
                </button>
              </div>
              <button
                onClick={() => setState('confirming_override')}
                className="mt-1.5 text-[11px] text-text-muted hover:text-text-secondary underline"
              >
                Merge anyway
              </button>
            </div>
          )}

          {!optimistic && state === 'corrections_open' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <textarea
                autoFocus
                value={correctionsText}
                onChange={(e) => setCorrectionsText(e.target.value)}
                placeholder="What should the agent do instead? (the reviewer's recommendation is still passed along as context)"
                className="w-full text-[12px] text-text-primary bg-surface-primary border border-border-default rounded p-2 min-h-[72px] resize-y"
              />
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  onClick={() => { setCorrectionsText(''); setState('idle'); }}
                  className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleApply(correctionsText.trim() || undefined)}
                  disabled={correctionsText.trim().length === 0}
                  className="text-[12px] font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 transition-colors px-2.5 py-0.5 rounded"
                >
                  Apply with corrections
                </button>
              </div>
            </div>
          )}

          {!optimistic && state === 'applying' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1.5">
              <Spinner size="xs" className="text-status-success" aria-label="Applying" />
              <span className="text-[12px] text-text-muted">Applying…</span>
            </div>
          )}

          {!optimistic && state === 'apply_error' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center justify-between gap-2">
              <span className="text-[11px] text-status-error min-w-0">{errorMsg}</span>
              <button
                onClick={() => setState('idle')}
                className="text-[11px] text-text-muted hover:text-text-secondary underline flex-shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {!optimistic && state === 'confirming_override' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center justify-between gap-2">
              <span className="text-[11px] text-text-secondary min-w-0">Merge despite escalation?</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setState('idle')}
                  className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMergeAnyway}
                  className="text-[12px] font-medium text-white bg-status-success hover:bg-status-success/90 transition-colors px-2.5 py-0.5 rounded"
                >
                  Confirm Merge
                </button>
              </div>
            </div>
          )}

          {!optimistic && state === 'merging' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1.5">
              <Spinner size="xs" className="text-status-success" aria-label="Merging" />
              <span className="text-[12px] text-text-muted">Merging…</span>
            </div>
          )}

          {!optimistic && state === 'error' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center justify-between gap-2">
              <span className="text-[11px] text-status-error min-w-0">{errorMsg}</span>
              <button
                onClick={() => setState('idle')}
                className="text-[11px] text-text-muted hover:text-text-secondary underline flex-shrink-0"
              >
                Retry
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
