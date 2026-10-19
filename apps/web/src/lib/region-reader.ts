/**
 * One live region's read (spec 3ef37387 R-16): fetch the region's data or
 * markup, hand it to `apply`, and fall back to a full page refresh only when
 * the read cannot answer.
 *
 * The caller asks through `requestPageRefresh` (lib/page-refresh.ts) with
 * `reader.refresher`, so the 5 s per tab cap holds for regions too. Kept free
 * of React so the policy is testable.
 *
 * - One read in flight at a time; an ask while it runs is dropped (the gate
 *   will ask again, and the read in flight is already newer than the ask).
 * - `supersede()`: a render the page took another way (a pull, a resume)
 *   already carries newer state, so a read still in flight is discarded.
 * - A failed or empty read (signed out, a stale action after a deploy) falls
 *   back to `fallback`, the old full refresh.
 */
import type { Refresher } from './page-refresh';

export interface RegionReader<T> {
  refresher: Refresher;
  /** Discard a read in flight: newer state arrived another way. */
  supersede(): void;
  dispose(): void;
}

export function createRegionReader<T>(deps: {
  load: () => Promise<T | null | undefined>;
  apply: (value: T) => void;
  fallback: () => void;
}): RegionReader<T> {
  let generation = 0;
  let inFlight = false;
  let disposed = false;

  async function read() {
    if (inFlight || disposed) return;
    inFlight = true;
    const mine = generation;
    try {
      const value = await deps.load();
      if (disposed || mine !== generation) return;
      if (value === null || value === undefined) deps.fallback();
      else deps.apply(value);
    } catch (err) {
      console.error('[region-reader] read failed, refreshing the page', err);
      if (!disposed && mine === generation) deps.fallback();
    } finally {
      inFlight = false;
    }
  }

  return {
    refresher: { refresh: () => { void read(); } },
    supersede() { generation += 1; },
    dispose() { disposed = true; },
  };
}
