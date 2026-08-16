'use client';

import Link from 'next/link';
import type { MissionSegment } from '@buildd/core/mission-helpers';
import { selectInFlightTasks, type InFlightTask } from '@/lib/mission-helpers';
import { SegmentStrip } from './SegmentStrip';

// ─── Stage counts ─────────────────────────────────────────────────────────────

export interface StageCounts {
  BLOCKED: number;
  QUEUED: number;
  RUNNING: number;
  REVIEW: number;
  DONE: number;
  FAILED: number;
}

// ─── Stage histogram segment colors ──────────────────────────────────────────

const STAGE_COLOR: Record<keyof Omit<StageCounts, 'FAILED'>, string> = {
  BLOCKED: 'var(--status-warning)',
  QUEUED:  'var(--border-default)',
  RUNNING: 'var(--status-running)',
  REVIEW:  'var(--status-info)',
  DONE:    'var(--status-success)',
};

// Mobile 4-bucket mapping
const MOBILE_BUCKETS: { label: string; keys: Array<keyof Omit<StageCounts, 'FAILED'>> }[] = [
  { label: 'blocked',    keys: ['BLOCKED'] },
  { label: 'not started', keys: ['QUEUED'] },
  { label: 'in flight',  keys: ['RUNNING', 'REVIEW'] },
  { label: 'done',       keys: ['DONE'] },
];

// ─── Stage histogram bar ──────────────────────────────────────────────────────

function StageHistogramBar({ counts, className = '' }: { counts: StageCounts; className?: string }) {
  const total = counts.BLOCKED + counts.QUEUED + counts.RUNNING + counts.REVIEW + counts.DONE;
  if (total === 0) return null;

  const allSegments: Array<{ key: keyof Omit<StageCounts, 'FAILED'>; count: number }> = [
    { key: 'BLOCKED', count: counts.BLOCKED },
    { key: 'QUEUED',  count: counts.QUEUED },
    { key: 'RUNNING', count: counts.RUNNING },
    { key: 'REVIEW',  count: counts.REVIEW },
    { key: 'DONE',    count: counts.DONE },
  ];
  const segments = allSegments.filter(s => s.count > 0);

  return (
    <div className={`flex h-1.5 rounded-sm overflow-hidden gap-px w-full ${className}`} aria-hidden="true">
      {segments.map(({ key, count }) => (
        <div
          key={key}
          style={{ flex: count, backgroundColor: STAGE_COLOR[key] }}
        />
      ))}
    </div>
  );
}

function MobileHistogramBar({ counts }: { counts: StageCounts }) {
  const bucketed = MOBILE_BUCKETS.map(b => ({
    label: b.label,
    count: b.keys.reduce((sum, k) => sum + counts[k], 0),
    color: STAGE_COLOR[b.keys[0]],
  })).filter(b => b.count > 0);

  const total = bucketed.reduce((s, b) => s + b.count, 0);
  if (total === 0) return null;

  return (
    <div className="flex h-1.5 rounded-sm overflow-hidden gap-px w-full" aria-hidden="true">
      {bucketed.map(({ label, count, color }) => (
        <div
          key={label}
          style={{ flex: count, backgroundColor: color }}
        />
      ))}
    </div>
  );
}

// ─── Verified tag ─────────────────────────────────────────────────────────────

function VerifiedTag({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <span className="font-mono text-[10px] text-status-success shrink-0">
        ✓ VERIFIED
      </span>
    );
  }
  return (
    <span className="font-mono text-[10px] text-status-warning shrink-0">
      ⚠ UNVERIFIED
    </span>
  );
}

// ─── Inline density — Activity GroupSection header ────────────────────────────

function InlineBar({ counts, failedCount, verified }: { counts: StageCounts; failedCount: number; verified?: boolean | null }) {
  const total = counts.BLOCKED + counts.QUEUED + counts.RUNNING + counts.REVIEW + counts.DONE;
  const doneLabel = `${counts.DONE}/${total + failedCount}`;

  return (
    <div className="flex flex-col gap-1 min-w-0 flex-1">
      {/* Desktop: full 5-bucket bar */}
      <div className="hidden sm:block">
        <StageHistogramBar counts={counts} />
      </div>
      {/* Mobile (≤480px): 4-bucket bar */}
      <div className="sm:hidden">
        <MobileHistogramBar counts={counts} />
      </div>
      {/* Labels row */}
      <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted">
        <span>{doneLabel} done</span>
        {failedCount > 0 && (
          <span className="text-status-error">⚠ {failedCount} failed</span>
        )}
        {verified != null && (
          <span className="ml-auto">
            <VerifiedTag verified={verified} />
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Full density — mission detail page header ────────────────────────────────

function FullBar({
  missionId,
  segments,
  completedTasks,
  totalTasks,
  inFlightTasks = [],
}: {
  missionId: string;
  segments: MissionSegment[];
  completedTasks: number;
  totalTasks: number;
  inFlightTasks?: InFlightTask[];
}) {
  const { primary, overflow } = selectInFlightTasks(inFlightTasks);
  const order = { solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 };
  const projected = [...segments].sort((a, b) => order[a.state] - order[b.state]);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <SegmentStrip segments={projected} label={`${completedTasks} of ${totalTasks} tasks complete`} />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">
          {completedTasks}/{totalTasks}
        </span>
      </div>
      {primary && (
        <div className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-text-muted">
          <Link href={`/app/tasks/${primary.id}`} className="min-w-0 truncate hover:text-accent-text">
            ▸ {primary.title} — {primary.meta}
          </Link>
          {overflow > 0 && (
            <Link href={`/app/missions/${missionId}?tab=tasks`} className="shrink-0 hover:text-accent-text">
              +{overflow}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Stacked density — initiative page (mini bar, fixed 200px) ────────────────

function StackedBar({
  segments,
  completedTasks,
  totalTasks,
}: {
  segments: MissionSegment[];
  completedTasks: number;
  totalTasks: number;
}) {
  const order = { solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 };
  const projected = [...segments].sort((a, b) => order[a.state] - order[b.state]);
  return (
    <div className="flex min-w-0 items-center gap-2" style={{ width: 200 }}>
      <SegmentStrip segments={projected} label={`${completedTasks}/${totalTasks}`} />
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">
        {completedTasks}/{totalTasks}
      </span>
    </div>
  );
}

// ─── Exported component ───────────────────────────────────────────────────────

export type MissionProgressBarDensity = 'inline' | 'full' | 'stacked';

interface MissionProgressBarInlineProps {
  density: 'inline';
  counts: StageCounts;
  failedCount?: number;
  verified?: boolean | null;
}

interface MissionProgressBarFullProps {
  density: 'full';
  missionId: string;
  segments: MissionSegment[];
  completedTasks: number;
  totalTasks: number;
  inFlightTasks?: InFlightTask[];
}

interface MissionProgressBarStackedProps {
  density: 'stacked';
  segments: MissionSegment[];
  completedTasks: number;
  totalTasks: number;
}

/** Mini SegmentStrip for collapsed-section disclosure buttons (same data as full). */
interface MissionProgressBarMiniProps {
  density: 'mini';
  segments: MissionSegment[];
  maxWidth?: number;
}

export type MissionProgressBarProps =
  | MissionProgressBarInlineProps
  | MissionProgressBarFullProps
  | MissionProgressBarStackedProps
  | MissionProgressBarMiniProps;

/**
 * Single progress bar component for all activity surfaces.
 * density="inline" → stage histogram in Activity GroupSection header
 * density="full"   → completion SegmentStrip in mission detail / home / mission grid
 * density="stacked"→ compact SegmentStrip in initiative page
 * density="mini"   → ultra-compact SegmentStrip for CondensedTimeline section buttons
 */
export function MissionProgressBar(props: MissionProgressBarProps) {
  if (props.density === 'inline') {
    return (
      <InlineBar
        counts={props.counts}
        failedCount={props.failedCount ?? 0}
        verified={props.verified}
      />
    );
  }

  if (props.density === 'full') {
    return (
      <FullBar
        missionId={props.missionId}
        segments={props.segments}
        completedTasks={props.completedTasks}
        totalTasks={props.totalTasks}
        inFlightTasks={props.inFlightTasks}
      />
    );
  }

  if (props.density === 'stacked') {
    return (
      <StackedBar
        segments={props.segments}
        completedTasks={props.completedTasks}
        totalTasks={props.totalTasks}
      />
    );
  }

  // mini
  const order = { solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 };
  const projected = [...props.segments].sort((a, b) => order[a.state] - order[b.state]);
  return (
    <SegmentStrip continuous height={4} maxWidth={props.maxWidth ?? 80} segments={projected} />
  );
}
