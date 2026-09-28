/**
 * One live copy of each object a conversation references.
 *
 * The inline card, the pinned strip and the docked pane for the same ref read
 * the same entry, so they share one fetch and one realtime subscription and
 * can't show two states. An entry loads on first use, refetches when its
 * realtime source says the object changed (trailing, at most once per
 * window), and drops its subscription when the last reader unmounts.
 *
 * Generic over the app's refs and views: the app's `ObjectSource` loads a view
 * and (optionally) watches its channels. What an event means is the app's
 * call (`classify`); by default every event refetches. A per-object `sidecar`
 * holds app state that lives beside the view (buildd: a live progress overlay
 * and the ids an event must name to count), reset or re-seeded on each view.
 *
 * No React, no fetch, no realtime client here: the app brings those.
 */
import { refKey, type ObjectRef } from '@builddai/ai-kit/chat/contract';

export interface ObjectEntry<V> {
  view: V | null;
  error: string | null;
  loading: boolean;
}

/** How objects are fetched and watched. An app uses HTTP + its realtime client; fixtures use memory. */
export interface ObjectSource<R extends ObjectRef = ObjectRef, V = unknown> {
  load(ref: R): Promise<V>;
  /**
   * Listen for this object's realtime events: call `emit(event, data)` for
   * each and return the unsubscribe. `view` is null when the watch starts
   * before the first load; the store re-opens the watch once the view is
   * known, so a source can name channels only the view carries.
   */
  watch?(ref: R, view: V | null, emit: (event: string, data: unknown) => void): () => void;
}

/**
 * What one event does to an object. `refresh` refetches (trailing, once per
 * window). `patch`: `classify` already applied it to the sidecar, which has
 * its own readers; no refetch. `ignore`: not about this object.
 */
export type ObjectEventEffect = 'refresh' | 'patch' | 'ignore';

export interface ObjectStoreOptions<R extends ObjectRef, V, X> {
  clock?: KitClock;
  /** The trailing refetch window. Default `OBJECT_REFRESH_WINDOW_MS`. */
  windowMs?: number;
  /** Per-object app state beside the view. */
  sidecar?: {
    create(ref: R): X;
    /** A new view arrived: from a load (`reason: 'load'`) or `set` (`'set'`). */
    onView?(sidecar: X, view: V, ref: R, reason: 'load' | 'set'): void;
  };
  /** What an event means. Default: every event refetches. */
  classify?(event: string, data: unknown, ctx: { ref: R; view: V | null; sidecar: X }): ObjectEventEffect;
}

export interface ObjectStore<R extends ObjectRef = ObjectRef, V = unknown, X = undefined> {
  get(ref: R): ObjectEntry<V>;
  subscribe(ref: R, listener: () => void): () => void;
  /** The object's sidecar (created on first use). */
  sidecar(ref: R): X;
  refresh(ref: R): void;
  /** Replace a view in place (an optimistic answer, a fixture step). */
  set(ref: R, view: V): void;
}

/** Time, injectable so the refetch window is testable. */
export interface KitClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: KitClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const OBJECT_REFRESH_WINDOW_MS = 3_000;

/**
 * Trailing throttle: the first call schedules one run `waitMs` later; calls
 * inside the window join it. At most one run per window under a steady stream.
 */
export function createTrailingThrottle(fn: () => void, waitMs: number, clock: KitClock = realClock): { call(): void; cancel(): void } {
  let timer: unknown = null;
  return {
    call() {
      if (timer !== null) return;
      timer = clock.setTimeout(() => { timer = null; fn(); }, waitMs);
    },
    cancel() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

const IDLE: ObjectEntry<never> = Object.freeze({ view: null, error: null, loading: true });

/** The entry before anything loaded (and the server snapshot for `useSyncExternalStore`). */
export function idleEntry<V>(): ObjectEntry<V> {
  return IDLE;
}

interface Slot<R, V, X> {
  ref: R;
  entry: ObjectEntry<V>;
  listeners: Set<() => void>;
  sidecar: X;
  inflight: boolean;
  again: boolean;
  unwatch: (() => void) | null;
  /** The watch started before the first load, so it may miss channels the view names. */
  watchedBlind: boolean;
  throttle: { call(): void; cancel(): void } | null;
}

export function createObjectStore<R extends ObjectRef, V, X = undefined>(
  source: ObjectSource<R, V>,
  opts: ObjectStoreOptions<R, V, X> = {},
): ObjectStore<R, V, X> {
  const slots = new Map<string, Slot<R, V, X>>();
  const clock = opts.clock ?? realClock;
  const windowMs = opts.windowMs ?? OBJECT_REFRESH_WINDOW_MS;

  const notify = (s: Slot<R, V, X>) => { for (const l of [...s.listeners]) l(); };

  const slotFor = (ref: R): Slot<R, V, X> => {
    const k = refKey(ref);
    let s = slots.get(k);
    if (!s) {
      s = {
        ref, entry: IDLE, listeners: new Set(), sidecar: opts.sidecar ? opts.sidecar.create(ref) : (undefined as X),
        inflight: false, again: false, unwatch: null, watchedBlind: false, throttle: null,
      };
      slots.set(k, s);
    }
    return s;
  };

  // Hoisted: load() re-opens a blind watch once the view is known.
  // eslint-disable-next-line prefer-const
  let startWatching: (s: Slot<R, V, X>) => void;

  const load = (s: Slot<R, V, X>) => {
    if (s.inflight) { s.again = true; return; }
    s.inflight = true;
    source.load(s.ref).then(
      (view) => {
        s.entry = { view, error: null, loading: false };
        opts.sidecar?.onView?.(s.sidecar, view, s.ref, 'load');
        if (s.unwatch && s.watchedBlind) {
          s.unwatch();
          s.unwatch = null;
          startWatching(s);
        }
      },
      (err: unknown) => {
        s.entry = { view: s.entry.view, error: err instanceof Error ? err.message : 'Could not load', loading: false };
      },
    ).finally(() => {
      s.inflight = false;
      notify(s);
      if (s.again) { s.again = false; load(s); }
    });
  };

  startWatching = (s: Slot<R, V, X>) => {
    if (s.unwatch || !source.watch) return;
    s.watchedBlind = s.entry.view === null;
    s.throttle?.cancel();
    s.throttle = createTrailingThrottle(() => load(s), windowMs, clock);
    s.unwatch = source.watch(s.ref, s.entry.view, (event, data) => {
      const effect = opts.classify ? opts.classify(event, data, { ref: s.ref, view: s.entry.view, sidecar: s.sidecar }) : 'refresh';
      if (effect !== 'refresh') return;
      s.throttle?.call();
    });
  };

  return {
    get(ref) {
      return slots.get(refKey(ref))?.entry ?? IDLE;
    },
    subscribe(ref, listener) {
      const s = slotFor(ref);
      s.listeners.add(listener);
      if (s.entry === IDLE && !s.inflight) load(s);
      startWatching(s);
      return () => {
        s.listeners.delete(listener);
        if (s.listeners.size === 0) {
          s.unwatch?.();
          s.unwatch = null;
          s.throttle?.cancel();
          s.throttle = null;
        }
      };
    },
    sidecar(ref) {
      return slotFor(ref).sidecar;
    },
    refresh(ref) {
      load(slotFor(ref));
    },
    set(ref, view) {
      const s = slotFor(ref);
      s.entry = { view, error: null, loading: false };
      opts.sidecar?.onView?.(s.sidecar, view, s.ref, 'set');
      notify(s);
    },
  };
}
