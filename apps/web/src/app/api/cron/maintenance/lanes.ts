import { sweepLanes } from '@/lib/serial-lanes-store';

/**
 * Serial lane sweep (Living Spec "Overlap scheduling: serial lanes and file
 * locks", lib/serial-lanes-store.ts `sweepLanes`): every unfinished task whose
 * manifest is in a lane gets its row (claimable ones stamped, the rest placed
 * after them), holders whose PR merged or closed or whose task ended are let
 * go, and holder PR activity is recorded for the stuck-lane report the
 * failure-pattern sentinel raises. The claim route does the same for its own
 * candidates on every poll; this is the floor for the rest.
 */
export async function sweepSerialLanes(now: Date): Promise<number> {
  try {
    return (await sweepLanes(now)).joined;
  } catch (err) {
    console.warn('[serial-lanes-sweep] sweep failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
