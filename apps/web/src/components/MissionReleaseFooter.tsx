import Link from 'next/link';
import type { DerivedMetric } from '@buildd/core/derived-metric';
import type { ReleaseBaselineSource } from '@buildd/core/release-baseline';

export type GatedReleaseFooter = {
  archetype: 'gated';
  /** Unavailable only when no baseline could be established at all (rung 4 also failed). */
  queueDepth: DerivedMetric<number>;
  oldestMergedAt: DerivedMetric<string>;
  /** Which rung of the baseline ladder produced queueDepth — drives the "no releases yet" badge. */
  baselineSource: ReleaseBaselineSource;
  releaseId: string | null;
};

export type ContinuousReleaseFooter = {
  archetype: 'continuous';
  state: string | null;
  deployedAt: string | null;
  healthyAt: string | null;
  releaseId: string | null;
};

export type ReleaseFooterData = GatedReleaseFooter | ContinuousReleaseFooter | null;

export function daysAgo(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

export const CONTINUOUS_STATE_BADGE: Record<string, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'text-status-success border-status-success/30' },
  deploying: { label: 'Deploying', cls: 'text-status-info border-status-info/30' },
  dispatched: { label: 'Dispatched', cls: 'text-status-info border-status-info/30' },
  failed: { label: 'Failed', cls: 'text-status-error border-status-error/30' },
  degraded: { label: 'Degraded', cls: 'text-status-warning border-status-warning/30' },
  pending_external: { label: 'Pending', cls: 'text-text-muted border-border-default' },
};

export function MissionReleaseFooter({ data }: { data: ReleaseFooterData }) {
  if (!data) return null;

  if (data.archetype === 'gated') {
    // Unavailable (no baseline resolvable at all) or genuinely nothing to ship
    // both render nothing — neither implies a pipeline the workspace doesn't have.
    if (data.queueDepth.kind === 'unavailable' || data.queueDepth.value === 0) return null;
    const ageText =
      data.oldestMergedAt.kind === 'value' ? ` · oldest ${daysAgo(data.oldestMergedAt.value)}d ago` : '';
    const noReleaseYet = data.baselineSource !== 'healthy';
    return (
      <div className="px-4 py-1.5 border-t border-border-default/50 flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-text-muted">
          {noReleaseYet && <span className="text-text-muted/70">no releases yet · </span>}
          {data.queueDepth.value} unshipped{ageText}
        </span>
        {data.releaseId && (
          <Link
            href={`/app/releases/${data.releaseId}`}
            className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            Release →
          </Link>
        )}
      </div>
    );
  }

  if (data.archetype === 'continuous') {
    if (!data.state) return null;
    const badge = CONTINUOUS_STATE_BADGE[data.state] ?? { label: data.state, cls: 'text-text-muted border-border-default' };
    const refDate = data.healthyAt ?? data.deployedAt;
    return (
      <div className="px-4 py-1.5 border-t border-border-default/50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border ${badge.cls}`}>
            {badge.label}
          </span>
          {refDate && (
            <span className="text-[11px] font-mono text-text-muted">
              {daysAgo(refDate)}d ago
            </span>
          )}
        </div>
        {data.releaseId && (
          <Link
            href={`/app/releases/${data.releaseId}`}
            className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            Release →
          </Link>
        )}
      </div>
    );
  }

  return null;
}
