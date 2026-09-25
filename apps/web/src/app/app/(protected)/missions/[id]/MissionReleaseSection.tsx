/**
 * The mission's Delivery "Shipped" row: one line saying whether THIS mission's
 * work is released, and a link to the release.
 *
 * It reads the Shipped step `buildDeliverySteps` already derived from this
 * mission's own trunk merges against the workspace release baseline (D6), so
 * it never states a workspace fact. The workspace queue ("N unshipped") and the
 * Release now trigger belong to the workspace, and live where workspaces are
 * listed (Home, the missions list), not on a mission.
 *
 * No Shipped step (nothing merged, no release flow, no baseline) renders
 * nothing — the Delivery model already hides the step.
 */
import Link from 'next/link';
import { DELIVERY_STATE_GLYPH, DELIVERY_STATE_TEXT, type DeliveryStep } from '@/lib/mission-delivery';


/** The model's "waits for a later release" detail. */
const AFTER_NEXT_RELEASE = 'after next release';

/** This mission's release status, in the words the row shows. */
export function missionShippedStatus(step: DeliveryStep): string {
  if (step.state === 'done') return 'Released';
  // Some of it shipped: either some merges wait for the next release, or the
  // landed work shipped and more is still to merge.
  if (step.state === 'partial') return 'Partly released';
  return step.detail === AFTER_NEXT_RELEASE ? 'Waiting for next release' : step.detail;
}

/**
 * A released mission links to the release; one still waiting links to the
 * workspace's releases, because the release that will carry it does not exist yet.
 */
export function missionShippedHref({
  step,
  releaseId,
  workspaceId,
}: {
  step: DeliveryStep;
  releaseId: string | null;
  workspaceId: string;
}): string {
  const waiting = step.detail === AFTER_NEXT_RELEASE;
  if (releaseId && !waiting) return `/app/releases/${releaseId}`;
  return `/app/releases?workspace=${encodeURIComponent(workspaceId)}`;
}

export function MissionReleaseSection({
  step,
  releaseId,
  workspaceId,
}: {
  step: DeliveryStep | null | undefined;
  /** The release that carries this mission's work (`loadMissionCarryingReleaseId`). */
  releaseId: string | null;
  workspaceId: string;
}) {
  if (!step) return null;
  return (
    <Link
      href={missionShippedHref({ step, releaseId, workspaceId })}
      data-testid="mission-shipped-status"
      data-state={step.state}
      className="flex min-h-11 items-center gap-2 font-mono text-[12px] hover:bg-surface-2"
    >
      <span aria-hidden="true" className={`w-3 shrink-0 text-center ${DELIVERY_STATE_TEXT[step.state]}`}>
        {DELIVERY_STATE_GLYPH[step.state]}
      </span>
      <span className="w-20 shrink-0 font-semibold text-text-primary">{step.label}</span>
      <span className="min-w-0 flex-1 text-text-secondary" title={step.detail}>{missionShippedStatus(step)}</span>
      <span className="shrink-0 text-text-muted">
        <span className="hidden sm:inline">Release </span>
        <span aria-hidden="true">›</span>
      </span>
    </Link>
  );
}
