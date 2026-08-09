import Link from 'next/link';
import { SegmentStrip } from './SegmentStrip';
import { initiativeStatusChip, motionLabel, deriveInitiativeDisplayStatus } from '@/lib/initiative-presentation';
import type { InitiativeListItem } from '@/lib/initiative-list';

/**
 * One initiative summary card, shared by the Home rail and the initiatives list.
 * Progress renders through the same `SegmentStrip` primitive as every mission bar
 * (the crux); the status chip is strictly `progress.status` and the motion line is
 * derived from the same status, so the two can never contradict.
 *
 * The whole card is a single link — it carries no inner anchors (no in-flight task
 * link like MissionProgress), so wrapping is safe.
 */
const RECENCY_BADGE_MS = 7 * 24 * 60 * 60 * 1000;

export default function InitiativeCard({ initiative }: { initiative: InitiativeListItem }) {
  const { progress, segments } = initiative;
  const displayStatus = deriveInitiativeDisplayStatus({ status: initiative.status, rollupStatus: progress.status });
  const chip = initiativeStatusChip(displayStatus);
  const isActive = displayStatus === 'active' || displayStatus === 'blocked';
  const hasProgress = progress.progress > 0;
  const showNewBadge = Date.now() - new Date(initiative.createdAt).getTime() < RECENCY_BADGE_MS;

  return (
    <Link
      href={`/app/initiatives/${initiative.id}`}
      className="card block hover:border-border-hover transition-colors flex overflow-hidden"
    >
      {/* Left accent bar — active only, mirroring the running-mission rule. */}
      {isActive && <div className="w-1 self-stretch bg-primary shrink-0" aria-hidden />}

      <div className="flex-1 p-4 min-w-0">
        {/* Title + status chip */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <h3 className="text-sm font-medium text-text-primary leading-snug line-clamp-2 min-w-0">
            {initiative.title}
          </h3>
          <div className="flex items-center gap-1.5 shrink-0">
            {showNewBadge && (
              <span className="text-[9px] font-mono uppercase tracking-wide border border-status-success/50 text-status-success px-1.5 py-0.5">
                New
              </span>
            )}
            <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 border ${chip.className}`}>
              {chip.label}
            </span>
          </div>
        </div>

        {/* Aggregate progress — segment strip, or a flat empty track when task-less. */}
        {segments.length > 0 ? (
          <div className="flex mb-2.5">
            <SegmentStrip
              segments={segments}
              continuous
              label={`${progress.completedTasks} of ${progress.totalTasks} tasks complete across ${progress.totalMissions} missions`}
            />
          </div>
        ) : (
          <div className="h-2 border border-border-default mb-2.5" role="img" aria-label="no tasks yet" />
        )}

        {/* Footer: progress% + Linear badge · rollup counts + motion */}
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-lg font-semibold tabular-nums ${hasProgress ? 'text-accent-text' : 'text-text-muted'}`}>
              {progress.progress}%
            </span>
            {initiative.hasLinearLink && (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 border border-border-default text-text-muted">
                Linear
              </span>
            )}
          </div>
          <div className="text-right min-w-0">
            <div className="text-[11px] text-text-muted tabular-nums">
              {progress.completedMissions}/{progress.totalMissions} missions · {progress.completedTasks}/{progress.totalTasks} tasks
            </div>
            <div className="text-[11px] text-text-muted">{motionLabel(initiative)}</div>
          </div>
        </div>
      </div>
    </Link>
  );
}
