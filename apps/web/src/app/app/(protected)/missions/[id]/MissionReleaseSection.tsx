import Link from 'next/link';
import type { ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { daysAgo, CONTINUOUS_STATE_BADGE } from '@/components/MissionReleaseFooter';
import type { ReleaseStrategy } from '@buildd/core/db/schema';
import ReleaseNowButton from './ReleaseNowButton';

export interface ReleaseNowState {
  disabled: boolean;
  tooltip?: string;
  branchMergeBlocked: boolean;
}

/**
 * branch_merge auto-releases on task completion, so the manual trigger is
 * always blocked for it (mirrors ReleaseSection.tsx's isBranchMergeManualBlocked).
 * Vercel-token gating only applies to branch_merge, matching ReleaseSection's
 * needsVercel condition — mirrored here so mission detail and workspace config
 * cannot disagree about when the button is actionable.
 */
export function deriveReleaseNowState(input: {
  strategy: ReleaseStrategy | null;
  hasVercelToken: boolean | null;
}): ReleaseNowState {
  const branchMergeBlocked = input.strategy === 'branch_merge';
  const needsVercel = input.strategy === 'branch_merge';
  const vercelMissing = needsVercel && input.hasVercelToken === false;

  let tooltip: string | undefined;
  if (vercelMissing) tooltip = 'Add Vercel token in Connections to release';
  else if (branchMergeBlocked) tooltip = 'branch_merge releases automatically on task completion';

  return { disabled: branchMergeBlocked || vercelMissing, tooltip, branchMergeBlocked };
}

export function MissionReleaseSection({
  data,
  workspaceId,
  releaseNowState,
}: {
  data: ReleaseFooterData;
  workspaceId: string;
  releaseNowState: ReleaseNowState;
}) {
  if (!data) return null;

  if (data.archetype === 'gated') {
    // Unavailable (no baseline resolvable at all) or genuinely nothing to ship
    // both render nothing — neither implies a pipeline the workspace doesn't have.
    if (data.queueDepth.kind === 'unavailable' || data.queueDepth.value === 0) return null;
    const ageText =
      data.oldestMergedAt.kind === 'value' ? ` · oldest ${daysAgo(data.oldestMergedAt.value)}d ago` : '';
    const noReleaseYet = data.baselineSource !== 'healthy';
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] text-text-secondary">Release</span>
          {data.releaseId && (
            <Link
              href={`/app/releases/${data.releaseId}`}
              className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors"
            >
              Release →
            </Link>
          )}
        </div>
        <div className="text-[13px] text-text-secondary mb-3">
          {noReleaseYet && <span className="text-text-muted/70">no releases yet · </span>}
          {data.queueDepth.value} unshipped{ageText}
        </div>
        <ReleaseNowButton
          workspaceId={workspaceId}
          disabled={releaseNowState.disabled}
          tooltip={releaseNowState.tooltip}
          hint={releaseNowState.branchMergeBlocked ? releaseNowState.tooltip : undefined}
        />
      </div>
    );
  }

  if (data.archetype === 'continuous') {
    if (!data.state) return null;
    const badge = CONTINUOUS_STATE_BADGE[data.state] ?? { label: data.state, cls: 'text-text-muted border-border-default' };
    const refDate = data.healthyAt ?? data.deployedAt;
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] text-text-secondary">Release</span>
          {data.releaseId && (
            <Link
              href={`/app/releases/${data.releaseId}`}
              className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors"
            >
              Release →
            </Link>
          )}
        </div>
        <div className="flex items-center gap-1.5 mb-3">
          <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border ${badge.cls}`}>
            {badge.label}
          </span>
          {refDate && (
            <span className="text-[11px] font-mono text-text-muted">
              {daysAgo(refDate)}d ago
            </span>
          )}
        </div>
        <ReleaseNowButton
          workspaceId={workspaceId}
          disabled={releaseNowState.disabled}
          tooltip={releaseNowState.tooltip}
          hint={releaseNowState.branchMergeBlocked ? releaseNowState.tooltip : undefined}
        />
      </div>
    );
  }

  return null;
}
