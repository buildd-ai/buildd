/**
 * The landing lane's rules over the Store port: at most one behind-refresh in
 * flight per repo + base branch. One delivery refreshes and the others park
 * until it leaves the refresh window (APPROVED or LANDING, or REPAIRING for
 * `behind`), then the oldest parked one refreshes once onto the new base.
 *
 * A lane holds only while its lease runs, its holder has held it for less than
 * LANE_MAX_TENURE_MS and its delivery is still in the refresh window and not
 * red at its head, so a lost release costs the lease, never the lane, and a
 * holder that will not land soon does not hold the others' refreshes. The lane
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
/**
 * The most one holder keeps the lane from its grant, however often it renews: past it the
 * head yields to the next waiter (one refresh and a CI run fit well inside it). eccb6687: a
 * holder whose CI kept failing and re-running held every behind PR for over an hour.
 */
export const LANE_MAX_TENURE_MS = 40 * 60_000;
/** A parked refresh comes due again after this even if no release wakes it. */
export const LANE_PARK_BACKSTOP_MS = 10 * 60_000;
/** The outcome prefix of a parked refresh; the wake finds parked rows by it. */
export const LANE_PARKED_OUTCOME = 'parked:lane_busy';

type LaneDelivery = { state: string; stateReason: string | null; ci?: string | null; ciHeadSha?: string | null; currentHeadSha?: string | null };
type LaneAttempt = { family: string; status: string };

/** CI's last reading is red, and on the head the PR has now: it lands only after a fix. */
export function redAtHead(d: Pick<LaneDelivery, 'ci' | 'ciHeadSha' | 'currentHeadSha'>): boolean {
  return d.ci === 'red' && d.ciHeadSha != null && d.ciHeadSha === d.currentHeadSha;
}

/**
 * A CI attempt (a fix or a re-run) is queued or running. While one is, T10 rejects a red
 * reading as `fix_in_flight`, so the red never reaches the delivery: this is how the lane
 * sees a head that is being fixed.
 */
export function ciFixOpen(attempts: readonly LaneAttempt[]): boolean {
  return attempts.some((a) => a.family === 'ci' && (a.status === 'queued' || a.status === 'running'));
}

/** Will not land soon: red at its head, or a CI fix still in flight. */
function notLandableSoon(d: LaneDelivery, attempts: readonly LaneAttempt[]): boolean {
  return redAtHead(d) || ciFixOpen(attempts);
}

/**
 * The deliveries that still hold a lane they took: in the refresh window, not red at their
 * head and with no CI fix in flight. Such a head lands only after a fix, so it does not keep
 * the others waiting (eccb6687): it releases its row, and a re-run reading running later
 * finds the lane taken.
 */
export function holdsLane(d: LaneDelivery, attempts: readonly LaneAttempt[] = []): boolean {
  const inWindow = d.state === 'APPROVED' || d.state === 'LANDING' || (d.state === 'REPAIRING' && d.stateReason === 'behind');
  return inWindow && !notLandableSoon(d, attempts);
}

/**
 * Whether a behind-refresh goes through the lane at all. A delivery that will not land soon
 * refreshes beside it, neither taking nor waiting on it: its refresh moves the head off the
 * red reading, and a lane it took then would hold every other behind PR behind one that still
 * needs a fix (eccb6687: the lane passed from one red head to another, a fix still in flight).
 */
export function refreshTakesLane(d: LaneDelivery, attempts: readonly LaneAttempt[] = []): boolean {
  return !notLandableSoon(d, attempts);
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
