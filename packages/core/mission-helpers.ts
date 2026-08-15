import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, InitiativeKPI, InitiativeKPIState } from '@buildd/shared';
export type { GoalCriterion, GoalCriteriaState, CriterionVerdict, InitiativeKPI, InitiativeKPIState };

// ─── Task type detection ───────────────────────────────────────────────────────

/** Derived task subtypes for display (no schema change — derived from title prefix + parentTaskId). */
export type TaskType = 'retry' | 'review' | 'review-retry';

/**
 * Derive a task's display type from its title prefix and parentTaskId.
 * Returns null for primary tasks (parentTaskId IS NULL).
 * Falls back to 'retry' for attempt tasks with unrecognized or absent prefix.
 */
export function deriveTaskType(task: {
  title: string;
  parentTaskId?: string | null;
}): TaskType | null {
  if (!task.parentTaskId) return null;
  if (/^\[reviewer retry/i.test(task.title)) return 'review-retry';
  if (/^\[reviewer\]/i.test(task.title)) return 'review';
  if (/^\[(?:CI )?retry/i.test(task.title)) return 'retry';
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
        const requireBranchDeleted = criterion.requireBranchDeleted !== false;
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
        // Free-form criteria require LLM evaluation against mission evidence.
        // The pure evaluator returns UNVERIFIED; the evaluate route upgrades
        // verdicts with an LLM call when ANTHROPIC_API_KEY is available.
        verdict = 'UNVERIFIED';
        evidence = `Pending evidence-based evaluation: "${criterion.description}"`;
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

  const overall: CriterionVerdict =
    results.every(r => r.verdict === 'pass') ? 'pass'
    : results.some(r => r.verdict === 'fail') ? 'fail'
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

// ─── Deliverable predicate ────────────────────────────────────────────────────

/**
 * Returns true if the task counts as a deliverable for mission progress.
 * Coordination tasks and auto-generated housekeeping titles are excluded.
 */
export function isDeliverableTask(task: {
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
  category?: string | null;
}): boolean {
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
 * - Attempt tasks (parentTaskId IS NOT NULL, e.g. CI retries) are collapsed into
 *   their parent: the parent's effective status is the best outcome across all
 *   attempts. Attempts do not count as separate deliverables.
 *
 * When tasks include an `id` and optional `workers`, the return value also
 * contains per-task `segments` for the projected progress bar.
 */
export function computeMissionProgress(tasks: Array<{
  id?: string;
  status: string;
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
  category?: string | null;
  parentTaskId?: string | null;
  workers?: Array<{ status: string; prUrl?: string | null; mergedAt?: string | Date | null }>;
}>): { totalTasks: number; completedTasks: number; progress: number; segments: MissionSegment[] } {
  // Collapse attempt tasks (parentTaskId IS NOT NULL) under their parents so
  // a CI retry or reviewer run does not inflate the deliverable count.
  const childrenMap = new Map<string, typeof tasks>();
  const rootTasks = tasks.filter(t => {
    if (t.parentTaskId) {
      if (!childrenMap.has(t.parentTaskId)) childrenMap.set(t.parentTaskId, []);
      childrenMap.get(t.parentTaskId)!.push(t);
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

  // Convert each span to slot coordinates
  const slotSpans = spans.map((s) => {
    const startSlot = Math.floor((s.startMs - missionStartMs) / SKYLINE_SLOT_MS);
    const rawEnd = Math.ceil((s.endMs - missionStartMs) / SKYLINE_SLOT_MS);
    const endSlot = Math.max(startSlot + 1, rawEnd); // minimum 1 slot
    return { startSlot, endSlot, state: s.state };
  });

  // Sort by start, then end (ascending) for stable greedy packing
  slotSpans.sort((a, b) => a.startSlot - b.startSlot || a.endSlot - b.endSlot);

  // Greedy lane packing
  const laneEndSlot: number[] = [];
  const blocks: SkylineBlock[] = [];
  for (const span of slotSpans) {
    let lane = laneEndSlot.findIndex((end) => end <= span.startSlot);
    if (lane === -1) {
      lane = laneEndSlot.length;
      laneEndSlot.push(0);
    }
    laneEndSlot[lane] = span.endSlot;
    blocks.push({ lane, startSlot: span.startSlot, endSlot: span.endSlot, state: span.state });
  }

  const peakLanes = laneEndSlot.length;
  const foldedLanes = Math.max(0, peakLanes - SKYLINE_MAX_LANES);

  // Peak concurrency via sweep-line over slot events.
  // Encode end=slot*2, start=slot*2+1 so end events sort before start events
  // at the same slot boundary — sequential workers (A ends at slot N, B starts
  // at slot N) are NOT counted as concurrent.
  const events: Array<[number, number]> = [];
  for (const s of slotSpans) {
    events.push([s.endSlot * 2, -1]); // end before any start at same slot
    events.push([s.startSlot * 2 + 1, +1]); // start after any end at same slot
  }
  events.sort((a, b) => a[0] - b[0]);
  let concurrent = 0;
  let peakConcurrency = 0;
  for (const [, delta] of events) {
    concurrent += delta;
    if (concurrent > peakConcurrency) peakConcurrency = concurrent;
  }

  const parallelFactor = activeSpanMin > 0 ? agentTimeMin / activeSpanMin : 1;

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
