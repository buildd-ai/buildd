'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ActionQueueItem } from '@/lib/action-queue';


interface WaitingOnYouReviewCardProps {
  item: ActionQueueItem;
}

type MergeState = 'idle' | 'confirming' | 'merging' | 'merged' | 'error' | 'conflict_dispatched' | 'conflict_exhausted';

/**
 * Escalation card for REVIEW-chip items on the Home page.
 * Renders the confirm prompt as a full-width strip below the task title so the
 * title stays visible at the moment the user is confirming an irreversible merge.
 */
export function WaitingOnYouReviewCard({ item }: WaitingOnYouReviewCardProps) {
  const [mergeState, setMergeState] = useState<MergeState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [conflictRetryTaskId, setConflictRetryTaskId] = useState<string | null>(null);

  const handleMerge = async () => {
    setMergeState('merging');
    try {
      const res = await fetch(`/api/prs/${item.prNumber}/merge`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.conflictRetryDispatched) {
          setConflictRetryTaskId(data.conflictRetryTaskId ?? null);
          setMergeState('conflict_dispatched');
          return;
        }
        if (data.conflictExhausted) {
          setMergeState('conflict_exhausted');
          return;
        }
        setErrorMsg(data.error || 'Merge failed');
        setMergeState('error');
        return;
      }
      setMergeState('merged');
      setTimeout(() => setMergeState('idle'), 3000);
    } catch {
      setErrorMsg('Network error');
      setMergeState('error');
    }
  };

  return (
    <div className="border-l-2 border-status-error bg-status-error/5 rounded-r-[10px] px-4 py-3">
      {/* Header row: chip label + timestamp always visible */}
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

        {/* Right action slot: Merge trigger, Merging spinner, Merged confirmation */}
        {item.prNumber != null && (
          <div className="flex-shrink-0">
            {mergeState === 'idle' && (
              <button
                onClick={() => setMergeState('confirming')}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-white bg-accent hover:bg-accent/90 transition-colors px-2.5 py-0.5 rounded"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14m-7-7l7 7 7-7" />
                </svg>
                Merge
              </button>
            )}
            {mergeState === 'merging' && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted">
                <span className="w-2.5 h-2.5 rounded-full border-2 border-status-success border-t-transparent animate-spin" />
                Merging…
              </span>
            )}
            {mergeState === 'merged' && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-status-success">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Merged
              </span>
            )}
            {/* confirming: right slot empty — confirm strip renders below */}
          </div>
        )}
      </div>

      {/* Task title: always visible so the user knows what they're merging */}
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

      {item.workspaceName && (
        <div className="text-[11px] text-text-muted mt-0.5">{item.workspaceName}</div>
      )}
      {item.escalationReason && (
        <p className="text-[12px] text-text-secondary mt-0.5 line-clamp-2">{item.escalationReason}</p>
      )}

      {/* Confirm strip: full-width below the title, only when confirming */}
      {mergeState === 'confirming' && item.prNumber != null && (
        <div className="mt-2 pt-2 border-t border-status-error/20 flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-secondary min-w-0">Confirm merge?</span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setMergeState('idle')}
              className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleMerge}
              className="text-[12px] font-medium text-white bg-status-success hover:bg-status-success/90 transition-colors px-2.5 py-0.5 rounded"
            >
              Confirm Merge
            </button>
          </div>
        </div>
      )}

      {/* Error strip */}
      {mergeState === 'error' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-status-error min-w-0">{errorMsg}</span>
          <button
            onClick={() => setMergeState('idle')}
            className="text-[11px] text-text-muted hover:text-text-secondary underline flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Conflict dispatched strip */}
      {mergeState === 'conflict_dispatched' && (
        <div className="mt-2 pt-2 border-t border-status-error/20">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="w-2 h-2 rounded-full border border-text-muted border-t-transparent animate-spin inline-block flex-shrink-0" />
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

      {/* Conflict exhausted strip */}
      {mergeState === 'conflict_exhausted' && (
        <div className="mt-2 pt-2 border-t border-status-error/20">
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
    </div>
  );
}
