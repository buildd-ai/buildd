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
  | 'conflict_exhausted';

/**
 * Escalation card for REVIEW-chip items on the Home page.
 *
 * An `escalate` verdict names a concrete recommendation and a reason to stop
 * — not "merge anyway". So the primary action is agreeing with the reviewer
 * (Apply), a secondary action lets the human correct it before it's applied,
 * and merging past the escalation is demoted to a text link that still
 * requires a confirm tap. See the "Escalation card: Apply / Apply-with-
 * corrections / Merge-anyway" decision note for the full spec.
 */
export function WaitingOnYouReviewCard({ item }: WaitingOnYouReviewCardProps) {
  const [state, setState] = useState<CardState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [correctionsText, setCorrectionsText] = useState('');
  const [appliedTaskId, setAppliedTaskId] = useState<string | null>(null);
  const [conflictRetryTaskId, setConflictRetryTaskId] = useState<string | null>(null);

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
          {state === 'idle' && (
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
