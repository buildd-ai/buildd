/**
 * One live copy of each object the conversation references.
 *
 * The inline card and the docked pane for the same ref read the same entry, so
 * they share one fetch and one Pusher subscription and can't show two states.
 * An entry loads on first use, refetches when its realtime channel says the
 * object changed (trailing, at most once per window), and drops its
 * subscription when the last reader unmounts.
 *
 * Realtime reuses the mission page's own policy (`classifyMissionEvent`):
 * progress ticks patch the per-object live store (the Board's notches and
 * action line), structural events refetch.
 */
import { createThrottle, realClock, type Clock } from '@/lib/realtime-throttle';
import {
  classifyMissionEvent,
  createMissionLiveStore,
  type MissionEventContext,
  type MissionLiveStore,
} from '@/app/app/(protected)/missions/[id]/MissionLiveStore';
import { refKey, type BuilddObjectRef } from '../chat-contract';
import type { ObjectView } from './object-views';

export interface ObjectEntry {
  view: ObjectView | null;
  error: string | null;
  loading: boolean;
}

/** How objects are fetched and watched. The app uses HTTP + Pusher; fixtures use memory. */
export interface ObjectSource {
  load(ref: BuilddObjectRef): Promise<ObjectView>;
  /**
   * Listen for this object's realtime events. `emit(event, data)` for each one;
   * return the unsubscribe. Optional: a source without realtime never refetches.
   */
  watch?(ref: BuilddObjectRef, view: ObjectView | null, emit: (event: string, data: unknown) => void): () => void;
}

export interface ObjectStore {
  get(ref: BuilddObjectRef): ObjectEntry;
  subscribe(ref: BuilddObjectRef, listener: () => void): () => void;
  /** The per-object live overlay (worker progress), for the Board's live context. */
  live(ref: BuilddObjectRef): MissionLiveStore;
  refresh(ref: BuilddObjectRef): void;
  /** Replace a view in place (an optimistic answer, a fixture step). */
  set(ref: BuilddObjectRef, view: ObjectView): void;
}

const IDLE: ObjectEntry = { view: null, error: null, loading: true };
export const OBJECT_REFRESH_WINDOW_MS = 3_000;

interface Slot {
  ref: BuilddObjectRef;
  entry: ObjectEntry;
  listeners: Set<() => void>;
  live: MissionLiveStore;
  inflight: boolean;
  again: boolean;
  unwatch: (() => void) | null;
  /** The watch started before the first load, so it may be missing channels the view names. */
  watchedBlind: boolean;
  throttle: { call(): void; cancel(): void } | null;
  ctx: MissionEventContext;
}

/** The task ids an object's events are about, so unrelated workspace traffic is ignored. */
export function watchedTaskIds(view: ObjectView | null): string[] {
  if (!view) return [];
  switch (view.kind) {
    case 'mission':
      return Object.keys(view.board.tasks);
    case 'task':
      return [view.id];
    case 'question':
      return [view.taskId];
    case 'pr':
      return view.taskId ? [view.taskId] : [];
  }
}

function missionIdOf(ref: BuilddObjectRef, view: ObjectView | null): string {
  if (ref.kind === 'mission') return ref.id;
  if (view && 'missionId' in view && view.missionId) return view.missionId;
  return '';
}

export function createObjectStore(source: ObjectSource, opts: { clock?: Clock; windowMs?: number } = {}): ObjectStore {
  const slots = new Map<string, Slot>();
  const clock = opts.clock ?? realClock;

  const notify = (s: Slot) => { for (const l of s.listeners) l(); };

  const slotFor = (ref: BuilddObjectRef): Slot => {
    const k = refKey(ref);
    let s = slots.get(k);
    if (!s) {
      s = {
        ref, entry: IDLE, listeners: new Set(), live: createMissionLiveStore(),
        inflight: false, again: false, unwatch: null, watchedBlind: false, throttle: null,
        ctx: { missionId: missionIdOf(ref, null), taskIds: new Set(), lastStatusByWorker: new Map() },
      };
      slots.set(k, s);
    }
    return s;
  };

  const syncCtx = (s: Slot) => {
    const v = s.entry.view;
    s.ctx.missionId = missionIdOf(s.ref, v);
    // An unseen worker's first progress event only records a baseline status
    // (classifyMissionEvent), so no seeding is needed here.
    s.ctx.taskIds = new Set(watchedTaskIds(v));
  };

  // Hoisted: load() re-opens a blind watch once the view is known.
  // eslint-disable-next-line prefer-const
  let startWatching: (s: Slot) => void;

  const load = (s: Slot) => {
    if (s.inflight) { s.again = true; return; }
    s.inflight = true;
    source.load(s.ref).then(
      (view) => {
        s.entry = { view, error: null, loading: false };
        s.live.reset();
        syncCtx(s);
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

  startWatching = (s: Slot) => {
    if (s.unwatch || !source.watch) return;
    s.watchedBlind = s.entry.view === null;
    s.throttle?.cancel();
    s.throttle = createThrottle(() => load(s), { waitMs: opts.windowMs ?? OBJECT_REFRESH_WINDOW_MS, leading: false }, clock);
    s.unwatch = source.watch(s.ref, s.entry.view, (event, data) => {
      const d = classifyMissionEvent(event, data, s.ctx);
      if (d.kind === 'ignore') return;
      if (d.patch && d.taskId) s.live.patch(d.taskId, d.patch);
      if (d.kind === 'patch') return;
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
    live(ref) {
      return slotFor(ref).live;
    },
    refresh(ref) {
      load(slotFor(ref));
    },
    set(ref, view) {
      const s = slotFor(ref);
      s.entry = { view, error: null, loading: false };
      syncCtx(s);
      notify(s);
    },
  };
}
