import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, InitiativeKPI, InitiativeKPIState } from '@buildd/shared';
export type { GoalCriterion, GoalCriteriaState, CriterionVerdict, InitiativeKPI, InitiativeKPIState };

// ─── Task type detection ───────────────────────────────────────────────────────

/** Derived task subtypes for display (no schema change — derived from title prefix + parentTaskId). */
export type TaskType = 'retry' | 'review' | 'review-retry';

/**
 * Derive a task's display type from its title prefix, parentTaskId, and mode.
 *
 * Taxonomy:
 * - prefix match ([CI Retry], [reviewer], [reviewer retry]) → attempt, regardless of mode
 * - parentTaskId IS NOT NULL + mode='execution' + no prefix → spawned builder (distinct deliverable) → null
 * - parentTaskId IS NOT NULL + no prefix + any other mode → legacy/unlabeled retry attempt → 'retry'
 * - parentTaskId IS NULL → root task → null
 *
 * Recognized prefixes are detected regardless of parentTaskId — this covers legacy
 * attempt tasks that predate the parentTaskId column and therefore have
 * parentTaskId IS NULL despite being retries.
 */
export function deriveTaskType(task: {
  title?: string | null;
  parentTaskId?: string | null;
  mode?: string | null;
}): TaskType | null {
  const title = task.title ?? '';
  // Check recognized prefixes first — these always classify the task as an attempt.
  if (/^\[reviewer retry/i.test(title)) return 'review-retry';
  if (/^\[reviewer\]/i.test(title)) return 'review';
  if (/^\[(?:CI )?retry/i.test(title)) return 'retry';
  // No recognized prefix.
  if (!task.parentTaskId) return null;
  // Spawned execution children (created by approve_plan) are distinct units of work.
  // They must be counted separately, not collapsed under their planning-task parent.
  if (task.mode === 'execution') return null;
  // Any other task with parentTaskId is a legacy/unlabeled retry attempt.
  return 'retry';
}

/**
 * Strip a leading bracketed prefix (e.g. "[CI Retry #1]", "[reviewer]") from a task title.
 * Used to clean up displayed titles when a TaskTypeBadge renders the type visually instead.
 */
export function stripTaskTypePrefix(title: string): string {
  return title.replace(/^\[[^\]]+\]\s*/, '').trim();
}

// ─── Goal criteria evaluator ──────────────────────────────────────────────────

/**
 * Evaluate a mission's goalCriteria against the provided context.
 *
 * This is a pure function — it does NOT write to the DB. The caller persists
 * the returned GoalCriteriaState. All criteria are evaluated in order; any
 * 'fail' or 'UNVERIFIED' makes the overall verdict non-pass.
 *
 * 'command' criteria are not executable here (they require a worker task).
 * They return UNVERIFIED; the caller must dispatch the task separately.
 *
 * 'metric' criteria are not implemented yet — they return UNVERIFIED with a
 * note (the field is reserved for a follow-on metric-query registry spec).
 */
export function evaluateGoalCriteria(
  mission: {
    id: string;
    workingBranch?: string | null;
  },
  criteria: GoalCriterion[],
  context: {
    tasks: Array<{
      id: string;
      status: string;
      kind?: string | null;
      title?: string | null;
      mode?: string | null;
      creationSource?: string | null;
      category?: string | null;
    }>;
    workers: Array<{
      taskId?: string | null;
      mergedAt?: string | Date | null;
      prUrl?: string | null;
      branchName?: string | null;
      branchDeleted?: boolean | null;
    }>;
    artifacts: Array<{
      key?: string | null;
      type?: string | null;
    }>;
    evaluatedBy: 'auto' | 'manual' | 'mcp';
    now?: string;
  },
): GoalCriteriaState {
  const evaluatedAt = context.now ?? new Date().toISOString();
  const results: GoalCriteriaState['criteria'] = [];

  for (let i = 0; i < criteria.length; i++) {
    const criterion = criteria[i];
    let verdict: CriterionVerdict = 'UNVERIFIED';
    let evidence: string | undefined;
    let workerTaskId: string | undefined;

    switch (criterion.type) {
      case 'all_prs_merged': {
        const requireBranchDeleted = criterion.requireBranchDeleted === true;
        const deliverableWorkers = context.workers.filter(w => w.prUrl);
        if (deliverableWorkers.length === 0) {
          verdict = 'fail';
          evidence = 'No PR workers found for this mission';
        } else {
          const unmerged = deliverableWorkers.filter(w => !w.mergedAt);
          if (unmerged.length > 0) {
            verdict = 'fail';
            evidence = `${unmerged.length} PR(s) not yet merged`;
          } else if (requireBranchDeleted) {
            // Check if branch is deleted. branchDeleted is set by the caller
            // after querying the GitHub API. If unknown, mark UNVERIFIED.
            const branchKnown = deliverableWorkers.some(w => w.branchDeleted !== null && w.branchDeleted !== undefined);
            if (!branchKnown) {
              verdict = 'UNVERIFIED';
              evidence = 'Branch deletion status unknown — GitHub check needed';
            } else {
              const branchStillLive = deliverableWorkers.some(w => w.branchDeleted === false);
              verdict = branchStillLive ? 'fail' : 'pass';
              evidence = branchStillLive
                ? `Working branch still exists (requireBranchDeleted=true)`
                : 'All PRs merged and working branch deleted';
            }
          } else {
            verdict = 'pass';
            evidence = `All ${deliverableWorkers.length} PR(s) merged`;
          }
        }
        break;
      }

      case 'command': {
        // Command criteria dispatch a worker task; we can't run inline.
        verdict = 'UNVERIFIED';
        evidence = `Command criterion requires worker task dispatch: ${criterion.command}`;
        break;
      }

      case 'no_open_tasks': {
        const deliverable = context.tasks.filter(isDeliverableTask);
        const open = deliverable.filter(t =>
          !['completed', 'cancelled', 'failed'].includes(t.status)
        );
        verdict = open.length === 0 ? 'pass' : 'fail';
        evidence = open.length === 0
          ? `All ${deliverable.length} deliverable task(s) are closed`
          : `${open.length} task(s) still open: ${open.map(t => t.status).join(', ')}`;
        break;
      }

      case 'artifact_exists': {
        const matches = context.artifacts.filter(a => {
          if (criterion.key && a.key !== criterion.key) return false;
          if (criterion.artifactType && a.type !== criterion.artifactType) return false;
          return true;
        });
        verdict = matches.length > 0 ? 'pass' : 'fail';
        const filterDesc = [
          criterion.key ? `key="${criterion.key}"` : null,
          criterion.artifactType ? `type="${criterion.artifactType}"` : null,
        ].filter(Boolean).join(', ');
        evidence = matches.length > 0
          ? `Found ${matches.length} matching artifact(s) (${filterDesc || 'any'})`
          : `No artifact matching (${filterDesc || 'any'}) found`;
        break;
      }

      case 'metric': {
        // Metric query registry not yet implemented — always UNVERIFIED.
        verdict = 'UNVERIFIED';
        evidence = 'metric query not implemented — deferred to follow-on spec';
        break;
      }

      case 'description': {
        // Free-form criteria are evaluated by LLM in the evaluate route.
        // The pure evaluator marks NOT_EVALUATED so the route can distinguish
        // "never checked" from UNVERIFIED ("checked, ambiguous evidence").
        verdict = 'NOT_EVALUATED';
        evidence = 'Awaiting LLM evaluation';
        break;
      }

      default: {
        // Unknown type — stored by a client that predates this version.
        // Leave UNVERIFIED so the route's LLM evaluator can attempt a verdict.
        verdict = 'UNVERIFIED';
        evidence = `Unknown criterion type: ${(criterion as any).type}`;
        break;
      }
    }

    results.push({
      index: i,
      type: criterion.type,
      ...(criterion.label ? { label: criterion.label } : {}),
      verdict,
      ...(evidence ? { evidence } : {}),
      ...(workerTaskId ? { workerTaskId } : {}),
    });
  }

  // NOT_EVALUATED means "we could not check this" — it is not a pass.
  // A mission with unevaluated criteria stays UNVERIFIED until the LLM layer upgrades them.
  const overall: CriterionVerdict =
    results.length === 0 ? 'pass'             // no criteria at all → pass
    : results.some(r => r.verdict === 'fail') ? 'fail'
    : results.some(r => r.verdict === 'NOT_EVALUATED') ? 'UNVERIFIED'
    : results.every(r => r.verdict === 'pass') ? 'pass'
    : 'UNVERIFIED';

  return { evaluatedAt, evaluatedBy: context.evaluatedBy, overall, criteria: results };
}

/**
 * Evaluate an initiative's KPIs.
 *
 * Pure function — callers persist the result. Non-blocking KPIs (blocking: false)
 * are evaluated and stored but do not affect the overall verdict.
 *
 * 'metric' queries are not implemented; all KPIs return UNVERIFIED with a note.
 */
export function evaluateInitiativeKPIs(
  _initiativeId: string,
  kpis: InitiativeKPI[],
  opts: {
    evaluatedBy: 'auto' | 'manual' | 'mcp';
    now?: string;
  },
): InitiativeKPIState {
  const evaluatedAt = opts.now ?? new Date().toISOString();
  const results: InitiativeKPIState['kpis'] = [];

  for (let i = 0; i < kpis.length; i++) {
    const kpi = kpis[i];
    // Metric query registry not yet implemented.
    results.push({
      index: i,
      name: kpi.name,
      verdict: 'UNVERIFIED',
      evidence: 'metric query not implemented — deferred to follow-on spec',
    });
  }

  // Overall: all blocking KPIs must pass. Non-blocking KPIs are informational.
  const blockingResults = results.filter((_, i) => kpis[i].blocking !== false);
  const overall: CriterionVerdict =
    blockingResults.length === 0 ? 'pass'
    : blockingResults.every(r => r.verdict === 'pass') ? 'pass'
    : blockingResults.some(r => r.verdict === 'fail') ? 'fail'
    : 'UNVERIFIED';

  return { evaluatedAt, evaluatedBy: opts.evaluatedBy, overall, kpis: results };
}

// ─── Mission segment states ───────────────────────────────────────────────────

/** Segment states for the mission progress bar. Vocabulary shared with task-chain strip. */
export type MissionSegmentState = 'solid' | 'half' | 'ghost' | 'empty' | 'notch';

export interface MissionSegment {
  taskId: string;
  state: MissionSegmentState;
}

/** Worker statuses that indicate an in-flight (live) worker. Mirrors task-presentation.ts. */
export const MISSION_LIVE_WORKER_STATUSES = ['idle', 'running', 'starting', 'waiting_input'] as const;
const LIVE_SET = new Set(MISSION_LIVE_WORKER_STATUSES);

// ─── TaskClass selectors ──────────────────────────────────────────────────────

/** True when t is a genuine deliverable (counts in mission progress and TASKS tally). */
export const isWork = (t: { taskClass?: string | null }) => t.taskClass === 'work';

/** True when t is a coordination/housekeeping row (excluded from progress denominator). */
export const isBookkeeping = (t: { taskClass?: string | null }) => t.taskClass === 'bookkeeping';

/** True when t is a retry or review pass that collapses under its parent. */
export const isAttempt = (t: { taskClass?: string | null }) => t.taskClass === 'attempt';

/**
 * Build a map of parentTaskId → attempt tasks for attempt-nesting display.
 * Replaces the raw parentTaskId/childrenMap approach in computeMissionProgress.
 */
export function attachAttempts<T extends { id?: string; taskClass?: string | null; parentTaskId?: string | null }>(
  tasks: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const t of tasks) {
    if (t.taskClass === 'attempt' && t.parentTaskId) {
      const bucket = map.get(t.parentTaskId) ?? [];
      bucket.push(t);
      map.set(t.parentTaskId, bucket);
    }
  }
  return map;
}

// ─── Deliverable predicate ────────────────────────────────────────────────────

/**
 * Returns true if the task counts as a deliverable for mission progress.
 *
 * Primary path: reads taskClass directly. Falls back to title/mode/kind
 * heuristics for rows that pre-date the backfill (taskClass IS NULL), so
 * the function degrades gracefully during the migration window.
 */
export function isDeliverableTask(task: {
  taskClass?: string | null;
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
  category?: string | null;
}): boolean {
  // Fast path: use the stored discriminator.
  if (task.taskClass != null) return task.taskClass === 'work';
  // Fallback for pre-migration rows (taskClass IS NULL).
  if (task.category === 'review') return false;
  if (task.kind === 'coordination') return false;
  if (task.mode === 'planning') return false;
  if (task.title?.startsWith('Aggregate results:')) return false;
  if (task.title?.startsWith('Evaluate mission completion:')) return false;
  if (task.title?.startsWith('Mission:')) return false;
  if (task.title?.startsWith('Close mission')) return false;
  return true;
}

function deriveMissionSegmentState(task: {
  id?: string;
  status: string;
  workers?: Array<{ status: string; prUrl?: string | null; mergedAt?: string | Date | null }>;
}): MissionSegmentState {
  const workers = task.workers ?? [];

  if (workers.some(w => LIVE_SET.has(w.status as any))) return 'ghost';

  if (task.status === 'completed') {
    const prWorker = workers.find(w => w.prUrl);
    if (!prWorker || prWorker.mergedAt) return 'solid';
    return 'half';
  }

  if (task.status === 'failed') return 'notch';

  return 'empty';
}

/**
 * Compute mission progress from a list of tasks.
 *
 * Rules:
 * - Only deliverable tasks (as per isDeliverableTask) count.
 * - Cancelled tasks are excluded from the denominator — they're treated as
 *   "never happened" so duplicate-killing doesn't block 100% completion.
 * - Failed tasks DO count against progress; they represent unfinished intended work.
 * - Attempt tasks (deriveTaskType returns non-null) are collapsed into their parent:
 *   the parent's effective status is the best outcome across all attempts.
 *   Attempts do not count as separate deliverables.
 * - Spawned builder tasks (parentTaskId IS NOT NULL AND mode='execution') are NOT
 *   attempts — they are distinct units of work created by approve_plan and count
 *   as separate deliverables even though they carry a parentTaskId.
 *
 * When tasks include an `id` and optional `workers`, the return value also
 * contains per-task `segments` for the projected progress bar.
 */
export function computeMissionProgress(tasks: Array<{
  id?: string;
  status: string;
  taskClass?: string | null;
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
  category?: string | null;
  parentTaskId?: string | null;
  workers?: Array<{ status: string; prUrl?: string | null; mergedAt?: string | Date | null }>;
}>): { totalTasks: number; completedTasks: number; progress: number; segments: MissionSegment[] } {
  // Collapse attempt tasks under their parents.
  // Primary: use taskClass='attempt' (set by backfill on all existing rows).
  // Fallback: use deriveTaskType for any pre-migration row (taskClass IS NULL).
  const childrenMap = new Map<string, typeof tasks>();
  const rootTasks = tasks.filter(t => {
    const isAttemptRow = t.taskClass != null
      ? t.taskClass === 'attempt'
      : (t.parentTaskId != null && deriveTaskType(t) !== null);
    if (isAttemptRow && t.parentTaskId) {
      const bucket = childrenMap.get(t.parentTaskId) ?? [];
      bucket.push(t);
      childrenMap.set(t.parentTaskId, bucket);
      return false;
    }
    return true;
  });

  // Status preference: completed > pending/assigned > failed > cancelled
  const STATUS_RANK: Record<string, number> = {
    completed: 0,
    pending: 1,
    assigned: 2,
    failed: 3,
    cancelled: 4,
  };

  const resolvedTasks = rootTasks.map(t => {
    const children = childrenMap.get(t.id ?? '') ?? [];
    if (children.length === 0) return t;
    const allStatuses = [t.status, ...children.map(c => c.status)];
    const bestStatus = allStatuses.reduce(
      (best, s) => ((STATUS_RANK[s] ?? 5) < (STATUS_RANK[best] ?? 5) ? s : best),
      allStatuses[0],
    );
    // Merge workers from all attempts so segment rendering sees the full picture
    const mergedWorkers = [
      ...(t.workers ?? []),
      ...children.flatMap(c => c.workers ?? []),
    ];
    return { ...t, status: bestStatus, workers: mergedWorkers };
  });

  const countable = resolvedTasks
    .filter(t => {
      // Planning tasks (orchestrator) normally excluded, but count when they
      // produced a PR — in orchestrator-only missions the plan IS the deliverable.
      if (t.mode === 'planning' && t.workers?.some(w => w.prUrl)) return true;
      return isDeliverableTask(t);
    })
    .filter(t => t.status !== 'cancelled');
  const total = countable.length;
  const completed = countable.filter(t => t.status === 'completed').length;
  const segments: MissionSegment[] = countable.map(t => ({
    taskId: t.id ?? '',
    state: deriveMissionSegmentState(t),
  }));
  return {
    totalTasks: total,
    completedTasks: completed,
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    segments,
  };
}

// ─── Initiative rollup ────────────────────────────────────────────────────────

/** Mission status vocabulary — mirrors missions.status in schema.ts. */
export type MissionStatus = 'active' | 'paused' | 'completed' | 'archived' | 'budget_exhausted';

/**
 * The per-child input to an initiative rollup: a mission's own status plus its
 * already-computed task tallies (from computeMissionProgress). The helper does
 * NOT query — callers pass these in.
 */
export interface ChildMissionProgress {
  status: MissionStatus;
  totalTasks: number;
  completedTasks: number;
}

export interface InitiativeProgress {
  totalMissions: number;
  completedMissions: number;
  totalTasks: number;
  completedTasks: number;
  /** 0-100. Task-weighted; falls back to mission-weighted when no countable tasks exist. */
  progress: number;
  status: 'empty' | 'active' | 'blocked' | 'paused' | 'completed';
}

/**
 * Roll a set of child missions up into an initiative-level summary.
 *
 * - Progress is task-weighted (sum completed / sum total across missions). When
 *   no mission has any countable task, it falls back to mission-weighted
 *   (completed missions / total missions) so an initiative of task-less but
 *   finished missions still reads as done rather than 0%.
 * - Status precedence: any budget_exhausted → 'blocked'; else any active →
 *   'active'; else any paused → 'paused'; else (all completed/archived) →
 *   'completed'. No missions → 'empty'.
 * - completedMissions counts mission STATUS === 'completed', independent of task
 *   completion (a mission with all tasks done but still active is not complete).
 */
export function computeInitiativeProgress(children: ChildMissionProgress[]): InitiativeProgress {
  const totalMissions = children.length;
  if (totalMissions === 0) {
    return { totalMissions: 0, completedMissions: 0, totalTasks: 0, completedTasks: 0, progress: 0, status: 'empty' };
  }

  const totalTasks = children.reduce((n, c) => n + c.totalTasks, 0);
  const completedTasks = children.reduce((n, c) => n + c.completedTasks, 0);
  const completedMissions = children.filter(c => c.status === 'completed').length;

  const status: InitiativeProgress['status'] =
    children.some(c => c.status === 'budget_exhausted') ? 'blocked'
    : children.some(c => c.status === 'active') ? 'active'
    : children.some(c => c.status === 'paused') ? 'paused'
    : 'completed';

  const progress = totalTasks > 0
    ? Math.round((completedTasks / totalTasks) * 100)
    : Math.round((completedMissions / totalMissions) * 100);

  return { totalMissions, completedMissions, totalTasks, completedTasks, progress, status };
}

/**
 * Flatten child missions' progress bars into one aggregate segment run for an
 * initiative-level SegmentStrip. Segments are concatenated in child order; each
 * segment keeps its own task's `taskId` (globally unique), so the strip has
 * stable keys and no per-surface renderer is introduced — the initiative bar is
 * the same primitive as the mission bar, just longer. Missions with no countable
 * tasks contribute nothing (empty initiative → empty array → SegmentStrip renders
 * null).
 */
export function computeInitiativeSegments(
  children: Array<{ segments?: MissionSegment[] }>,
): MissionSegment[] {
  return children.flatMap((c) => c.segments ?? []);
}

/** Progress milestones (%) an initiative rollup can "cross" for the arc headline. */
export const INITIATIVE_MILESTONES = [25, 50, 75, 90, 100] as const;

/**
 * The highest milestone crossed moving from `prev` progress to `curr` — i.e. the
 * largest threshold `m` with `prev < m <= curr`. Returns null when nothing was
 * crossed (including any non-increase, so a stalled or regressed initiative never
 * produces a headline). Callers seed `prev` from a persisted per-user snapshot;
 * a first-ever view (no snapshot) must NOT call this with prev=0 or every arc
 * would spuriously "cross" on first load — seed the baseline silently instead.
 */
export function crossedMilestone(prev: number, curr: number): number | null {
  if (curr <= prev) return null;
  let hit: number | null = null;
  for (const m of INITIATIVE_MILESTONES) {
    if (prev < m && m <= curr) hit = m; // ascending list → last match is the highest
  }
  return hit;
}

// ─── Mission skyline chart ────────────────────────────────────────────────────

const SKYLINE_SLOT_MS = 15 * 60 * 1000; // 15-minute quantization
const SKYLINE_MAX_LANES = 4;

export type SkylineBlockState = 'merged' | 'awaiting' | 'failed';

export interface SkylineBlock {
  lane: number;
  startSlot: number;
  endSlot: number; // exclusive
  state: SkylineBlockState;
}

export interface MissionSkylineData {
  totalSlots: number;
  blocks: SkylineBlock[];
  peakLanes: number;
  foldedLanes: number;
  activeSpanMin: number;
  agentTimeMin: number;
  parallelFactor: number;
  peakConcurrency: number;
  reviewTailMin: number | null;
}

type WorkerSpan = {
  startedAt: Date | string | null;
  completedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  status: string;
  prUrl: string | null;
  mergedAt: Date | string | null;
};

function workerEndMs(w: WorkerSpan, now: number): number {
  if (w.completedAt) return new Date(w.completedAt as string).getTime();
  if (w.updatedAt) return new Date(w.updatedAt as string).getTime();
  return now;
}

function workerBlockState(w: WorkerSpan): SkylineBlockState {
  if (w.status === 'error') return 'failed';
  if (w.mergedAt) return 'merged';
  if (w.prUrl) return 'awaiting';
  return 'merged';
}

/**
 * Build a quantized time-vs-concurrency skyline from a mission's worker spans.
 * Returns null when no workers have a valid startedAt.
 *
 * One slot = 15 minutes of wall-clock time.
 * Multi-slot tasks render as one joined bar; concurrent tasks stack into lanes.
 * Greedy packing: each worker goes to the lowest lane whose previous occupant ended.
 */
export function computeMissionSkyline(
  tasks: Array<{ workers?: WorkerSpan[] }>,
  opts?: { missionCompletedAt?: Date | string | null; now?: number },
): MissionSkylineData | null {
  const now = opts?.now ?? Date.now();

  // Collect valid worker time spans
  const spans: Array<{ startMs: number; endMs: number; state: SkylineBlockState }> = [];
  for (const task of tasks) {
    for (const w of task.workers ?? []) {
      if (!w.startedAt) continue;
      const startMs = new Date(w.startedAt as string).getTime();
      const endMs = workerEndMs(w, now);
      if (endMs <= startMs) continue;
      spans.push({ startMs, endMs, state: workerBlockState(w) });
    }
  }
  if (spans.length === 0) return null;

  const missionStartMs = Math.min(...spans.map((s) => s.startMs));
  const lastEndMs = Math.max(...spans.map((s) => s.endMs));
  const activeSpanMin = (lastEndMs - missionStartMs) / 60_000;
  const agentTimeMin = spans.reduce((acc, s) => acc + (s.endMs - s.startMs) / 60_000, 0);
  const totalSlots = Math.max(1, Math.ceil((lastEndMs - missionStartMs) / SKYLINE_SLOT_MS));

  // ── Lane assignment from raw ms spans ─────────────────────────────────────
  // Using raw milliseconds (not quantized slots) avoids the sub-slot artifact
  // where multiple sequential workers all collapse to [0,1) and appear concurrent.
  // Sort by startMs then endMs for stable greedy packing.
  const sortedByMs = spans
    .map((s, i) => ({ ...s, originalIdx: i }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const laneEndMs: number[] = [];
  const spanLanes = new Array<number>(spans.length);
  for (const span of sortedByMs) {
    // A lane is free when its last occupant ended at or before this span's start.
    // end <= start means abutting sequential workers go to the same lane (not concurrent).
    let lane = laneEndMs.findIndex((end) => end <= span.startMs);
    if (lane === -1) {
      lane = laneEndMs.length;
      laneEndMs.push(0);
    }
    laneEndMs[lane] = span.endMs;
    spanLanes[span.originalIdx] = lane;
  }

  const peakLanes = laneEndMs.length;
  const foldedLanes = Math.max(0, peakLanes - SKYLINE_MAX_LANES);

  // ── Peak concurrency via sweep-line over raw ms events ────────────────────
  // Encode end=ms*2, start=ms*2+1 so end events sort before start events at
  // equal timestamps — abutting sequential workers (A ends at T, B starts at T)
  // are NOT counted as concurrent.
  const msEvents: Array<[number, number]> = [];
  for (const s of spans) {
    msEvents.push([s.endMs * 2, -1]);
    msEvents.push([s.startMs * 2 + 1, +1]);
  }
  msEvents.sort((a, b) => a[0] - b[0]);
  let concurrent = 0;
  let peakConcurrency = 0;
  for (const [, delta] of msEvents) {
    concurrent += delta;
    if (concurrent > peakConcurrency) peakConcurrency = concurrent;
  }

  const parallelFactor = activeSpanMin > 0 ? agentTimeMin / activeSpanMin : 1;

  // Invariant: real concurrency implies parallel factor above 1.0.
  // A violation means the ms-based and duration-based math have diverged.
  if (process.env.NODE_ENV !== 'production' && peakConcurrency > 1 && parallelFactor <= 1) {
    console.error(
      '[mission-invariant] peakConcurrency=%d but parallelFactor=%f — concurrency and duration math have diverged',
      peakConcurrency,
      parallelFactor,
    );
  }

  // ── Slot quantization (rendering only) ───────────────────────────────────
  // Slots drive block geometry; the 1-slot minimum keeps short blocks visible.
  // Lane comes from the ms-derived assignment above.
  const slottedSpans = spans.map((s, i) => {
    const startSlot = Math.floor((s.startMs - missionStartMs) / SKYLINE_SLOT_MS);
    const rawEnd = Math.ceil((s.endMs - missionStartMs) / SKYLINE_SLOT_MS);
    const endSlot = Math.max(startSlot + 1, rawEnd);
    return { startSlot, endSlot, state: s.state, lane: spanLanes[i] };
  });

  // ── Build blocks, merging overlapping rects within each lane ─────────────
  // Sequential sub-slot workers share a lane and quantize to the same slot
  // interval (e.g. all map to [0,1)). Merge strictly-overlapping slot ranges
  // within each lane so they don't produce stacked render rects.
  const spansByLane = new Map<number, typeof slottedSpans>();
  for (const s of slottedSpans) {
    if (!spansByLane.has(s.lane)) spansByLane.set(s.lane, []);
    spansByLane.get(s.lane)!.push(s);
  }

  const blocks: SkylineBlock[] = [];
  for (const [lane, laneSpans] of spansByLane) {
    laneSpans.sort((a, b) => a.startSlot - b.startSlot || a.endSlot - b.endSlot);
    let cur = { lane, startSlot: laneSpans[0].startSlot, endSlot: laneSpans[0].endSlot, state: laneSpans[0].state };
    for (let i = 1; i < laneSpans.length; i++) {
      const next = laneSpans[i];
      if (next.startSlot < cur.endSlot) {
        // Overlapping slots — merge, taking the last block's state as the most recent outcome
        cur = { lane, startSlot: cur.startSlot, endSlot: Math.max(cur.endSlot, next.endSlot), state: next.state };
      } else {
        blocks.push(cur);
        cur = { lane, startSlot: next.startSlot, endSlot: next.endSlot, state: next.state };
      }
    }
    blocks.push(cur);
  }

  // Review tail: time from last worker end to mission close (or now)
  const missionEndMs = opts?.missionCompletedAt
    ? new Date(opts.missionCompletedAt as string).getTime()
    : null;
  const tailMs = missionEndMs !== null ? missionEndMs - lastEndMs : null;
  const reviewTailMin = tailMs !== null && tailMs > 5 * 60_000 ? tailMs / 60_000 : null;

  return {
    totalSlots,
    blocks,
    peakLanes,
    foldedLanes,
    activeSpanMin,
    agentTimeMin,
    parallelFactor,
    peakConcurrency,
    reviewTailMin,
  };
}
