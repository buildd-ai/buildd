/**
 * Canonical task presentation derivation layer.
 * All UI surfaces consume these pure functions — never fork display logic locally.
 */

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
 * Gate rule (mirrors the SQL in the claim route):
 *   status = 'completed' AND no worker has an open (unmerged) PR.
 *
 * This is the authoritative TypeScript representation of the gate. The claim
 * route enforces the same condition in SQL; this function keeps the display
 * layer in sync. Tests assert both agree on the same inputs.
 */
export function isGateSatisfied(
  dep: { status: string },
  depWorkers: Array<{ prUrl: string | null; mergedAt: string | null }>,
): boolean {
  if (dep.status !== 'completed') return false;
  return !depWorkers.some((w) => w.prUrl !== null && w.mergedAt === null);
}

// ─── Chain position ───────────────────────────────────────────────────────────

export type SegmentState = 'filled' | 'half' | 'current' | 'empty';

export interface Segment {
  taskId: string;
  state: SegmentState;
}

export interface BlockRef {
  id: string;
  title: string;
  prUrl?: string | null;
  prNumber?: number | null;
}

export interface ChainPositionResult {
  /** 1-based position of the subject task in the full chain. */
  index: number;
  /** Total chain length: deps + subject + dependents. */
  total: number;
  /** Upstream deps that have not yet satisfied the claim gate. */
  blockedBy: BlockRef[];
  /** Count of downstream tasks waiting on this one. */
  unblocks: number;
  /** Per-task segment states for the dep strip (deps + current, not downstream). */
  segments: Segment[];
}

export interface ChainPositionDep {
  id: string;
  title: string;
  status: string;
  workers: Array<{ prUrl: string | null; prNumber?: number | null; mergedAt: string | null }>;
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
    if (dep.status !== 'completed') {
      return { taskId: dep.id, state: 'empty' };
    }
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
        prUrl: openWorker?.prUrl ?? null,
        prNumber: openWorker?.prNumber ?? null,
      };
    });

  return {
    index: deps.length + 1,
    total: deps.length + 1 + dependents,
    blockedBy,
    unblocks: dependents,
    segments,
  };
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
