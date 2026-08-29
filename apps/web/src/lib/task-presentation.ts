/**
 * Canonical task presentation derivation layer.
 * All UI surfaces consume these pure functions — never fork display logic locally.
 */

import { DEP_SATISFYING_STATUSES, DEP_UNBLOCKING_PR_LIFECYCLE } from './dep-gate-contract';
import { isSubjectDead, type SubjectGateFields } from './subject-gate-contract';

/**
 * Re-exported so display surfaces read the SAME predicate the claim gate
 * enforces in SQL (api/workers/claim/subject-gate.ts). A subject-dead task can
 * never be claimed; it must never render as a healthy queued row.
 */
export { isSubjectDead };
export type { SubjectGateFields };

// ─── Staleness thresholds ─────────────────────────────────────────────────────

/** Worker active within this window → 'fresh' intensity tier. */
export const LIVENESS_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Running worker with no activity beyond this threshold → 'slow' intensity tier.
 * isStaleWorker() uses this as its single threshold — extending to two tiers does
 * not change the existing 10-min behavior.
 */
export const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;

/** No worker activity beyond this threshold → 'stalled' intensity tier. */
export const PROGRESS_THRESHOLD_MS = 60 * 60 * 1000;

// ─── Live worker statuses ─────────────────────────────────────────────────────

/**
 * Canonical set of worker statuses that indicate an active (live) worker.
 * Use this in every DB query that joins workers to filter for active ones.
 * task.status NEVER becomes 'running'; liveness is worker-derived only.
 */
export const LIVE_WORKER_STATUSES = ['idle', 'running', 'starting', 'waiting_input'] as const;
export type LiveWorkerStatus = (typeof LIVE_WORKER_STATUSES)[number];

// ─── Display status ───────────────────────────────────────────────────────────

/**
 * Canonical display status from task DB status + active worker status.
 * Callers must not fork their own logic — this is the single source of truth.
 */
export function deriveDisplayStatus(taskStatus: string, workerStatus?: string | null): string {
  if (workerStatus === 'running' || workerStatus === 'starting' || workerStatus === 'idle')
    return 'running';
  if (workerStatus === 'waiting_input') return 'waiting_input';
  return taskStatus;
}

// ─── Task phase ───────────────────────────────────────────────────────────────

/**
 * The lifecycle phase that drives the task detail page's focus zone.
 * A superset of the display status: it folds pending substates (blocked,
 * budget-paused) and planning review into distinct phases so the UI can pick
 * a single "what does the human need right now?" panel per phase.
 *
 * Precedence mirrors deriveDisplayStatus: a terminal task status (completed /
 * failed) wins over any lingering worker state, then live worker state, then
 * the pending family.
 */
export type TaskPhase =
  | 'subject_dead'   // pending, but its subject PR is dead — unclaimable, needs a human
  | 'mission_budget_exhausted' // pending, but its mission is out of budget — unclaimable
  | 'blocked'        // pending, waiting on unresolved dependencies
  | 'budget_paused'  // pending, reset to pending by budget/rate-limit exhaustion
  | 'pending'        // ready to start
  | 'assigned'       // claimed but no live worker yet (spinning up)
  | 'running'        // a worker is actively executing
  | 'waiting_input'  // a worker asked a question — answering spawns a new worker
  | 'plan_review'    // a completed planning task whose plan awaits human review
  | 'completed'      // terminal success
  | 'failed';        // terminal failure

export interface TaskPhaseInput {
  taskStatus: string;
  /** task.mode — 'planning' tasks land in plan_review once completed. */
  taskMode?: string | null;
  workerStatus?: string | null;
  /** Truthy when the active worker has an unanswered question. */
  workerWaitingFor?: unknown;
  /** pending + unresolved dependencies. */
  isBlocked?: boolean;
  /** pending + budgetExhausted flag in context. */
  isBudgetPaused?: boolean;
  /**
   * The subject-liveness gate excludes this task from the claim query — see
   * isSubjectDead() / lib/subject-gate-contract.ts. Nothing will ever pick it
   * up, so it must not present as QUEUED.
   */
  isSubjectDead?: boolean;
  /**
   * The parent mission's status is `budget_exhausted`, which makes the claim
   * loop skip this task and every sibling in the mission (mission gate #1 in
   * api/workers/claim/route.ts). Only a human raising the mission's
   * costBudgetUsd clears it, so this must not present as QUEUED either.
   */
  isMissionBudgetExhausted?: boolean;
}

/**
 * Canonical task phase from task + active-worker state. Single source of truth —
 * UI surfaces must not fork this logic.
 */
export function deriveTaskPhase(i: TaskPhaseInput): TaskPhase {
  // Terminal task status wins over any lingering/stale worker row.
  if (i.taskStatus === 'completed') {
    return i.taskMode === 'planning' ? 'plan_review' : 'completed';
  }
  if (i.taskStatus === 'failed') return 'failed';

  // Live worker-derived phases. A pending question outranks "running" because
  // the runner aborts the session when it asks (inputAsRetry), so the worker is
  // effectively parked until a human answers.
  if (i.workerWaitingFor || i.workerStatus === 'waiting_input') return 'waiting_input';
  if (
    i.workerStatus === 'running' ||
    i.workerStatus === 'starting' ||
    i.workerStatus === 'idle'
  ) {
    return 'running';
  }

  // Pending family (no live worker).
  // subject_dead first: unlike blocked/budget_paused it will NEVER clear on its
  // own — no dependency merging or budget reset makes the task claimable again.
  if (i.isSubjectDead) return 'subject_dead';
  // Next: the mission-wide budget wall. Like subject_dead it will not clear on
  // its own, but unlike it there IS a one-click remedy (raise the budget), so
  // it ranks below subject_dead and above every "waiting for something" phase.
  if (i.isMissionBudgetExhausted) return 'mission_budget_exhausted';
  if (i.taskStatus === 'assigned') return 'assigned';
  if (i.isBlocked) return 'blocked';
  if (i.isBudgetPaused) return 'budget_paused';
  return 'pending';
}

// ─── Stale worker ─────────────────────────────────────────────────────────────

/**
 * True when a running worker has not emitted any update past STALENESS_THRESHOLD_MS.
 */
export function isStaleWorker(
  workerStatus: string | null | undefined,
  workerUpdatedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (workerStatus !== 'running') return false;
  if (!workerUpdatedAt) return false;
  return now - new Date(workerUpdatedAt).getTime() > STALENESS_THRESHOLD_MS;
}

// ─── Timestamp label ──────────────────────────────────────────────────────────

function durToStr(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function agoStr(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export interface TimestampLabelParams {
  taskStatus: string;
  workerStatus?: string | null;
  taskCreatedAt: string;
  taskUpdatedAt: string;
  workerStartedAt?: string | null;
  workerUpdatedAt?: string | null;
  now?: number;
}

/**
 * Human-readable timestamp label keyed by the task's canonical display status.
 *   running   → "running 58m · active 1m ago"
 *   waiting   → "needs input · 45m"
 *   queued    → "queued 3h"
 *   completed → "2h ago"
 */
export function deriveTimestampLabel(params: TimestampLabelParams): string {
  const {
    taskStatus,
    workerStatus,
    taskCreatedAt,
    taskUpdatedAt,
    workerStartedAt,
    workerUpdatedAt,
    now = Date.now(),
  } = params;

  const displayStatus = deriveDisplayStatus(taskStatus, workerStatus);

  if (displayStatus === 'running') {
    const startMs = workerStartedAt
      ? new Date(workerStartedAt).getTime()
      : new Date(taskCreatedAt).getTime();
    const runMs = now - startMs;
    const lastActivityMs = workerUpdatedAt ? now - new Date(workerUpdatedAt).getTime() : 0;
    return `running ${durToStr(runMs)} · active ${agoStr(lastActivityMs)}`;
  }

  if (displayStatus === 'waiting_input') {
    const startMs = workerStartedAt
      ? new Date(workerStartedAt).getTime()
      : new Date(taskCreatedAt).getTime();
    return `needs input · ${durToStr(now - startMs)}`;
  }

  if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled') {
    return agoStr(now - new Date(taskUpdatedAt).getTime());
  }

  return `queued ${durToStr(now - new Date(taskCreatedAt).getTime())}`;
}

// ─── Chain gate predicate ─────────────────────────────────────────────────────

/**
 * Returns true when a dependency task satisfies the claim gate.
 *
 * Gate rule (mirrors `dependenciesSatisfied()` in api/workers/claim/deps-gate.ts):
 *   status ∈ DEP_SATISFYING_STATUSES ('completed' | 'cancelled')
 *   AND NOT (status = 'completed' AND some worker has an open PR)
 *
 * where "open PR" = prUrl set, mergedAt null, and lifecycle != 'closed'. A
 * cancelled dep carries no PR guard — cancelling is a deliberate "this won't be
 * delivered" signal, so its dependents proceed.
 *
 * This is the authoritative TypeScript representation of the gate. Both sides
 * read DEP_SATISFYING_STATUSES from dep-gate-contract.ts so they cannot drift.
 */
export function isGateSatisfied(
  dep: { status: string },
  depWorkers: Array<{
    prUrl: string | null;
    mergedAt: string | null;
    prLifecycleStatus?: string | null;
  }>,
): boolean {
  if (!(DEP_SATISFYING_STATUSES as readonly string[]).includes(dep.status)) return false;
  // The open-PR guard applies to delivered work only.
  if (dep.status !== 'completed') return true;
  return !depWorkers.some(
    (w) =>
      w.prUrl !== null &&
      w.mergedAt === null &&
      w.prLifecycleStatus !== DEP_UNBLOCKING_PR_LIFECYCLE,
  );
}

// ─── Chain position ───────────────────────────────────────────────────────────

/**
 * 'filled'  — dep satisfied the gate (delivered + merged)
 * 'half'    — dep completed but its PR is still open: looks done, silently blocks
 * 'skipped' — dep cancelled: satisfied without being delivered
 * 'empty'   — dep not yet satisfied
 * 'current' — the subject task
 */
export type SegmentState = 'filled' | 'half' | 'current' | 'empty' | 'skipped';

export interface Segment {
  taskId: string;
  state: SegmentState;
}

export interface BlockRef {
  id: string;
  title: string;
  /** The blocker's task status — lets the rail say *why* it blocks. */
  status?: string;
  prUrl?: string | null;
  prNumber?: number | null;
}

export interface ChainPositionResult {
  /** 1-based position of the subject task in the full chain. */
  index: number;
  /** Total chain length: deps + subject + dependents. */
  total: number;
  /** Every upstream dep that has not yet satisfied the claim gate. */
  blockedBy: BlockRef[];
  /**
   * blockedBy with transitively implied blockers removed — the deps the subject
   * is *directly* waiting on. This is what UI surfaces render; blockedBy stays
   * the truthful full set for counts and tooltips.
   */
  blockedByFrontier: BlockRef[];
  /** Count of downstream tasks waiting on this one. */
  unblocks: number;
  /** Per-task segment states for the dep strip (deps + current, not downstream). */
  segments: Segment[];
}

export interface ChainPositionDep {
  id: string;
  title: string;
  status: string;
  workers: Array<{
    prUrl: string | null;
    prNumber?: number | null;
    mergedAt: string | null;
    prLifecycleStatus?: string | null;
  }>;
  /**
   * The dep's own upstream edges. Used only for transitive reduction of
   * blockedBy → blockedByFrontier. Omit it and the frontier equals blockedBy.
   */
  dependsOn?: string[] | null;
}

export interface ChainPositionParams {
  task: { id: string; status: string };
  deps: ChainPositionDep[];
  dependents: number;
}

/**
 * Derives the subject task's position and state within its dependency chain.
 *
 * The half segment state is the key signal: a completed task with an open PR
 * looks finished but silently blocks everything downstream (the gate is not
 * satisfied until the PR merges). This is the failure mode that cost the
 * Trackable Objects mission four task failures.
 */
export function deriveChainPosition({
  task,
  deps,
  dependents,
}: ChainPositionParams): ChainPositionResult {
  const segments: Segment[] = deps.map((dep) => {
    if (dep.status === 'cancelled') return { taskId: dep.id, state: 'skipped' };
    if (dep.status !== 'completed') return { taskId: dep.id, state: 'empty' };
    const gateOk = isGateSatisfied(dep, dep.workers);
    return { taskId: dep.id, state: gateOk ? 'filled' : 'half' };
  });

  segments.push({ taskId: task.id, state: 'current' });

  const blockedBy: BlockRef[] = deps
    .filter((dep) => !isGateSatisfied(dep, dep.workers))
    .map((dep) => {
      const openWorker = dep.workers.find((w) => w.prUrl !== null && w.mergedAt === null);
      return {
        id: dep.id,
        title: dep.title,
        status: dep.status,
        prUrl: openWorker?.prUrl ?? null,
        prNumber: openWorker?.prNumber ?? null,
      };
    });

  return {
    index: deps.length + 1,
    total: deps.length + 1 + dependents,
    blockedBy,
    blockedByFrontier: reduceToFrontier(blockedBy, deps),
    unblocks: dependents,
    segments,
  };
}

/**
 * Transitive reduction of a blocker set.
 *
 * A blocker B is *implied* when some other blocker C already depends on B —
 * directly or through any chain of edges present in `deps`. Waiting on C
 * necessarily means waiting on B, so listing B adds no information.
 *
 * Reachability walks the edges of every dep, not just the blockers, so a chain
 * that routes through an already-satisfied node still counts. Edges pointing
 * outside `deps` are ignored (they cannot prove reachability between two
 * blockers we know about).
 *
 * If reduction would eliminate every blocker — only possible with a dependency
 * cycle, which is malformed data — the full list is returned rather than
 * leaving a BLOCKED task with no visible reason.
 */
function reduceToFrontier(blockedBy: BlockRef[], deps: ChainPositionDep[]): BlockRef[] {
  if (blockedBy.length < 2) return blockedBy;

  const edges = new Map<string, string[]>();
  for (const dep of deps) {
    if (dep.dependsOn?.length) edges.set(dep.id, dep.dependsOn);
  }
  if (edges.size === 0) return blockedBy;

  /** Every node reachable from `from` by following edges, excluding `from`. */
  const reachableFrom = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(edges.get(from) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
    return seen;
  };

  const implied = new Set<string>();
  for (const blocker of blockedBy) {
    for (const reached of reachableFrom(blocker.id)) implied.add(reached);
  }

  const frontier = blockedBy.filter((b) => !implied.has(b.id));
  return frontier.length > 0 ? frontier : blockedBy;
}

// ─── Intensity ────────────────────────────────────────────────────────────────

export type IntensityTier = 'fresh' | 'working' | 'slow' | 'stalled';

export interface IntensityResult {
  /** Staleness tier based on time since last worker activity. */
  tier: IntensityTier;
  /** Turn counts bucketed into 5-minute windows from startedAt. */
  sparkline: number[];
}

const SPARKLINE_BUCKET_MS = 5 * 60 * 1000;

/**
 * Derives intensity tier and turn sparkline for a running task.
 *
 * Tiers:
 *   fresh   — active within LIVENESS_THRESHOLD_MS (5 min)
 *   working — 5–10 min since last activity
 *   slow    — 10 min–1 h (isStaleWorker fires at this boundary)
 *   stalled — 1 h+ since last activity
 *
 * @param turns   Timestamps (ms) of individual turn events. Empty → flat sparkline.
 * @param startedAt  Worker or task start time; used to anchor sparkline buckets.
 */
export function deriveIntensity({
  turns,
  startedAt,
  workerUpdatedAt,
  now = Date.now(),
}: {
  turns: number[];
  startedAt: string | null | undefined;
  workerUpdatedAt: string | null | undefined;
  now?: number;
}): IntensityResult {
  let tier: IntensityTier;

  if (!workerUpdatedAt) {
    tier = 'fresh';
  } else {
    const ageMs = now - new Date(workerUpdatedAt).getTime();
    if (ageMs < LIVENESS_THRESHOLD_MS) tier = 'fresh';
    else if (ageMs < STALENESS_THRESHOLD_MS) tier = 'working';
    else if (ageMs < PROGRESS_THRESHOLD_MS) tier = 'slow';
    else tier = 'stalled';
  }

  const startMs = startedAt ? new Date(startedAt).getTime() : now;
  const elapsed = Math.max(0, now - startMs);
  const bucketCount = Math.max(1, Math.ceil(elapsed / SPARKLINE_BUCKET_MS));
  const sparkline = new Array<number>(bucketCount).fill(0);

  for (const ts of turns) {
    const idx = Math.floor((ts - startMs) / SPARKLINE_BUCKET_MS);
    if (idx >= 0 && idx < bucketCount) {
      sparkline[idx]++;
    }
  }

  return { tier, sparkline };
}
