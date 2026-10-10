/**
 * The landing lane (knowledge-base: buildd/design/landing-lane.md): at most one
 * behind-refresh in flight per repo + base branch.
 *
 * When a base moves, every approved PR the disjoint-delta rule (base-delta.ts)
 * does not tolerate used to be refreshed at once: all of them re-ran CI, the
 * first to go green merged, and that merge put the rest behind again. With the
 * lane, one delivery refreshes and the others park until it leaves the refresh
 * window, then the oldest parked one refreshes once onto the new base.
 *
 * Plain Postgres, nothing else: the lane is one row per (repo, base) taken by
 * compare-and-set. A row holds only while its lease runs and its delivery is
 * still in the refresh window (APPROVED or LANDING, or REPAIRING for `behind`);
 * a row that holds nothing is taken over by the next acquire, so a lost release
 * costs the lease, never the lane. No GitHub read: the delivery's kernel state
 * is the whole answer.
 *
 * The lane never drains effects itself. A parked refresh is an ordinary
 * pending outbox row (effects.ts `parkEffectSql` hands its attempt back), and
 * waking one only makes it due; whoever drains the outbox runs it.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import type { Exec } from './kernel';

export type LandingLaneMode = 'off' | 'shadow' | 'enforce';

/** Default off: absent, null, 'off' or any unrecognised value. */
export function resolveLandingLaneMode(gitConfig: WorkspaceGitConfig | null | undefined | unknown): LandingLaneMode {
  const mode = (gitConfig as { landingLane?: unknown } | null | undefined)?.landingLane;
  return mode === 'shadow' || mode === 'enforce' ? mode : 'off';
}

/** A holder keeps the lane this long past its last refresh (several CI runs); a renewal restarts it. */
export const LANE_HOLD_MS = 20 * 60_000;
/** A parked refresh comes due again after this even if no release wakes it. */
export const LANE_PARK_BACKSTOP_MS = 10 * 60_000;
/** The outcome prefix of a parked refresh; the wake finds parked rows by it. */
export const LANE_PARKED_OUTCOME = 'parked:lane_busy';

/** The lane row `l` still holds: lease running and its delivery in the refresh window. */
function holdingSql(): SQL {
  return sql`(l.lease_until > now() AND EXISTS (
    SELECT 1 FROM workflow_deliveries hd
    WHERE hd.id = l.delivery_id
      AND (hd.state IN ('APPROVED', 'LANDING') OR (hd.state = 'REPAIRING' AND hd.state_reason = 'behind'))
  ))`;
}

export interface LaneKey { repoFullName: string; baseRef: string }

/**
 * Take the lane, or renew it for the delivery that holds it. Returns the row
 * only when this delivery holds the lane afterwards.
 */
export function acquireLaneSql(k: LaneKey & { deliveryId: string; headSha: string; holdMs?: number }): SQL {
  const hold = k.holdMs ?? LANE_HOLD_MS;
  return sql`-- workflow:acquire_landing_lane
INSERT INTO landing_lanes AS l (repo_full_name, base_ref, delivery_id, head_sha, granted_at, lease_until, updated_at)
VALUES (${k.repoFullName}::text, ${k.baseRef}::text, ${k.deliveryId}::uuid, ${k.headSha}::text, now(),
  now() + make_interval(secs => ${hold}::int / 1000.0), now())
ON CONFLICT (repo_full_name, base_ref) DO UPDATE
SET delivery_id = EXCLUDED.delivery_id, head_sha = EXCLUDED.head_sha,
    granted_at = CASE WHEN l.delivery_id = EXCLUDED.delivery_id THEN l.granted_at ELSE now() END,
    lease_until = EXCLUDED.lease_until, updated_at = now()
WHERE l.delivery_id = EXCLUDED.delivery_id OR NOT ${holdingSql()}
RETURNING l.delivery_id`;
}

/** Who holds the lane now (nothing back when the row is absent or holds nothing). */
export function laneHolderSql(k: LaneKey): SQL {
  return sql`-- workflow:landing_lane_holder
SELECT l.delivery_id, d.pr_number FROM landing_lanes l JOIN workflow_deliveries d ON d.id = l.delivery_id
WHERE l.repo_full_name = ${k.repoFullName}::text AND l.base_ref = ${k.baseRef}::text AND ${holdingSql()}`;
}

/** Drop the lanes this delivery holds nothing in any more (it merged, closed, escalated, was pushed to...). */
export function releaseSettledLanesSql(deliveryId: string): SQL {
  return sql`-- workflow:release_landing_lanes
DELETE FROM landing_lanes l WHERE l.delivery_id = ${deliveryId}::uuid AND NOT ${holdingSql()}
RETURNING l.repo_full_name, l.base_ref`;
}

/** Make the oldest parked refresh on this lane due now. Returns its delivery. */
export function wakeNextWaiterSql(k: LaneKey): SQL {
  return sql`-- workflow:wake_landing_lane
UPDATE workflow_effects SET not_before = now(), updated_at = now()
WHERE id = (
  SELECT e.id FROM workflow_effects e JOIN workflow_deliveries d ON d.id = e.delivery_id
  WHERE e.kind = 'refresh_branch' AND e.status = 'pending' AND e.outcome LIKE ${LANE_PARKED_OUTCOME + '%'}::text
    AND d.repo_full_name = ${k.repoFullName}::text AND d.base_ref = ${k.baseRef}::text
  ORDER BY e.created_at, e.id
  LIMIT 1
)
RETURNING delivery_id`;
}

export type LaneAcquisition =
  | { acquired: true }
  | { acquired: false; holder: { deliveryId: string; prNumber: number | null } | null };

export async function acquireLane(exec: Exec, k: LaneKey & { deliveryId: string; headSha: string }): Promise<LaneAcquisition> {
  const got = (await exec(acquireLaneSql(k))).rows ?? [];
  if (got.length) return { acquired: true };
  const h = ((await exec(laneHolderSql(k))).rows ?? [])[0] as { delivery_id?: string; pr_number?: number | null } | undefined;
  // Nothing holds it but the CAS lost: another acquire took it between the two reads.
  return { acquired: false, holder: h?.delivery_id ? { deliveryId: String(h.delivery_id), prNumber: h.pr_number ?? null } : null };
}

/**
 * After a delivery's transitions: release the lanes it no longer holds and
 * make each lane's next parked refresh due. Returns the woken deliveries.
 */
export async function settleLanes(exec: Exec, deliveryId: string): Promise<string[]> {
  const released = ((await exec(releaseSettledLanesSql(deliveryId))).rows ?? []) as Array<{ repo_full_name: string; base_ref: string }>;
  const woken: string[] = [];
  for (const r of released) {
    const w = ((await exec(wakeNextWaiterSql({ repoFullName: r.repo_full_name, baseRef: r.base_ref }))).rows ?? [])[0] as { delivery_id?: string } | undefined;
    if (w?.delivery_id) woken.push(String(w.delivery_id));
  }
  return woken;
}

/** A parked or would-wait outcome naming the holder. */
export function laneOutcome(prefix: string, holder: { prNumber: number | null } | null): string {
  return `${prefix}:${holder?.prNumber != null ? `#${holder.prNumber}` : 'unknown'}`;
}
