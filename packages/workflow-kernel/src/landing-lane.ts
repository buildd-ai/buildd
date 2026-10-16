/**
 * The landing lane's rules over the Store port: at most one behind-refresh in
 * flight per repo + base branch. One delivery refreshes and the others park
 * until it leaves the refresh window (APPROVED or LANDING, or REPAIRING for
 * `behind`), then the oldest parked one refreshes once onto the new base.
 *
 * A lane holds only while its lease runs and its delivery is still in the
 * refresh window, so a lost release costs the lease, never the lane. The lane
 * never drains effects itself: a parked refresh is an ordinary pending outbox
 * row, and waking one only makes it due.
 */
import type { LandingLaneMode, LaneKey, Store } from './ports';

export type { LandingLaneMode, LaneKey } from './ports';

/** Default off: absent, null, 'off' or any unrecognised value. */
export function resolveLandingLaneMode(config: unknown): LandingLaneMode {
  const mode = (config as { landingLane?: unknown } | null | undefined)?.landingLane;
  return mode === 'shadow' || mode === 'enforce' ? mode : 'off';
}

/** A holder keeps the lane this long past its last refresh (several CI runs); a renewal restarts it. */
export const LANE_HOLD_MS = 20 * 60_000;
/** A parked refresh comes due again after this even if no release wakes it. */
export const LANE_PARK_BACKSTOP_MS = 10 * 60_000;
/** The outcome prefix of a parked refresh; the wake finds parked rows by it. */
export const LANE_PARKED_OUTCOME = 'parked:lane_busy';

/** The delivery states in which a lane holder still holds it. */
export function holdsLane(d: { state: string; stateReason: string | null }): boolean {
  return d.state === 'APPROVED' || d.state === 'LANDING' || (d.state === 'REPAIRING' && d.stateReason === 'behind');
}

export type LaneAcquisition =
  | { acquired: true }
  | { acquired: false; holder: { deliveryId: string; prNumber: number | null } | null };

export async function acquireLaneOn(store: Store, k: LaneKey & { deliveryId: string; headSha: string; holdMs?: number }): Promise<LaneAcquisition> {
  if (await store.acquireLane({ ...k, holdMs: k.holdMs ?? LANE_HOLD_MS })) return { acquired: true };
  // Nothing holds it but the CAS lost: another acquire took it between the two reads.
  return { acquired: false, holder: await store.laneHolder(k) };
}

/**
 * After a delivery's transitions: release the lanes it no longer holds and
 * make each lane's next parked refresh due. Returns the woken deliveries.
 */
export async function settleLanesOn(store: Store, deliveryId: string): Promise<string[]> {
  const released = await store.releaseSettledLanes(deliveryId);
  const woken: string[] = [];
  for (const k of released) {
    const w = await store.wakeNextLaneWaiter(k);
    if (w) woken.push(w);
  }
  return woken;
}

/** A parked or would-wait outcome naming the holder. */
export function laneOutcome(prefix: string, holder: { prNumber: number | null } | null): string {
  return `${prefix}:${holder?.prNumber != null ? `#${holder.prNumber}` : 'unknown'}`;
}
