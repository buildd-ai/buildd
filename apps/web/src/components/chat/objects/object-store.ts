/**
 * One live copy of each object the conversation references.
 *
 * The mechanism is the kit's `createObjectStore` (@builddai/ai-kit/chat/react):
 * the inline card, the pinned strip and the docked pane for the same ref read
 * the same entry, so they share one fetch and one Pusher subscription and
 * can't show two states; an entry loads on first use, refetches when its
 * channel says the object changed (trailing, at most once per window), and
 * drops its subscription when the last reader unmounts.
 *
 * What stays buildd's is the policy, as the kit's `classify` and `sidecar`:
 * realtime reuses the mission page's own classifier (`classifyMissionEvent`),
 * so progress ticks patch the per-object live store (the Board's notches and
 * action line) and structural events refetch; the sidecar holds that live
 * store and the ids an event must name to count.
 */
import {
  createObjectStore as createKitObjectStore,
  type KitClock,
  type ObjectEntry as KitObjectEntry,
  type ObjectEventEffect,
  type ObjectSource as KitObjectSource,
  type ObjectStore as KitObjectStore,
} from '@builddai/ai-kit/chat/react';
import {
  classifyMissionEvent,
  createMissionLiveStore,
  type MissionEventContext,
  type MissionLiveStore,
} from '@/app/app/(protected)/missions/[id]/MissionLiveStore';
import { VISUAL_REVIEW_EVENT } from '@buildd/shared';
import type { BuilddObjectRef } from '../chat-contract';
import type { ObjectView } from './object-views';

export { OBJECT_REFRESH_WINDOW_MS } from '@builddai/ai-kit/chat/react';

/**
 * Mission-channel events a chat object listens for on top of the mission
 * page's own list (MISSION_EVENTS): a visual review decision, and a new or
 * changed audit shot (upload-url and the artifact PATCH fire worker:artifact
 * on the mission channel), so the Screens line and tray stay live.
 */
export const MISSION_OBJECT_EXTRA_EVENTS = [VISUAL_REVIEW_EVENT, 'worker:artifact'] as const;

export type ObjectEntry = KitObjectEntry<ObjectView>;
/** How objects are fetched and watched. The app uses HTTP + Pusher; fixtures use memory. */
export type ObjectSource = KitObjectSource<BuilddObjectRef, ObjectView>;

/** Per object, beside its view: the live progress overlay and what its events must name. */
export interface ObjectSidecar {
  live: MissionLiveStore;
  ctx: MissionEventContext;
}

export interface ObjectStore extends KitObjectStore<BuilddObjectRef, ObjectView, ObjectSidecar> {
  /** The per-object live overlay (worker progress), for the Board's live context. */
  live(ref: BuilddObjectRef): MissionLiveStore;
}

/** The task ids an object's events are about, so unrelated workspace traffic is ignored. */
export function watchedTaskIds(view: ObjectView | null): string[] {
  if (!view) return [];
  switch (view.kind) {
    case 'mission': {
      // Board rows are deliverables only; the planning task (and any row the
      // Board folds away) still moves the pane, so watch every mission task.
      const ids = new Set([...(view.taskIds ?? []), ...Object.keys(view.board.tasks)]);
      if (view.board.planning) ids.add(view.board.planning.taskId);
      return [...ids];
    }
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

function syncCtx(s: ObjectSidecar, ref: BuilddObjectRef, v: ObjectView) {
  s.ctx.missionId = missionIdOf(ref, v);
  s.ctx.taskIds = new Set(watchedTaskIds(v));
  // Seed the status baseline from the view, as the mission page does: an
  // unseen worker's first progress only records a baseline, so without this
  // the claimed → running change after a load never refetches.
  if (v.kind === 'mission' && v.workerStatuses) {
    for (const [id, st] of Object.entries(v.workerStatuses)) s.ctx.lastStatusByWorker.set(id, st);
  }
}

/** What one realtime event does to one object (buildd's mission-event policy). */
export function classifyObjectEvent(event: string, data: unknown, s: ObjectSidecar): ObjectEventEffect {
  if (event === VISUAL_REVIEW_EVENT) {
    // A decision on this mission's screens (the decisions route fires it
    // with the mission id). The mission page's classifier predates it.
    const mid = data && typeof data === 'object' ? (data as { missionId?: unknown }).missionId : undefined;
    if (!s.ctx.missionId || (typeof mid === 'string' && mid !== s.ctx.missionId)) return 'ignore';
    return 'refresh';
  }
  const d = classifyMissionEvent(event, data, s.ctx);
  if (d.kind === 'ignore') return 'ignore';
  if (d.patch && d.taskId) s.live.patch(d.taskId, d.patch);
  return d.kind === 'patch' ? 'patch' : 'refresh';
}

export function createObjectStore(source: ObjectSource, opts: { clock?: KitClock; windowMs?: number } = {}): ObjectStore {
  const store = createKitObjectStore<BuilddObjectRef, ObjectView, ObjectSidecar>(source, {
    clock: opts.clock,
    windowMs: opts.windowMs,
    sidecar: {
      create: ref => ({ live: createMissionLiveStore(), ctx: { missionId: missionIdOf(ref, null), taskIds: new Set(), lastStatusByWorker: new Map() } }),
      // A fresh load drops the progress overlay (the view has caught up); an
      // in-place set (an optimistic answer) keeps it.
      onView: (s, view, ref, reason) => {
        if (reason === 'load') s.live.reset();
        syncCtx(s, ref, view);
      },
    },
    classify: (event, data, { sidecar }) => classifyObjectEvent(event, data, sidecar),
  });
  return { ...store, live: ref => store.sidecar(ref).live };
}
