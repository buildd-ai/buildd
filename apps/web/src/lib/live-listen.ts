/**
 * Listen for an event instead of polling (spec 3ef37387 R-21).
 *
 * A surface whose data an existing Pusher event already announces (the steer
 * canvas: worker:progress; a workspace's release section: release:updated)
 * refreshes when that event arrives, with a burst of events collapsed into one
 * read. A timer stays only as the fallback for a missed event: at most one read
 * per LIVE_FALLBACK_MS, pushed back by every event-driven read, and none while
 * the tab is hidden. A hidden tab only remembers that it is stale and reads
 * once when it is shown again.
 *
 * Kept free of React, Pusher and the DOM so the policy is testable with a fake
 * clock (live-listen.test.ts); hooks/useLiveListen.ts wires it.
 */
import { realClock, type Clock } from './realtime-throttle';

/** The fallback read for a missed event: at most once a minute (R-21). */
export const LIVE_FALLBACK_MS = 60_000;
/** A burst of events inside this window is one read. */
export const LIVE_EVENT_DEBOUNCE_MS = 500;

export interface LiveListenerOptions {
  refresh(): void;
  clock?: Clock;
  isHidden?: () => boolean;
  /** null: no fallback read at all (events only). */
  fallbackMs?: number | null;
  debounceMs?: number;
}

export interface LiveListener {
  /** Arm the fallback timer. */
  start(): void;
  /** An event said the data changed. */
  event(): void;
  /** The tab was shown again: read once if anything was missed while hidden. */
  visible(): void;
  dispose(): void;
}

export function createLiveListener(opts: LiveListenerOptions): LiveListener {
  const clock = opts.clock ?? realClock;
  const isHidden = opts.isHidden ?? (() => false);
  const fallbackMs = opts.fallbackMs === undefined ? LIVE_FALLBACK_MS : opts.fallbackMs;
  const debounceMs = opts.debounceMs ?? LIVE_EVENT_DEBOUNCE_MS;
  let fallbackTimer: unknown = null;
  let eventTimer: unknown = null;
  let stale = false;
  let disposed = false;

  const armFallback = () => {
    if (fallbackTimer !== null) clock.clearTimeout(fallbackTimer);
    fallbackTimer = disposed || fallbackMs === null ? null : clock.setTimeout(onFallback, fallbackMs);
  };

  const run = () => {
    if (disposed) return;
    if (isHidden()) { stale = true; armFallback(); return; }
    stale = false;
    try { opts.refresh(); } catch (err) { console.error('[live-listen] refresh failed', err); }
    armFallback();
  };

  function onFallback() {
    fallbackTimer = null;
    run();
  }

  return {
    start() { if (!disposed) armFallback(); },
    event() {
      if (disposed) return;
      if (isHidden()) { stale = true; return; }
      if (eventTimer !== null) return;
      eventTimer = clock.setTimeout(() => { eventTimer = null; run(); }, debounceMs);
    },
    visible() {
      if (disposed || !stale || isHidden()) return;
      run();
    },
    dispose() {
      disposed = true;
      if (fallbackTimer !== null) clock.clearTimeout(fallbackTimer);
      if (eventTimer !== null) clock.clearTimeout(eventTimer);
      fallbackTimer = eventTimer = null;
    },
  };
}
