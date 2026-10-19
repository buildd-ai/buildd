/**
 * Stranded local missions.
 *
 * A mission with `executor: 'local'` is worked from a person's own interactive
 * session: runners never auto-claim its tasks (the claim route's local gate),
 * and the session claims each one with `claim_task {taskId}`. When work lands
 * on such a mission after the session has ended — a task the organizer filed,
 * a reviewer the PR flow spawned, a dependency that just merged — nothing will
 * ever pick it up, while every surface reads LOCAL as if work were happening.
 *
 * `deriveLocalStrand` is the one predicate for that. The mission card, the
 * mission page, `explain` and the chat mission object all call it and hand its
 * answer to `deriveMissionStateView` (`localStrand`), so they cannot disagree.
 *
 * Stranded = a CLAIMABLE task (pending, every dependency met by the claim
 * gate's own rule, start floor passed) AND no session touch on the mission for
 * `LOCAL_SESSION_QUIET_MS`, measured from the later of the last session touch
 * and the moment the oldest claimable task became claimable. Held outranks it
 * (a held mission is a deliberate pause, not a stranded one).
 *
 * Pure and client-safe.
 */
import {
  claimableSince,
  unmetDependencyIds,
  type DependencyRow,
} from './mission-helpers';

/**
 * How long a local mission may hold claimable work with no session touch
 * before it reads stranded.
 *
 * 30 minutes. An interactive session reports through `update_progress` and
 * `complete_task`, which stamp the worker row; between claims (reading, thinking,
 * a long build) it can go quiet for a while without having gone anywhere. The
 * stall grace for runners is 5 minutes because a runner polls on a tick; a
 * person does not, so the window is six times that. Longer than 30 minutes and
 * the owner is the one who notices first, which is the failure this exists to
 * fix.
 */
export const LOCAL_SESSION_QUIET_MS = 30 * 60_000;

const TERMINAL_MISSION = new Set(['completed', 'archived', 'cancelled']);

export interface StrandWorkerRow {
  status: string;
  /** `workers.runner` — 'mcp' for an interactive session. Read for the facts only. */
  runner?: string | null;
  startedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  completedAt?: Date | string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  mergedAt?: Date | string | null;
  prLifecycleStatus?: string | null;
}

export interface StrandTaskRow {
  id: string;
  status: string;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  startAt?: Date | string | null;
  dependsOn?: string[] | null;
  roleSlug?: string | null;
  workers?: StrandWorkerRow[] | null;
}

export interface LocalStrand {
  /** True when nothing will claim the claimable work: see the module note. */
  stranded: boolean;
  /** Pending tasks a session could claim right now, oldest first. */
  claimableTaskIds: string[];
  /** Latest session touch on any of the mission's workers, ISO. Null when none ever ran. */
  lastSessionAt: string | null;
  /** How long the claimable work has gone untouched. 0 when nothing is claimable. */
  quietMs: number;
  /**
   * When the quiet clock started (ms): the later of the last session touch and
   * the moment the oldest dependency-met pending task became claimable (a
   * future start floor included). Null when nothing is pending. `quietMs` and
   * `stranded` are this anchor read at `now`, so a stored reading keeps the
   * anchor and derives the other two when it is read (`strandAt`).
   */
  quietSince: number | null;
}

/** The two time-dependent answers of a strand, read from its anchor at `now`. */
export function strandAt(quietSince: number | null, now: number): { stranded: boolean; quietMs: number } {
  const quietMs = quietSince === null ? 0 : Math.max(0, now - quietSince);
  return { stranded: quietSince !== null && quietMs >= LOCAL_SESSION_QUIET_MS, quietMs };
}

function ms(d: Date | string | null | undefined): number | null {
  if (d == null) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The latest moment a worker row was touched: claimed, reported progress, or finished. */
function lastTouch(w: StrandWorkerRow): number | null {
  const times = [ms(w.startedAt), ms(w.updatedAt), ms(w.completedAt)].filter((t): t is number => t !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Null when the question does not apply: not a local mission, held, or
 * terminal. Otherwise the strand reading, `stranded` false or true.
 *
 * `dependencies`: rows outside `tasks` (a dependency in another mission),
 * judged rather than guessed, same as `deriveTaskHealthSignal`.
 */
export function deriveLocalStrand(input: {
  executor?: string | null;
  isHeld?: boolean | null;
  status: string;
  tasks: readonly StrandTaskRow[];
  dependencies?: ReadonlyMap<string, DependencyRow>;
  now?: number;
}): LocalStrand | null {
  if (input.executor !== 'local' || input.isHeld || TERMINAL_MISSION.has(input.status)) return null;
  const now = input.now ?? Date.now();

  const byId = new Map<string, DependencyRow>(input.dependencies ?? []);
  for (const t of input.tasks) byId.set(t.id, t as DependencyRow);

  const claimable = input.tasks
    .filter(t => t.status === 'pending')
    .filter(t => !(ms(t.startAt) !== null && ms(t.startAt)! > now))
    .filter(t => unmetDependencyIds(t, byId).length === 0)
    .map(t => ({ id: t.id, since: claimableSince(t, byId) }))
    .sort((a, b) => (a.since ?? 0) - (b.since ?? 0));

  const touches = input.tasks.flatMap(t => (t.workers ?? []).map(lastTouch)).filter((t): t is number => t !== null);
  const lastSession = touches.length > 0 ? Math.max(...touches) : null;

  const lastSessionAt = lastSession !== null ? new Date(lastSession).toISOString() : null;

  // The anchor ignores the start floor: a task still before its floor has
  // `since` at the floor, in the future, so it reads quiet for zero until the
  // floor passes and then counts from it. Same answer, without the clock.
  const pending = input.tasks
    .filter(t => t.status === 'pending')
    .filter(t => unmetDependencyIds(t, byId).length === 0)
    .map(t => claimableSince(t, byId))
    .filter((t): t is number => t !== null);
  // Quiet since the later of: the session's last touch, and the oldest
  // claimable task becoming claimable. A task filed a minute ago has not been
  // ignored for an hour just because the session left an hour ago.
  const anchors = pending.length > 0 ? [lastSession, Math.min(...pending)].filter((t): t is number => t !== null) : [];
  const quietSince = anchors.length > 0 ? Math.max(...anchors) : null;

  if (claimable.length === 0) {
    return { stranded: false, claimableTaskIds: [], lastSessionAt, quietMs: 0, quietSince };
  }

  return { ...strandAt(quietSince, now), claimableTaskIds: claimable.map(c => c.id), lastSessionAt, quietSince };
}

/**
 * Why "Continue on a runner" would be refused, or null when it would go
 * through. The PATCH route enforces exactly this on a local → runner flip, and
 * the card computes it at render time from the same row, so the button is
 * disabled with this reason rather than offered and then refused.
 */
export function continueOnRunnerBlockedReason(mission: { status: string; workspaceId?: string | null }): string | null {
  if (TERMINAL_MISSION.has(mission.status)) {
    return `The mission is ${mission.status}, so there is nothing for a runner to pick up.`;
  }
  // `undefined` is "not loaded", not "none": only a known-null workspace refuses.
  if (mission.workspaceId === null) {
    return 'The mission has no workspace, so runners have nowhere to claim its tasks from. Move it into a workspace first.';
  }
  return null;
}

/** "45m", "3h", "2d" — how long a local mission has been quiet. */
export function quietLabel(quietMs: number): string {
  const m = Math.max(0, Math.round(quietMs / 60_000));
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
