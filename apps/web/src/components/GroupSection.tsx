'use client';

import Link from 'next/link';
import { MissionProgressBar, type StageCounts } from './MissionProgressBar';

export interface GroupSectionProps {
  /** Group label (mission title or time band label). */
  title: string;
  /** If set, the title links to this mission and the histogram is shown. */
  missionId?: string | null;
  /** Stage counts for the histogram. Only shown when missionId is set. */
  stageCounts?: StageCounts | null;
  failedCount?: number;
  verified?: boolean | null;
  taskCount: number;
}

/**
 * Sticky full-width group section header.
 *
 * Replaces the collapsible `<button>` mission group pattern in TaskGrid.
 * Always expanded — the header is an identity anchor, not a toggle.
 *
 * Mission groups: title links to /app/missions/{id}, histogram shown.
 * Time-band groups: title is a non-interactive label, no histogram.
 */
export function GroupSection({ title, missionId, stageCounts, failedCount = 0, verified, taskCount }: GroupSectionProps) {
  const hasMission = !!missionId;

  return (
    <div className="sticky top-0 z-10 w-full bg-surface-1 border-b border-border-default px-4 py-2">
      <div className="flex items-center gap-3 min-w-0">
        {/* Mission icon */}
        {hasMission && (
          <svg className="w-3 h-3 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="3" />
            <circle cx="12" cy="12" r="9" strokeDasharray="2 4" />
          </svg>
        )}

        {/* Title */}
        <div className="flex-1 min-w-0">
          {hasMission ? (
            <Link
              href={`/app/missions/${missionId}`}
              className="text-[13px] font-semibold text-text-primary hover:text-accent-text transition-colors line-clamp-2 leading-snug"
            >
              {title}
            </Link>
          ) : (
            <span className="text-[13px] font-semibold text-text-secondary leading-snug">
              {title}
            </span>
          )}
        </div>

        {/* Task count */}
        <span className="text-[11px] text-text-desc shrink-0">
          {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
        </span>
      </div>

      {/* Stage histogram — missions only */}
      {hasMission && stageCounts && (
        <div className="mt-1.5 flex items-center gap-2 min-w-0">
          <MissionProgressBar
            density="inline"
            counts={stageCounts}
            failedCount={failedCount}
            verified={verified}
          />
        </div>
      )}
    </div>
  );
}
