'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import MergeConfirmButton from './MergeConfirmButton';
import ExternalLink from './ExternalLink';
import { resolveWaitingCardState } from '@/lib/waiting-card-state';
import type { ActionQueueItem } from '@/lib/action-queue';

interface WaitingOnYouMergeCardProps {
  item: ActionQueueItem;
}

const MERGED_DISMISS_MS = 5000;

export function WaitingOnYouMergeCard({ item }: WaitingOnYouMergeCardProps) {
  const cardState = resolveWaitingCardState(item.prLifecycleStatus);
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(cardState !== 'full');
  const containerRef = useRef<HTMLDivElement>(null);

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
          <div className="text-[13px] font-medium text-text-primary">
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
                {item.missionTitle && ` in ${item.missionTitle}`}
              </span>
            )}
          </div>
          {item.escalationReason && (
            <p className="text-[12px] text-text-secondary mt-0.5 line-clamp-2">
              {item.escalationReason}
            </p>
          )}
          {item.workspaceName && (
            <div className="text-[11px] text-text-muted mt-0.5">{item.workspaceName}</div>
          )}
        </div>
        {item.prNumber != null && (
          <MergeConfirmButton
            prNumber={item.prNumber}
            prUrl={item.prUrl ?? ''}
            queuedTaskCount={item.unblockCount}
          />
        )}
      </div>
    </div>
  );
}
