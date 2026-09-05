import Link from 'next/link';
import type { ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { daysAgo, CONTINUOUS_STATE_BADGE } from '@/components/MissionReleaseFooter';
import type { ReleaseStrategy } from '@buildd/core/db/schema';
import type { ReleaseArchetype } from '@buildd/core/release-archetype';
import { classifyReleaseState, isReleaseVisible } from '@/lib/release-state';
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

/**
 * Mission detail's release section (§8.5). Gated shows queue depth, the oldest
 * merge's age, and a link to the release; continuous shows the last deploy
 * state and healthy-since.
 *
 * The decision to render at all is delegated to `classifyReleaseState`
 * (lib/release-state.ts) — the same three-state helper every other release
 * surface classifies through, so this section and the mission-card footer
 * cannot disagree about `none` / `unseeded` / `clean` (§9, AC-45). `none` and
 * `clean` both render nothing; neither branch can produce a count.
 */
export function MissionReleaseSection({
  archetype,
  data,
  workspaceId,
  releaseNowState,
}: {
  archetype: ReleaseArchetype;
  data: ReleaseFooterData;
  workspaceId: string;
  releaseNowState: ReleaseNowState;
}) {
  const release = classifyReleaseState({ archetype, data });
  if (!isReleaseVisible(release)) return null;

  // Trigger action slot (§10.1). Owned by the action-relocation work — this
  // section only hosts it.
  const trigger = (
    <ReleaseNowButton
      workspaceId={workspaceId}
      disabled={releaseNowState.disabled}
      tooltip={releaseNowState.tooltip}
      hint={releaseNowState.branchMergeBlocked ? releaseNowState.tooltip : undefined}
    />
  );

  const header = (
    <div className="flex items-center justify-between mb-2">
      <span className="text-[13px] text-text-secondary">Release</span>
      {release.releaseId && (
        <Link
          href={`/app/releases/${release.releaseId}`}
          className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors"
        >
          Release →
        </Link>
      )}
    </div>
  );

  if (release.archetype === 'gated') {
    const ageText = release.oldestMergedAt ? ` · oldest ${daysAgo(release.oldestMergedAt)}d ago` : '';
    return (
      <div className="card p-4 mb-4">
        {header}
        <div className="text-[13px] text-text-secondary mb-3">
          {!release.seeded && <span className="text-text-muted/70">no releases yet · </span>}
          {release.queueDepth} unshipped{ageText}
        </div>
        {trigger}
      </div>
    );
  }

  const badge =
    CONTINUOUS_STATE_BADGE[release.deployState] ?? {
      label: release.deployState,
      cls: 'text-text-muted border-border-default',
    };
  const refDate = release.healthyAt ?? release.deployedAt;
  return (
    <div className="card p-4 mb-4">
      {header}
      <div className="flex items-center gap-1.5 mb-3">
        <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border ${badge.cls}`}>
          {badge.label}
        </span>
        {refDate && <span className="text-[11px] font-mono text-text-muted">{daysAgo(refDate)}d ago</span>}
      </div>
      {trigger}
    </div>
  );
}
