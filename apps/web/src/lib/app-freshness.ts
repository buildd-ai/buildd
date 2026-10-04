/**
 * Correctness backstop for the dashboard: Pusher is the fast path, this is
 * what guarantees a screen converges on server truth when the fast path drops
 * events.
 *
 * A phone that backgrounds the tab freezes its JS and its socket. Pusher's
 * events for that gap are simply gone — on return the per-page "missed while
 * hidden" flags are all false, because nothing arrived to set them, and the
 * screen sat on its old snapshot indefinitely. So a return to the foreground,
 * a bfcache restore, a back/forward navigation and a Pusher reconnect each
 * *demand* a catch-up, regardless of whether any event was seen.
 *
 * Every demand goes through one coordinator so the burst a resume produces
 * (visibilitychange + focus + pageshow, then a socket reconnect seconds later)
 * collapses: at most one catch-up per CATCH_UP_WINDOW_MS, leading-edge, with a
 * single trailing catch-up when more demand arrives inside the window. A
 * pull-to-refresh is a user request and bypasses the window.
 *
 * A catch-up fans out to subscribers (the layout's AppFreshness calls
 * `router.refresh()`; the client-fetched providers refetch). Kept free of React
 * and the DOM so the policy is testable with a fake clock.
 */
import { realClock, type Clock } from './realtime-throttle';

/** At most one automatic catch-up per this window. */
export const CATCH_UP_WINDOW_MS = 10_000;
/** A hide shorter than this (app-switcher peek, notification shade) is not "away". */
export const MIN_AWAY_MS = 2_000;
/** A focus without a hide (desktop window switch) catches up only if the view is this old. */
export const FOCUS_STALE_MS = 60_000;

export type CatchUpReason =
  | 'resume'
  | 'pageshow'
  | 'focus'
  | 'history'
  | 'reconnect'
  | 'online'
  | 'missed'
  | 'pull';

export interface FreshnessCoordinator {
  /** The page became hidden / frozen. */
  onHidden(): void;
  /**
   * A foreground transition: visibilitychange→visible, page lifecycle `resume`,
   * `pageshow` (`persisted` = restored from bfcache), or window `focus`.
   */
  onForeground(kind: 'visible' | 'resume' | 'pageshow' | 'focus', opts?: { persisted?: boolean }): void;
  /**
   * Something proved the view may be stale: a Pusher reconnect, `online`, a
   * back/forward navigation served from the router cache, or an event a page
   * skipped while hidden. Bounded by the window; never dropped.
   */
  demand(reason: CatchUpReason): void;
  /** User-initiated (pull-to-refresh): catch up now, ignoring the window. */
  request(reason?: CatchUpReason): void;
  dispose(): void;
}

export function createFreshnessCoordinator(deps: {
  onCatchUp: (reason: CatchUpReason) => void;
  isHidden: () => boolean;
  clock?: Clock;
  windowMs?: number;
  minAwayMs?: number;
  focusStaleMs?: number;
}): FreshnessCoordinator {
  const clock = deps.clock ?? realClock;
  const windowMs = deps.windowMs ?? CATCH_UP_WINDOW_MS;
  const minAwayMs = deps.minAwayMs ?? MIN_AWAY_MS;
  const focusStaleMs = deps.focusStaleMs ?? FOCUS_STALE_MS;

  // The page just rendered from the server: that is a fresh snapshot.
  let lastCatchUpAt = clock.now();
  let hiddenAt: number | null = deps.isHidden() ? clock.now() : null;
  let pendingWhileHidden = false;
  let trailing: unknown = null;
  let trailingReason: CatchUpReason = 'resume';

  function clearTrailing() {
    if (trailing !== null) clock.clearTimeout(trailing);
    trailing = null;
  }

  function fire(reason: CatchUpReason) {
    clearTrailing();
    pendingWhileHidden = false;
    lastCatchUpAt = clock.now();
    deps.onCatchUp(reason);
  }

  function demand(reason: CatchUpReason) {
    if (deps.isHidden()) {
      // Nothing renders while hidden; owe one catch-up on return.
      pendingWhileHidden = true;
      return;
    }
    const now = clock.now();
    if (now - lastCatchUpAt >= windowMs) {
      fire(reason);
      return;
    }
    if (trailing !== null) return;
    trailingReason = reason;
    trailing = clock.setTimeout(() => {
      trailing = null;
      if (deps.isHidden()) {
        pendingWhileHidden = true;
        return;
      }
      fire(trailingReason);
    }, lastCatchUpAt + windowMs - now);
  }

  return {
    onHidden() {
      if (hiddenAt === null) hiddenAt = clock.now();
      // A trailing catch-up would only render into a hidden page.
      if (trailing !== null) {
        clearTrailing();
        pendingWhileHidden = true;
      }
    },
    onForeground(kind, opts) {
      if (deps.isHidden()) return;
      const now = clock.now();
      const away = hiddenAt === null ? null : now - hiddenAt;
      hiddenAt = null;

      const stale =
        opts?.persisted === true ||
        pendingWhileHidden ||
        (away !== null && away >= minAwayMs) ||
        (away === null && kind === 'focus' && now - lastCatchUpAt >= focusStaleMs);
      if (!stale) return;
      demand(opts?.persisted ? 'pageshow' : kind === 'focus' ? 'focus' : 'resume');
    },
    demand,
    request(reason = 'pull') {
      fire(reason);
    },
    dispose() {
      clearTrailing();
    },
  };
}

// ── Shared bus ──────────────────────────────────────────────────────────────
//
// One coordinator per tab (mounted by AppFreshness in the protected layout).
// Client-fetched surfaces subscribe instead of wiring their own
// visibilitychange / reconnect listeners — those were unthrottled and each
// fired on every tab flick.

type CatchUpListener = (reason: CatchUpReason) => void;
const listeners = new Set<CatchUpListener>();
let active: FreshnessCoordinator | null = null;

/** Run `listener` on every catch-up. Returns the unsubscribe. */
export function subscribeCatchUp(listener: CatchUpListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify every subscriber. Listener errors are isolated from each other. */
export function emitCatchUp(reason: CatchUpReason): void {
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch (err) {
      console.error('[freshness] catch-up listener failed', err);
    }
  }
}

/** Register the tab's coordinator; returns the unregister. */
export function setActiveCoordinator(coordinator: FreshnessCoordinator): () => void {
  active = coordinator;
  return () => {
    if (active === coordinator) active = null;
  };
}

/**
 * Ask for a bounded catch-up (e.g. a page skipped a relevant event while
 * hidden). No-op outside the protected shell, where no coordinator is mounted.
 */
export function demandCatchUp(reason: CatchUpReason = 'missed'): void {
  active?.demand(reason);
}
