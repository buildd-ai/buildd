/**
 * Release-queue scoping — which merges are actually waiting for a release.
 *
 * Queue depth counts `workers` rows with a `mergedAt` newer than the release
 * baseline. Under Option A′ that over-counts twice over: a mission's task PRs
 * merge into the mission's integration branch, so each of them stamps
 * `mergedAt` while nothing of that mission has reached trunk, and then the
 * mission's own integration PR merges and stamps one more. N task merges plus
 * one mission merge for one unit of releasable work — the "counts mission work
 * twice" case in docs/design/mission-delivery-arc.md P4.
 *
 * `workers.prBaseRef` is how the two are told apart, and it is the only signal
 * available here: release accounting walks `workers`, never `missions`, so this
 * is deliberately the **shape heuristic** (`looksLikeMissionIntegrationBranch`)
 * rather than the authoritative `isMissionIntegrationBase`. A workspace is free
 * to carry a `mission/…` branch that no mission owns; a merge into it is still
 * not a merge into trunk, so the heuristic answers the question that is being
 * asked here.
 *
 * **An unknown base ref counts.** `prBaseRef` is null for every row merged
 * before the column existed, and null means "we do not know", which must never
 * be read as trunk *or* as quarantined. Excluding nulls would zero out every
 * workspace's release queue; including them keeps the pre-A′ behaviour exactly
 * as it was, which is the only safe direction for a surface people ship from.
 */

import { workers } from './db/schema';
import { sql, type SQL } from 'drizzle-orm';
import {
  MISSION_BRANCH_PREFIX,
  looksLikeMissionIntegrationBranch,
} from './mission-integration';

/** LIKE pattern matching the branch shape `mission/<slug>-<id8>`. */
const MISSION_BRANCH_LIKE = `${MISSION_BRANCH_PREFIX}%`;

/**
 * Did this merge land on a mission integration branch rather than on trunk?
 *
 * The in-memory twin of `notMissionIntegrationMerge` for callers that already
 * hold the worker row. False for an unknown base ref, matching
 * `isMissionIntegrationBase`.
 */
export function isMissionIntegrationMerge(prBaseRef: string | null | undefined): boolean {
  return looksLikeMissionIntegrationBranch(prBaseRef?.trim() ?? null);
}

/**
 * WHERE fragment: this worker's merge is not *known* to have landed on a
 * mission integration branch.
 *
 * Every release-queue-depth query must carry this, or a mission using an
 * integration branch inflates the queue by one per task and then again by the
 * mission PR. One fragment, three callers (`lib/release-footer.ts`, Home's
 * readiness block, `api/releases/readiness`) so they cannot drift.
 */
export function notMissionIntegrationMerge(): SQL {
  return sql`(${workers.prBaseRef} is null or ${workers.prBaseRef} not like ${MISSION_BRANCH_LIKE})`;
}
