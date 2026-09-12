'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ActionCardContextLine } from './ActionCardContextLine';
import Spinner from './Spinner';
import { AgentRecommendation } from './AgentRecommendation';
import type { ActionQueueItem } from '@/lib/action-queue';


interface WaitingOnYouReviewCardProps {
  item: ActionQueueItem;
}

type CardState =
  | 'idle'
  | 'corrections_open'
  | 'applying'
  | 'applied'
  | 'apply_error'
  | 'confirming_override'
  | 'merging'
  | 'merged'
  | 'error'
  | 'conflict_dispatched'
  | 'conflict_exhausted'
  | 're_reviewing'
  | 're_review_dispatched';

/**
 * Escalation card for REVIEW-chip items on the Home page.
 *
 * The CTA set is derived from server state exactly like the rendered text is
 * (see docs/specs/action-queue-card-state.md I-1, extended to cover the CTA
 * set as well as the copy): Apply / Apply-with-corrections only exist when
 * `item.recommendation` names a concrete next step — an `escalate` verdict,
 * the one case that can actually be applied. With no recommendation there is
 * nothing to apply, so Merge (routed through the same human-override path as
 * "Merge anyway") is the primary action instead. A reviewer that approved
 * under an approve-only gate (`item.verdictSummary` set) just needs that
 * merge; anything else with no recommendation — the reviewer task failed or
 * was cancelled, retries were exhausted, or no reviewer task exists at all —
 * additionally offers Re-review, since nothing re-dispatches on its own from
 * a terminal state.
 *
 * Separately, ANY terminal verdict (approved or escalated) whose PR head has
 * since moved past the SHA it was made against additionally offers "Re-review
 * changes since approval" — the verdict is still valid for what it saw, but
 * new commits landed it never judged. This posts to the same re-review
 * endpoint as plain Re-review; the server decides delta-vs-full from the
 * stored verdict, so the button never needs to know which one it triggers.
 */
export function WaitingOnYouReviewCard({ item }: WaitingOnYouReviewCardProps) {
  const [state, setState] = useState<CardState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [correctionsText, setCorrectionsText] = useState('');
  const [appliedTaskId, setAppliedTaskId] = useState<string | null>(null);
  const [conflictRetryTaskId, setConflictRetryTaskId] = useState<string | null>(null);

  const hasRecommendation = Boolean(item.recommendation);
  const isApproved = !hasRecommendation && Boolean(item.verdictSummary);
  const noVerdict = !hasRecommendation && !item.verdictSummary;
  // A terminal verdict exists (approve or escalate — both reach this card) AND
  // the PR's head has moved past the SHA it was made against: there is new
  // work the verdict never saw. Re-review then means a DELTA review against
  // just that new work, not a full re-read (see /api/prs/[prNumber]/re-review).
  const canReReviewSinceApproval =
    (isApproved || hasRecommendation) &&
    Boolean(item.approvedSha) &&
    Boolean(item.headSha) &&
    item.approvedSha !== item.headSha;

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
      setAppliedTaskId(data.taskId ?? null);
      setState('applied');
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
          setConflictRetryTaskId(data.conflictRetryTaskId ?? null);
          setState('conflict_dispatched');
          return;
        }
        if (data.conflictExhausted) {
          setState('conflict_exhausted');
          return;
        }
        setErrorMsg(data.error || 'Merge failed');
        setState('error');
        return;
      }
      setState('merged');
      setTimeout(() => setState('idle'), 3000);
    } catch {
      setErrorMsg('Network error');
      setState('error');
    }
  };

  const handleReReview = async () => {
    setState('re_reviewing');
    try {
      const res = await fetch(`/api/prs/${item.prNumber}/re-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: item.workspaceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(data.error || 'Could not dispatch a new review');
        setState('error');
        return;
      }
      setState('re_review_dispatched');
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

      {item.prNumber != null && (
        <>
          {state === 'idle' && hasRecommendation && (
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
              <div className="mt-1.5 flex items-center gap-3">
                <button
                  onClick={() => setState('confirming_override')}
                  className="text-[11px] text-text-muted hover:text-text-secondary underline"
                >
                  Merge anyway
                </button>
                {canReReviewSinceApproval && (
                  <button
                    onClick={handleReReview}
                    className="text-[11px] text-text-muted hover:text-text-secondary underline"
                  >
                    Re-review changes since approval
                  </button>
                )}
              </div>
            </div>
          )}

          {/* No recommendation exists — nothing to Apply, by construction (see
              the module doc above). Merge is the primary action; a terminal
              state with no verdict at all (reviewer task failed/cancelled,
              retries exhausted, or no reviewer task exists) also gets
              Re-review, since nothing re-dispatches on its own. */}
          {state === 'idle' && !hasRecommendation && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setState('confirming_override')}
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-white bg-accent hover:bg-accent/90 transition-colors px-2.5 py-1 rounded"
                >
                  Merge
                </button>
                {noVerdict && (
                  <button
                    onClick={handleReReview}
                    className="text-[12px] font-medium text-text-secondary hover:text-text-primary transition-colors px-2.5 py-1 border border-border-default rounded"
                  >
                    Re-review
                  </button>
                )}
                {isApproved && canReReviewSinceApproval && (
                  <button
                    onClick={handleReReview}
                    className="text-[12px] font-medium text-text-secondary hover:text-text-primary transition-colors px-2.5 py-1 border border-border-default rounded"
                  >
                    Re-review changes since approval
                  </button>
                )}
              </div>
            </div>
          )}

          {state === 'corrections_open' && (
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

          {state === 'applying' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1.5">
              <Spinner size="xs" className="text-status-success" aria-label="Applying" />
              <span className="text-[12px] text-text-muted">Applying…</span>
            </div>
          )}

          {state === 'applied' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-status-success">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Fix task dispatched
              </div>
              {appliedTaskId && (
                <Link href={`/app/tasks/${appliedTaskId}`} className="text-[12px] font-medium text-primary hover:underline">
                  View task
                </Link>
              )}
            </div>
          )}

          {state === 'apply_error' && (
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

          {state === 'confirming_override' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center justify-between gap-2">
              <span className="text-[11px] text-text-secondary min-w-0">
                {hasRecommendation
                  ? 'Merge despite escalation?'
                  : isApproved
                    ? 'Merge this approved PR?'
                    : 'Merge without a reviewer verdict?'}
              </span>
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

          {state === 'merging' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1.5">
              <Spinner size="xs" className="text-status-success" aria-label="Merging" />
              <span className="text-[12px] text-text-muted">Merging…</span>
            </div>
          )}

          {state === 'merged' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1 text-[12px] font-medium text-status-success">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Merged
            </div>
          )}

          {state === 'error' && (
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

          {state === 're_reviewing' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1.5">
              <Spinner size="xs" className="text-status-success" aria-label="Dispatching review" />
              <span className="text-[12px] text-text-muted">Dispatching a new review…</span>
            </div>
          )}

          {state === 're_review_dispatched' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20 flex items-center gap-1.5 text-[12px] font-medium text-status-success">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Re-review dispatched
            </div>
          )}

          {state === 'conflict_dispatched' && (
            <div className="mt-2.5 pt-2 border-t border-status-error/20">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Spinner size="xs" className="flex-shrink-0" aria-label="Resolving conflicts" />
                <span className="text-[11px] text-text-secondary">Agent dispatched to resolve merge conflicts.</span>
              </div>
              <div className="flex items-center gap-3">
                {conflictRetryTaskId && (
                  <Link
                    href={`/app/tasks/${conflictRetryTaskId}`}
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

          {state === 'conflict_exhausted' && (
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
        </>
      )}
    </div>
  );
}
