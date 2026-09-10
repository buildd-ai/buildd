// Mission production status — "is this mission's work in production", derived,
// never stored (docs/design/mission-delivery-arc.md, "The missing dimension:
// ship state").
//
// This is a NARROWER question than `mission-ship-state.ts`'s `MissionShipState`,
// which aggregates every task under a mission — any task attributed to a
// healthy release anywhere counts — to drive the Delivery block's five-state
// UI. This module answers only the thing the design doc actually defines
// shipping as: **the merge commit of the mission's own PR is contained in a
// release that reached `healthy`.** Under Option A' that PR is single and
// unambiguous (`findMissionPrOwner`, `@/lib/mission-pr`); a mission with no
// such PR — every mission that predates the branch strategy, or one that never
// opted in — has no single sha to check at all. Its honest answer is
// `unavailable`, never `not_yet_in_production`: the design doc is explicit that
// a pre-strategy mission must not render as a regression on historical work.
//
// Two accessors answering two different questions, not one classifier
// duplicated — `mission-ship-state.ts` carries the symmetric warning back to
// this module.
//
// Wrapped in `DerivedMetric<T>` (packages/core/derived-metric.ts) so "we
// cannot tell" is a first-class result rather than a false negative
// (docs/design/derived-metric-availability.md): a caller that only checks the
// happy path would otherwise read `unavailable` and `not_yet_in_production` as
// the same "no" — which is exactly the bug this pattern exists to prevent.
import { db } from '@buildd/core/db';
import { releases, releaseTasks } from '@buildd/core/db/schema';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { derivedUnavailable, derivedValue, type DerivedMetric } from '@buildd/core/derived-metric';
import { findMissionPrOwner, type MissionPrState } from '@/lib/mission-pr';
import { RELEASE_INVARIANT_CUTOFF } from '@/lib/mission-invariants';

export type MissionProductionStatus = 'in_production' | 'not_yet_in_production';

export interface MissionProductionEvidence {
  /** State of the mission's own integration PR, from `findMissionPrOwner`. */
  prState: MissionPrState;
  /**
   * Whether the mission-PR task is attributed (via `release_tasks`) to a
   * release that reached `healthy`, dispatched on/after
   * `RELEASE_INVARIANT_CUTOFF`. Only meaningful when `prState === 'merged'` —
   * a PR that has not merged has no commit to look up, so the loader never
   * queries for it.
   */
  containedInHealthyRelease: boolean;
}

/**
 * Pure classifier. `evidence === null` means the mission never opened a
 * single-owner integration PR — no single sha exists to check containment
 * against, so the honest answer is `unavailable`, not a value.
 */
export function classifyMissionProductionStatus(
  evidence: MissionProductionEvidence | null,
): DerivedMetric<MissionProductionStatus> {
  if (!evidence) {
    return derivedUnavailable(
      'no_baseline',
      'mission has no single integration-PR merge commit to check — it predates the branch strategy or never opted in',
    );
  }
  if (evidence.prState !== 'merged') return derivedValue('not_yet_in_production');
  return evidence.containedInHealthyRelease
    ? derivedValue('in_production')
    : derivedValue('not_yet_in_production');
}

/**
 * One derived accessor, no new columns. Short-circuits before issuing a
 * release query whenever the answer is already decided without one — an unmerged
 * or absent mission PR has no merge commit to look up.
 */
export async function loadMissionProductionStatus(
  missionId: string,
): Promise<DerivedMetric<MissionProductionStatus>> {
  const owner = await findMissionPrOwner(missionId);
  if (!owner) return classifyMissionProductionStatus(null);

  if (owner.state !== 'merged') {
    return classifyMissionProductionStatus({ prState: owner.state, containedInHealthyRelease: false });
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(releaseTasks)
    .innerJoin(releases, eq(releases.id, releaseTasks.releaseId))
    .where(
      and(
        eq(releaseTasks.taskId, owner.taskId),
        eq(releases.state, 'healthy'),
        // A release row with no head sha predates the repair that made
        // "healthy implies a head sha" true and must never be evidence either
        // way — see RELEASE_INVARIANT_CUTOFF's own comment for why the
        // exclusion is a dispatched-before cutoff, not a null check alone.
        isNotNull(releases.headSha),
        isNotNull(releases.dispatchedAt),
        gte(releases.dispatchedAt, RELEASE_INVARIANT_CUTOFF),
      ),
    );

  return classifyMissionProductionStatus({
    prState: 'merged',
    containedInHealthyRelease: Number(row?.count ?? 0) > 0,
  });
}
