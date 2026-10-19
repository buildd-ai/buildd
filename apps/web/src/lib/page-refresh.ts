/**
 * One gate for every live refresh on a page (spec 3ef37387 R-16): at most one
 * per PAGE_REFRESH_MIN_MS per tab, whichever surface asked.
 *
 * Pusher events (Home, the mission page, the task page, a release), the
 * shell's catch-up on resume or reconnect (components/AppFreshness.tsx) and a
 * region's own refetch (the mission task sheet) each used to throttle on their
 * own clock, so together they could re-render the page several times a
 * second. Now each asks here. The first request after a quiet window runs at
 * once; the rest inside the window collapse into one run at its end, which
 * calls every distinct refresher that asked. A pull-to-refresh is a person's
 * request: it runs at once and only restarts the window (`noteRefreshed`).
 *
 * Kept free of React and the DOM so the policy is testable with a fake clock.
 */
import { realClock, type Clock } from './realtime-throttle';

export const PAGE_REFRESH_MIN_MS = 5_000;

export interface Refresher {
  refresh(): void;
}

export interface PageRefreshGate {
  request(r: Refresher): void;
  /** A refresh ran outside the gate (a pull): the window starts now. */
  noteRefreshed(): void;
  dispose(): void;
}

export function createPageRefreshGate(clock: Clock = realClock, minMs = PAGE_REFRESH_MIN_MS): PageRefreshGate {
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  const pending = new Set<Refresher>();

  function fire() {
    timer = null;
    lastAt = clock.now();
    const due = [...pending];
    pending.clear();
    for (const r of due) {
      try {
        r.refresh();
      } catch (err) {
        console.error('[page-refresh] refresher failed', err);
      }
    }
  }

  return {
    request(r) {
      pending.add(r);
      if (timer !== null) return;
      const wait = lastAt + minMs - clock.now();
      if (wait <= 0) fire();
      else timer = clock.setTimeout(fire, wait);
    },
    noteRefreshed() {
      lastAt = clock.now();
    },
    dispose() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

// One per tab: a tab shows one page at a time.
let gate = createPageRefreshGate();

/** Ask for a live refresh of the page; gated to one per 5 s per tab. */
export function requestPageRefresh(r: Refresher): void {
  gate.request(r);
}

/** A refresh a person asked for ran outside the gate. */
export function notePageRefreshed(): void {
  gate.noteRefreshed();
}

/** Tests only: a fresh gate, optionally on a fake clock. */
export function resetPageRefreshGate(clock?: Clock, minMs?: number): void {
  gate.dispose();
  gate = createPageRefreshGate(clock, minMs);
}
