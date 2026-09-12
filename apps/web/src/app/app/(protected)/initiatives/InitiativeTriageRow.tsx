'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { SparklineBar } from '@/components/SparklineBar';
import { verdictChip } from '@/lib/verdict-presentation';
import type { InitiativePulse } from '@/lib/verdict-presentation';

/**
 * One initiative row on the Initiatives list (spec §4.1).
 *
 * Anatomy, and the order matters:
 *
 *   [ Verdict ] [ Title ]                    [ sparkline 84×24 ] [ XX% ]
 *   [ subline — only when a signal exists ]
 *   [ N/M missions · N/M tasks ]
 *
 * The verdict leads because the question is "are we winning". The percentage
 * stays at the far right in muted type: it is the scope meter, and §6.5 forbids
 * it as the row's primary signal — task count is the one number an autonomous
 * fleet inflates by working.
 *
 * The sparkline mounts at 84×24, the §6.4 default. It previously mounted 48×16,
 * which drew 2.5px bars.
 *
 * Below `sm` the anatomy reflows: the title spans the full row width and the
 * sparkline/meter drop to the evidence line. Sharing one line on a 390px
 * viewport left the title ~50px after a `READY TO CLOSE` chip, an `unverified`
 * qualifier and a 124px right rail — every row truncated to `Code…`, which is
 * not a title. The reflow is pure grid placement, so the row still mounts
 * exactly one sparkline (AC-13).
 */

/** §6.4 default mount. A smaller mount is a spec violation. */
const SPARKLINE_WIDTH = 84;
const SPARKLINE_HEIGHT = 24;

export interface InitiativeTriageRowProps {
  pulse: InitiativePulse;
  /** Dormant rows only — the zone list passes this for `dormant` and `empty`. */
  onDismiss?: (id: string) => void;
}

export function InitiativeTriageRow({ pulse, onDismiss }: InitiativeTriageRowProps) {
  const {
    id, title, progress, effortDays, verdict, confidence,
    awaitingVerification, blocked, held, shippedThisWeek,
    completedMissions, totalMissions, completedTasks, totalTasks,
  } = pulse;

  const chip = verdictChip(verdict);
  const isDismissible = onDismiss !== undefined;

  // Subline: every true condition, in §4.2's order, joined by ·. "shipped this
  // week" only surfaces when nothing is waiting — good news never outranks work.
  const sublineParts: string[] = [];
  if (awaitingVerification > 0) sublineParts.push(`${awaitingVerification} awaiting merge`);
  if (blocked > 0) sublineParts.push(`${blocked} blocked`);
  if (held > 0) sublineParts.push(`${held} held`);
  if (shippedThisWeek > 0 && sublineParts.length === 0)
    sublineParts.push(`${shippedThisWeek} shipped this week`);
  const subline = sublineParts.join(' · ');

  // Swipe-to-dismiss — dormant rows only (§4.4). A row in either zone above
  // MUST NOT be dismissible, by gesture or by button.
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const DISMISS_THRESHOLD = 80;

  function handleTouchStart(e: React.TouchEvent) {
    if (!isDismissible) return;
    touchStartX.current = e.touches[0].clientX;
    setIsSwiping(false);
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!isDismissible || touchStartX.current === null) return;
    const dx = touchStartX.current - e.touches[0].clientX;
    if (dx > 0) {
      setIsSwiping(true);
      setSwipeOffset(Math.min(dx, 140));
    }
  }

  function handleTouchEnd() {
    if (!isDismissible) return;
    if (swipeOffset >= DISMISS_THRESHOLD) {
      onDismiss?.(id);
    } else {
      setSwipeOffset(0);
      setIsSwiping(false);
    }
    touchStartX.current = null;
  }

  const revealWidth = Math.min(swipeOffset, 140);

  return (
    <div className="relative overflow-hidden">
      {/* Swipe-reveal dismiss action (mobile).
          Only mounted while a swipe is actually in progress. At width 0 the
          panel still painted: as a flex item its automatic minimum size is
          min-content, so it clamped to its longest word and sat over the right
          of every dormant row. The clipper now hides the overflow too, and the
          panel keeps a fixed width so the label is revealed, never squeezed. */}
      {isDismissible && revealWidth > 0 && (
        <div
          className="absolute inset-y-0 right-0 flex items-center justify-end overflow-hidden pointer-events-none"
          style={{ width: revealWidth, transition: isSwiping ? 'none' : 'width 0.2s ease' }}
          aria-hidden="true"
        >
          <div className="flex flex-col items-center justify-center h-full w-[140px] shrink-0 px-3 bg-status-warning text-[10px] text-white leading-tight text-center">
            <span>Hidden from this list</span>
            <span className="opacity-70">· cleared on reload</span>
          </div>
        </div>
      )}

      <div
        className="group relative"
        style={
          isDismissible
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
          href={`/app/initiatives/${id}`}
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-1 py-2.5 rounded-lg hover:bg-card-hover transition-colors"
        >
          {/* Verdict + title — spans both columns below `sm` so the title gets
              the whole width instead of the remainder after the right rail. */}
          <span className="col-span-2 sm:col-span-1 sm:col-start-1 sm:row-start-1 flex items-start gap-2 min-w-0">
            <span
              className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 border leading-4 ${chip.className}`}
            >
              {chip.label}
            </span>
            {/* Confidence is a qualifier, never part of the verdict (§6.5). */}
            {confidence === 'unverified' && (
              <span
                className="shrink-0 text-[10px] text-text-muted leading-5"
                title="No goal criteria or KPI has checked this outcome"
              >
                unverified
              </span>
            )}
            {/* Two lines on mobile beats one truncated line: a wrapped title is
                still a title. From `sm` up the row is wide enough to clip. */}
            <span className="min-w-0 text-[13px] font-medium text-text-primary leading-5 line-clamp-2 sm:truncate">
              {title}
            </span>
          </span>

          {/* Evidence line */}
          <span className="col-start-1 row-start-2 min-w-0 self-end">
            {subline && (
              <span className="block text-[11px] text-text-muted leading-4">
                {subline}
              </span>
            )}

            <span className="block text-[11px] text-text-muted tabular-nums leading-4">
              {completedMissions}/{totalMissions} missions · {completedTasks}/{totalTasks} tasks
            </span>
          </span>

          {/* Sparkline + scope meter — beside the title from `sm` up, on the
              evidence line below it. */}
          <span className="col-start-2 row-start-2 sm:row-start-1 sm:row-span-2 flex items-end sm:items-center justify-end gap-2 self-end sm:self-center">
            <SparklineBar days={effortDays} width={SPARKLINE_WIDTH} height={SPARKLINE_HEIGHT} />
            <span className="text-[11px] text-text-muted tabular-nums w-8 text-right">
              {progress}%
            </span>
          </span>
        </Link>

        {/* Hover-reveal dismiss (desktop) */}
        {isDismissible && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onDismiss?.(id);
            }}
            className="hidden sm:flex absolute right-0 inset-y-0 items-center px-2 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-secondary"
            aria-label="Hide dormant initiative"
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
