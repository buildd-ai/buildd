'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { SparklineBar } from '@/components/SparklineBar';
import type { EffortDay } from '@/components/SparklineBar';

export interface InitiativeTriageRowProps {
  id: string | 'unassigned';
  title: string;
  progress: number;
  effortDays: EffortDay[];
  awaitingVerification: number;
  blocked: number;
  held: number;
  shippedThisWeek: number;
  isDormant: boolean;
  onDismiss?: (id: string) => void;
}

export function InitiativeTriageRow({
  id,
  title,
  progress,
  effortDays,
  awaitingVerification,
  blocked,
  held,
  shippedThisWeek,
  isDormant,
  onDismiss,
}: InitiativeTriageRowProps) {
  const href =
    id === '__unassigned__' || id === 'unassigned'
      ? '/app/missions?unassigned=true'
      : `/app/initiatives/${id}`;

  // Build subline parts — all true conditions, in priority order, joined by ·
  const sublineParts: string[] = [];
  if (awaitingVerification > 0) sublineParts.push(`${awaitingVerification} awaiting merge`);
  if (blocked > 0) sublineParts.push(`${blocked} blocked`);
  if (held > 0) sublineParts.push(`${held} held`);
  if (shippedThisWeek > 0 && sublineParts.length === 0)
    sublineParts.push(`${shippedThisWeek} shipped this week`);
  const subline = sublineParts.join(' · ');

  // Swipe-to-dismiss state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const DISMISS_THRESHOLD = 80;

  function handleTouchStart(e: React.TouchEvent) {
    if (!isDormant) return;
    touchStartX.current = e.touches[0].clientX;
    setIsSwiping(false);
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!isDormant || touchStartX.current === null) return;
    const dx = touchStartX.current - e.touches[0].clientX;
    if (dx > 0) {
      setIsSwiping(true);
      setSwipeOffset(Math.min(dx, 140));
    }
  }

  function handleTouchEnd() {
    if (!isDormant) return;
    if (swipeOffset >= DISMISS_THRESHOLD) {
      onDismiss?.(id as string);
    } else {
      setSwipeOffset(0);
      setIsSwiping(false);
    }
    touchStartX.current = null;
  }

  const revealWidth = Math.min(swipeOffset, 140);

  return (
    <div className="relative overflow-hidden">
      {/* Swipe-reveal dismiss action (mobile) */}
      {isDormant && (
        <div
          className="absolute inset-y-0 right-0 flex items-center justify-end pointer-events-none"
          style={{ width: revealWidth, transition: isSwiping ? 'none' : 'width 0.2s ease' }}
          aria-hidden="true"
        >
          <div className="flex flex-col items-center justify-center h-full px-3 bg-status-warning text-[10px] text-white leading-tight text-center w-full">
            <span>Hidden from overview</span>
            <span className="opacity-70">· visible in Initiatives</span>
          </div>
        </div>
      )}

      {/* Row content */}
      <div
        className="group relative"
        style={
          isDormant
            ? {
                transform: `translateX(-${swipeOffset}px)`,
                transition: isSwiping ? 'none' : 'transform 0.2s ease',
              }
            : undefined
        }
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <Link
          href={href}
          className="flex items-start gap-3 px-1 py-2.5 rounded-lg hover:bg-card-hover transition-colors"
        >
          {/* Title + subline */}
          <div className="flex-1 min-w-0">
            <span className="block text-[13px] font-medium text-text-primary truncate leading-5">
              {title}
            </span>
            {subline && (
              <span className="block text-[11px] text-text-muted leading-4 mt-0.5">
                {subline}
              </span>
            )}
          </div>

          {/* Sparkline + progress */}
          <div className="flex items-center gap-2 shrink-0 mt-0.5">
            <SparklineBar days={effortDays} width={48} height={16} />
            <span className="text-[11px] text-text-muted tabular-nums w-8 text-right">
              {progress}%
            </span>
          </div>
        </Link>

        {/* Hover-reveal dismiss button (desktop) */}
        {isDormant && onDismiss && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onDismiss(id as string);
            }}
            className="hidden sm:flex absolute right-0 inset-y-0 items-center px-2 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-secondary"
            aria-label="Dismiss initiative from triage"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
