'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ExternalLink from './ExternalLink';
import Spinner from './Spinner';
import { resolveWaitingCardState } from '@/lib/waiting-card-state';
import { resolveMergeOutcome } from '@/lib/merge-outcome';
import { ActionCardContextLine } from './ActionCardContextLine';
import { AgentRecommendation } from './AgentRecommendation';
import type { ActionQueueItem } from '@/lib/action-queue';

interface WaitingOnYouMergeCardProps {
  item: ActionQueueItem;
}

const MERGED_DISMISS_MS = 5000;

// `state` below is transient client-only UI for the moment of a click, same
// as WaitingOnYouReviewCard (see docs/specs/action-queue-card-state.md, I-1).
// What happens AFTER a dispatch — merged, already merged, a conflict retry
// in flight, retries exhausted — is never decided by `state`: that's server
// truth, held in `optimistic` only until fresh `item` props land, then
// cleared unconditionally so a background refresh always wins.
type MergeState = 'idle' | 'confirming' | 'merging' | 'error';

type Optimistic =
  | { kind: 'merged' }
  | { kind: 'stale' }
  | { kind: 'conflict_dispatched'; taskId: string | null }
  | { kind: 'conflict_exhausted' };

/** How long the ✓ / stale confirmation shows before the server re-render lands. */
const RESOLVE_REFRESH_MS = 1200;

export function WaitingOnYouMergeCard({ item }: WaitingOnYouMergeCardProps) {
  const router = useRouter();
  const cardState = resolveWaitingCardState(item.prLifecycleStatus);
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(cardState !== 'full');
  const containerRef = useRef<HTMLDivElement>(null);

  const [mergeState, setMergeState] = useState<MergeState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [optimistic, setOptimistic] = useState<Optimistic | null>(null);

  // The moment fresh server props land, whatever `optimistic` was covering is
  // either already reflected in `item` or superseded by it — it must never
  // outlive the click that produced it.
  useEffect(() => {
    setOptimistic(null);
  }, [item]);

  useEffect(() => {
    if (cardState === 'merged_resolved') {
      const timer = setTimeout(() => setDismissed(true), MERGED_DISMISS_MS);
      return () => clearTimeout(timer);
    }
  }, [cardState]);

  // Animate collapse on mount when lifecycle has already resolved
  useEffect(() => {
    if (cardState !== 'full') {
      setCollapsed(true);
    }
  }, [cardState]);

  if (dismissed) return null;

  const handleMerge = async () => {
    setMergeState('merging');
    try {
      const res = await fetch(`/api/prs/${item.prNumber}/merge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: item.workspaceId }),
      });
      const data = res.ok ? null : await res.json().catch(() => null);
      const outcome = resolveMergeOutcome(res.ok, res.status, data);

      switch (outcome.kind) {
        case 'merged':
        case 'stale':
          setOptimistic({ kind: outcome.kind });
          // Re-render Home so the card resolves (or disappears) instead of
          // flipping back to an idle Merge button that looks like a dead click.
          setTimeout(() => router.refresh(), RESOLVE_REFRESH_MS);
          break;
        case 'conflict_dispatched':
          setOptimistic({ kind: 'conflict_dispatched', taskId: outcome.taskId });
          router.refresh();
          break;
        case 'conflict_exhausted':
          setOptimistic({ kind: 'conflict_exhausted' });
          router.refresh();
          break;
        case 'error':
          setErrorMsg(outcome.message);
          setMergeState('error');
          break;
      }
    } catch {
      setErrorMsg('Network error');
      setMergeState('error');
    }
  };

  const confirmMsg = item.unblockCount
    ? `Merging will unblock ${item.unblockCount} queued task${item.unblockCount === 1 ? '' : 's'}.`
    : 'Confirm merge?';

  if (cardState === 'merged_resolved') {
    return (
      <div
        ref={containerRef}
        className="border-l-2 border-status-success bg-status-success/5 rounded-r-[10px] px-4 py-2 transition-all duration-200 ease-out overflow-hidden"
        style={{ maxHeight: collapsed ? '40px' : '200px' }}
      >
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-status-success font-mono font-medium">✓</span>
          {item.prUrl ? (
            <ExternalLink href={item.prUrl} className="font-medium text-text-primary hover:underline">
              PR #{item.prNumber}
            </ExternalLink>
          ) : (
            <span className="font-medium text-text-primary">PR #{item.prNumber}</span>
          )}
          <span className="text-text-secondary">
            merged —{' '}
            {item.unblockCount != null && item.unblockCount > 0
              ? `${item.unblockCount} task${item.unblockCount !== 1 ? 's' : ''} starting`
              : 'tasks starting'}
          </span>
        </div>
      </div>
    );
  }

  if (cardState === 'closed_warning') {
    const blockedTasksHref = item.missionId
      ? `/app/missions/${item.missionId}`
      : item.taskId
      ? `/app/tasks/${item.taskId}`
      : null;

    const inner = (
      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-status-warning font-mono font-medium">⚠</span>
        <span className="font-medium text-text-primary">PR #{item.prNumber}</span>
        <span className="text-text-secondary">
          closed without merging
          {item.unblockCount != null && item.unblockCount > 0
            ? ` · ${item.unblockCount} task${item.unblockCount !== 1 ? 's' : ''} still blocked`
            : ''}
        </span>
      </div>
    );

    return (
      <div
        className="border-l-2 border-status-warning bg-status-warning/5 rounded-r-[10px] px-4 py-2 transition-all duration-200 ease-out overflow-hidden"
        style={{ maxHeight: collapsed ? '40px' : '200px' }}
      >
        {blockedTasksHref ? (
          <Link href={blockedTasksHref} className="block hover:opacity-80">
            {inner}
          </Link>
        ) : (
          inner
        )}
      </div>
    );
  }

  // Full card (open or null lifecycle — stays visible)
  return (
    <div className="border-l-2 border-primary bg-primary/5 rounded-r-[10px] px-4 py-3">
      {/* Header row: chip label + task title + timestamp always visible */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-[10px] font-mono font-medium text-primary tracking-wide uppercase">
              Merge
            </span>
            {(item.upstreamTaskTitle ?? item.taskTitle) && (
              <span className="text-[12px] text-text-secondary truncate">
                {item.upstreamTaskTitle ?? item.taskTitle}
              </span>
            )}
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
            {optimistic?.kind === 'merged' && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-status-success">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Merged
              </span>
            )}
            {optimistic?.kind === 'stale' && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-text-muted">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Already merged
              </span>
            )}
            {!optimistic && mergeState === 'idle' && (
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
            {!optimistic && mergeState === 'merging' && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted">
                <Spinner size="xs" className="text-status-success" aria-label="Merging" />
                Merging…
              </span>
            )}
            {/* confirming: right slot empty — confirm strip renders below */}
          </div>
        )}
      </div>

      {/* PR title/link: always visible so the user knows what they're merging */}
      <div className="text-[13px] font-medium text-text-primary mt-0.5">
        {item.prUrl ? (
          <a
            href={item.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            PR #{item.prNumber}
          </a>
        ) : item.taskId ? (
          <Link href={`/app/tasks/${item.taskId}`} className="hover:underline">
            {item.taskTitle}
          </Link>
        ) : null}
        {item.unblockCount != null && item.unblockCount > 0 && (
          <span className="text-text-secondary font-normal">
            {' '}→ unblocks {item.unblockCount} task{item.unblockCount !== 1 ? 's' : ''}
            {/* Named only when the blocked work lives in a different mission than
                the PR's own — otherwise the context line below already says it. */}
            {item.unblockMissionTitle && item.unblockMissionTitle !== item.missionTitle &&
              ` in ${item.unblockMissionTitle}`}
          </span>
        )}
      </div>

      {item.escalationReason && (
        <p className="text-[12px] text-text-secondary mt-0.5 break-words">
          {item.escalationReason}
        </p>
      )}
      <AgentRecommendation recommendation={item.recommendation} />
      <ActionCardContextLine item={item} className="mt-0.5" />

      {/* Confirm strip: full-width below the title, only when confirming */}
      {!optimistic && mergeState === 'confirming' && item.prNumber != null && (
        <div className="mt-2 pt-2 border-t border-primary/20 flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-secondary min-w-0">{confirmMsg}</span>
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
      {!optimistic && mergeState === 'error' && (
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

      {/* Conflict dispatched strip — agent is handling it */}
      {optimistic?.kind === 'conflict_dispatched' && (
        <div className="mt-2 pt-2 border-t border-primary/20">
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

      {/* Conflict exhausted strip — retries maxed, human must act */}
      {optimistic?.kind === 'conflict_exhausted' && (
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
