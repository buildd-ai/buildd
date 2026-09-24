/**
 * Realtime split for the mission page (docs/design/mission-feed-mobile-continuity.md,
 * "Realtime", slice S7, AC-17).
 *
 * The runner PATCHes every active worker about every 10s, and each PATCH
 * publishes `worker:progress`. The page used to answer each one with a full
 * `force-dynamic` render (every task, every worker, the explain accessor, a
 * possible GitHub reconcile). Now:
 *
 * - A steady-status `worker:progress` heartbeat **patches this store** — the
 *   MOVING rows' live line reads from it — and never re-renders the page.
 * - Structural events **refresh**, trailing-throttled to at most one full render
 *   per {@link MISSION_REFRESH_WINDOW_MS} per tab: `task:created`,
 *   `task:claimed`, `worker:completed`, `worker:failed`,
 *   `task:children_completed`, `mission:note_posted`,
 *   `mission:completion_decision`.
 * - Two kinds of `worker:progress` are structural too, because they change
 *   which group a row is in: a worker **status change** (running →
 *   waiting_input moves a row into NEEDS YOU), and the status-less `{taskId}`
 *   nudge the PR webhooks publish (CI failed, merged — the row's PR state).
 *   Both go through the same throttle, so the safety bound holds whatever the
 *   event rate.
 * - A hidden tab refreshes nothing; one catch-up render on return if anything
 *   structural was missed.
 *
 * Kept free of React and Pusher so the policy runs under a fake clock.
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { createThrottle, realClock, type Clock } from '@/lib/realtime-throttle';

/** At most one full mission render per this window, per open tab. */
export const MISSION_REFRESH_WINDOW_MS = 3_000;

/** Workspace-channel events that change the page's structure. */
export const WORKSPACE_STRUCTURAL_EVENTS = [
  'task:created',
  'task:claimed',
  'worker:completed',
  'worker:failed',
  'task:children_completed',
] as const;
/** Mission-channel events; the channel is already scoped to this mission. */
export const MISSION_STRUCTURAL_EVENTS = ['mission:note_posted', 'mission:completion_decision'] as const;
export const WORKSPACE_EVENTS = [...WORKSPACE_STRUCTURAL_EVENTS, 'worker:progress'] as const;

// ── Store ────────────────────────────────────────────────────────────────────

export interface LiveTaskPatch {
  workerId: string | null;
  status: string | null;
  currentAction: string | null;
  /** The worker row's `updatedAt`, as published. */
  updatedAt: string | null;
}

export type LiveSnapshot = Readonly<Record<string, LiveTaskPatch>>;

export interface MissionLiveStore {
  getSnapshot(): LiveSnapshot;
  subscribe(listener: () => void): () => void;
  /** Merge a patch for one task. Absent fields keep their previous value. */
  patch(taskId: string, patch: Partial<LiveTaskPatch>): void;
  /** Drop every patch: a fresh server render supersedes them. */
  reset(): void;
}

const EMPTY: LiveSnapshot = Object.freeze({});

export function createMissionLiveStore(): MissionLiveStore {
  let snapshot: LiveSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(l => l());
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    patch(taskId, p) {
      const prev = snapshot[taskId] ?? { workerId: null, status: null, currentAction: null, updatedAt: null };
      const next: LiveTaskPatch = {
        workerId: p.workerId !== undefined ? p.workerId : prev.workerId,
        status: p.status !== undefined ? p.status : prev.status,
        currentAction: p.currentAction !== undefined ? p.currentAction : prev.currentAction,
        updatedAt: p.updatedAt !== undefined ? p.updatedAt : prev.updatedAt,
      };
      if (
        next.workerId === prev.workerId && next.status === prev.status
        && next.currentAction === prev.currentAction && next.updatedAt === prev.updatedAt
        && taskId in snapshot
      ) return;
      snapshot = { ...snapshot, [taskId]: next };
      emit();
    },
    reset() {
      if (snapshot === EMPTY) return;
      snapshot = EMPTY;
      emit();
    },
  };
}

// ── Event policy ─────────────────────────────────────────────────────────────

interface EventPayload {
  workerId?: string | null;
  taskId?: string | null;
  parentTaskId?: string | null;
  status?: string;
  currentAction?: string | null;
  updatedAt?: string | null;
  task?: { id?: string | null; missionId?: string | null };
  worker?: { taskId?: string | null; status?: string };
}

const asPayload = (data: unknown): EventPayload => (data && typeof data === 'object' ? (data as EventPayload) : {});

export type MissionEventDecision =
  | { kind: 'ignore' }
  | { kind: 'patch'; taskId: string; patch: Partial<LiveTaskPatch> }
  | { kind: 'refresh'; taskId?: string; patch?: Partial<LiveTaskPatch> };

export interface MissionEventContext {
  missionId: string;
  taskIds: ReadonlySet<string>;
  /** workerId → last status seen. Seeded from the server render. */
  lastStatusByWorker: Map<string, string>;
}

/** What one realtime event means for the mission page. Pure apart from the status map. */
export function classifyMissionEvent(event: string, data: unknown, ctx: MissionEventContext): MissionEventDecision {
  const p = asPayload(data);
  const taskId = p.taskId ?? p.worker?.taskId ?? null;
  const ours = (id: string | null | undefined): id is string => !!id && ctx.taskIds.has(id);

  switch (event) {
    case 'task:created':
      return p.task?.missionId === ctx.missionId ? { kind: 'refresh' } : { kind: 'ignore' };
    case 'task:claimed':
      return ours(p.task?.id) ? { kind: 'refresh' } : { kind: 'ignore' };
    case 'task:children_completed':
      return ours(p.parentTaskId) ? { kind: 'refresh' } : { kind: 'ignore' };
    case 'worker:completed':
    case 'worker:failed':
      if (!ours(taskId)) return { kind: 'ignore' };
      if (p.workerId) ctx.lastStatusByWorker.delete(p.workerId);
      return { kind: 'refresh' };
    case 'mission:note_posted':
    case 'mission:completion_decision':
      return { kind: 'refresh' };
    case 'worker:progress': {
      if (!ours(taskId)) return { kind: 'ignore' };
      // Webhook nudge (CI / merge / PR refresh): no worker, no status — the
      // row's PR state changed, which the store does not carry.
      if (!p.workerId) return { kind: 'refresh', taskId };
      const status = p.status ?? p.worker?.status ?? null;
      const patch: Partial<LiveTaskPatch> = { workerId: p.workerId };
      if (status) patch.status = status;
      if (typeof p.currentAction === 'string') patch.currentAction = p.currentAction;
      if (p.updatedAt !== undefined) patch.updatedAt = p.updatedAt ? String(p.updatedAt) : null;
      if (status) {
        const prev = ctx.lastStatusByWorker.get(p.workerId);
        ctx.lastStatusByWorker.set(p.workerId, status);
        // An unseen worker only records a baseline: the claim that created it
        // is its own structural event.
        if (prev !== undefined && prev !== status) return { kind: 'refresh', taskId, patch };
      }
      return { kind: 'patch', taskId, patch };
    }
    default:
      return { kind: 'ignore' };
  }
}

export interface MissionRefresher {
  onEvent(event: string, data: unknown): void;
  /** The tab became visible: one catch-up render if a structural event was missed. */
  onVisible(): void;
  /** Replace the known task set after a render (new tasks appear). */
  setTaskIds(ids: Iterable<string>): void;
  dispose(): void;
}

export function createMissionRefresher(deps: {
  missionId: string;
  taskIds: Iterable<string>;
  /** workerId → status as rendered. */
  workerStatuses?: Readonly<Record<string, string>>;
  store: MissionLiveStore;
  /** One full server render (router.refresh, with the scroll anchor around it). */
  refresh: () => void;
  isHidden: () => boolean;
  clock?: Clock;
  windowMs?: number;
}): MissionRefresher {
  const clock = deps.clock ?? realClock;
  const ctx: MissionEventContext = {
    missionId: deps.missionId,
    taskIds: new Set(deps.taskIds),
    lastStatusByWorker: new Map(Object.entries(deps.workerStatuses ?? {})),
  };
  let missedWhileHidden = false;

  // Trailing: the first structural event opens a window and one render lands
  // at its end, however many more arrive inside it.
  const throttle = createThrottle(() => {
    if (deps.isHidden()) {
      missedWhileHidden = true;
      return;
    }
    deps.refresh();
  }, { waitMs: deps.windowMs ?? MISSION_REFRESH_WINDOW_MS, leading: false }, clock);

  return {
    onEvent(event, data) {
      const d = classifyMissionEvent(event, data, ctx);
      if (d.kind === 'ignore') return;
      if (d.patch && d.taskId) deps.store.patch(d.taskId, d.patch);
      if (d.kind === 'patch') return;
      if (deps.isHidden()) {
        missedWhileHidden = true;
        return;
      }
      throttle.call();
    },
    onVisible() {
      if (!missedWhileHidden || deps.isHidden()) return;
      missedWhileHidden = false;
      throttle.call();
    },
    setTaskIds(ids) {
      ctx.taskIds = new Set(ids);
    },
    dispose() {
      throttle.cancel();
    },
  };
}

// ── React ────────────────────────────────────────────────────────────────────

export const MissionLiveContext = createContext<MissionLiveStore | null>(null);

const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function useMissionLiveSnapshot(): LiveSnapshot {
  const store = useContext(MissionLiveContext);
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot,
    emptySnapshot,
  );
}

/**
 * The server's live lines with the store's newer current actions laid over.
 * A patch that says the worker stopped being live drops the line.
 */
export function mergeLiveLines(
  server: Readonly<Record<string, string>> | undefined,
  live: LiveSnapshot,
  liveStatuses: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const ids = Object.keys(live);
  if (ids.length === 0) return server ?? {};
  const out: Record<string, string> = { ...(server ?? {}) };
  for (const id of ids) {
    const p = live[id];
    if (p.status && !liveStatuses.has(p.status)) {
      delete out[id];
      continue;
    }
    if (p.currentAction) out[id] = p.currentAction;
  }
  return out;
}

export function useMissionLiveLines(
  server: Readonly<Record<string, string>> | undefined,
  liveStatuses: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const live = useMissionLiveSnapshot();
  return useMemo(() => mergeLiveLines(server, live, liveStatuses), [server, live, liveStatuses]);
}
