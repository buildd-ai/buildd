/**
 * The mission's Delivery "Shipped" row: one line saying whether THIS mission's
 * work is released, and a link to the release. The release status
 * (`missionReleaseStatus`, spec f7f67f1a P-3) adds the states the Shipped step
 * cannot say: dispatched, deploying and failed show here even when the step is
 * hidden, and only a healthy deploy reads Released.
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
import { DELIVERY_STATE_GLYPH, DELIVERY_STATE_TEXT, DELIVERY_STEP_LABEL, type DeliveryStep, type DeliveryStepState, type MissionReleaseStatus } from '@/lib/mission-delivery';


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

/** One release row: the glyph state, the words, and the step detail for the title. */
export interface MissionReleaseRow {
  state: DeliveryStepState;
  text: string;
  detail: string;
  /** Link to the release that carries the work, when one is known. */
  linksRelease: boolean;
}

const STATUS_ROW: Partial<Record<MissionReleaseStatus, Omit<MissionReleaseRow, 'linksRelease'>>> = {
  dispatched: { state: 'partial', text: 'Release dispatched', detail: 'A release was sent and has not deployed.' },
  deploying: { state: 'partial', text: 'Deploying', detail: 'Released once production reports healthy.' },
  failed: { state: 'blocked', text: 'Deploy failed', detail: 'Not delivered until a deploy is healthy.' },
  unknown: { state: 'partial', text: 'Health not reported', detail: 'Merged, but nothing reports whether the deploy is healthy.' },
};

/**
 * The row to show, or null for none. The release status decides when it says
 * more than the Shipped step; a waiting or healthy release keeps the step's
 * own words (Waiting for next release, Partly released, Released). Without a
 * status the row is the Shipped step alone.
 */
export function missionReleaseRow(
  step: DeliveryStep | null | undefined,
  status: MissionReleaseStatus | undefined,
): MissionReleaseRow | null {
  if (status === 'not_configured') return null;
  const fromStatus = status ? STATUS_ROW[status] : undefined;
  if (fromStatus) return { ...fromStatus, linksRelease: true };
  if (!step) return null;
  return { state: step.state, text: missionShippedStatus(step), detail: step.detail, linksRelease: step.detail !== AFTER_NEXT_RELEASE };
}

export function MissionReleaseSection({
  step,
  status,
  releaseId,
  workspaceId,
}: {
  step: DeliveryStep | null | undefined;
  /** This mission's release status (`missionReleaseStatus`). Absent: the Shipped step alone. */
  status?: MissionReleaseStatus;
  /** The release that carries this mission's work (`loadMissionCarryingReleaseId`). */
  releaseId: string | null;
  workspaceId: string;
}) {
  const row = missionReleaseRow(step, status);
  if (!row) return null;
  const href = releaseId && row.linksRelease ? `/app/releases/${releaseId}` : `/app/releases?workspace=${encodeURIComponent(workspaceId)}`;
  return (
    <Link
      href={href}
      data-testid="mission-shipped-status"
      data-state={row.state}
      className="flex min-h-11 items-center gap-2 font-mono text-[12px] hover:bg-surface-2"
    >
      <span aria-hidden="true" className={`w-3 shrink-0 text-center ${DELIVERY_STATE_TEXT[row.state]}`}>
        {DELIVERY_STATE_GLYPH[row.state]}
      </span>
      <span className="w-20 shrink-0 font-semibold text-text-primary">{step?.label ?? DELIVERY_STEP_LABEL.shipped}</span>
      <span className="min-w-0 flex-1 text-text-secondary" title={row.detail}>{row.text}</span>
      <span className="shrink-0 text-text-muted">
        <span className="hidden sm:inline">Release </span>
        <span aria-hidden="true">›</span>
      </span>
    </Link>
  );
}
