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
 *   `task:children_completed`, `worker:artifact` (a new record: the Records
 *   sheet, the row's `Records · N`, Delivery), `mission:note_posted`,
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

// The subscribed event lists live with the subscriber (MissionAutoRefresh.tsx):
// the Pusher coverage guards read event names from the files that bind them.

// ── Store ────────────────────────────────────────────────────────────────────

export interface LiveMilestone {
  label: string;
  /** Epoch ms. */
  ts: number;
}

export interface LiveTaskPatch {
  workerId: string | null;
  status: string | null;
  currentAction: string | null;
  /** The worker row's `updatedAt`, as published. */
  updatedAt: string | null;
  /**
   * One entry per distinct current action seen live, oldest first — the
   * Board's milestone notches between server renders. The worker:progress
   * payload carries no milestone list (it is capped for Pusher), so each new
   * action line is the notch. A new worker on the task starts a fresh list.
   */
  milestones: readonly LiveMilestone[];
}

/** Live milestones kept per task; a fresh render supersedes them anyway. */
export const LIVE_MILESTONES_MAX = 40;

export type LiveSnapshot = Readonly<Record<string, LiveTaskPatch>>;

export interface MissionLiveStore {
  getSnapshot(): LiveSnapshot;
  subscribe(listener: () => void): () => void;
  /** Merge a patch for one task. Absent fields keep their previous value. */
  patch(taskId: string, patch: Partial<Omit<LiveTaskPatch, 'milestones'>>): void;
  /** Drop every patch: a fresh server render supersedes them. */
  reset(): void;
}

const EMPTY: LiveSnapshot = Object.freeze({});
const NO_MILESTONES: readonly LiveMilestone[] = Object.freeze([]);

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
      const prev = snapshot[taskId] ?? { workerId: null, status: null, currentAction: null, updatedAt: null, milestones: NO_MILESTONES };
      const workerId = p.workerId !== undefined ? p.workerId : prev.workerId;
      const currentAction = p.currentAction !== undefined ? p.currentAction : prev.currentAction;
      const updatedAt = p.updatedAt !== undefined ? p.updatedAt : prev.updatedAt;
      const sameWorker = !prev.workerId || !workerId || prev.workerId === workerId;
      let milestones = sameWorker ? prev.milestones : NO_MILESTONES;
      if (currentAction && (currentAction !== prev.currentAction || !sameWorker)) {
        const ts = updatedAt ? Date.parse(updatedAt) : NaN;
        milestones = [...milestones, { label: currentAction, ts: Number.isFinite(ts) ? ts : Date.now() }].slice(-LIVE_MILESTONES_MAX);
      }
      const next: LiveTaskPatch = {
        workerId,
        status: p.status !== undefined ? p.status : prev.status,
        currentAction,
        updatedAt,
        milestones,
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
  /** `worker:artifact` from lib/artifact-helpers.ts carries the row instead. */
  artifact?: { workerId?: string | null; missionId?: string | null; metadata?: { taskId?: unknown } | null };
}

const asPayload = (data: unknown): EventPayload => (data && typeof data === 'object' ? (data as EventPayload) : {});

export type MissionEventDecision =
  | { kind: 'ignore' }
  | { kind: 'patch'; taskId: string; patch: Partial<Omit<LiveTaskPatch, 'milestones'>> }
  | { kind: 'refresh'; taskId?: string; patch?: Partial<Omit<LiveTaskPatch, 'milestones'>> };

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
    case 'worker:artifact': {
      // Two shapes: `{workerId, taskId}` (POST /api/workers/[id]/artifacts)
      // and `{artifact}` (auto-artifact on completion, metadata.taskId).
      const a = p.artifact;
      const artifactTask = typeof a?.metadata?.taskId === 'string' ? a.metadata.taskId : null;
      const workerId = p.workerId ?? a?.workerId ?? null;
      const mine = ours(taskId) || ours(artifactTask)
        || (!!a?.missionId && a.missionId === ctx.missionId)
        || (!!workerId && ctx.lastStatusByWorker.has(workerId));
      return mine ? { kind: 'refresh' } : { kind: 'ignore' };
    }
    case 'mission:note_posted':
    case 'mission:completion_decision':
      return { kind: 'refresh' };
    case 'worker:progress': {
      if (!ours(taskId)) return { kind: 'ignore' };
      // Webhook nudge (CI / merge / PR refresh): no worker, no status — the
      // row's PR state changed, which the store does not carry.
      if (!p.workerId) return { kind: 'refresh', taskId };
      const status = p.status ?? p.worker?.status ?? null;
      const patch: Partial<Omit<LiveTaskPatch, 'milestones'>> = { workerId: p.workerId };
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
