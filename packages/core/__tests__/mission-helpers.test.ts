import { describe, it, expect } from 'bun:test';
import { isDeliverableTask, hasPendingDeliverableWork, computeMissionProgress, deriveMissionProgressMetric, deriveTaskType, deriveCriteriaGatePresentation, deriveHumanTaskShareMetric, deriveMissionFollowupMetric, computeMissionAuthorshipHealth, deriveWorkLane, hasNoWorkLaneData, type MissionSegmentState } from '../mission-helpers';

// ── deriveTaskType ─────────────────────────────────────────────────────────────

describe('deriveTaskType', () => {
  it('returns null for a root task (no parentTaskId)', () => {
    expect(deriveTaskType({ title: 'Build feature', parentTaskId: null })).toBeNull();
  });

  it('returns null for a root task without mode', () => {
    expect(deriveTaskType({ title: 'Build feature' })).toBeNull();
  });

  it('returns review-retry for [reviewer retry] prefix', () => {
    expect(deriveTaskType({ title: '[reviewer retry #1] Build feature', parentTaskId: 'parent' })).toBe('review-retry');
  });

  it('returns review for [reviewer] prefix', () => {
    expect(deriveTaskType({ title: '[reviewer] Build feature', parentTaskId: 'parent' })).toBe('review');
  });

  it('returns retry for [CI Retry] prefix', () => {
    expect(deriveTaskType({ title: '[CI Retry #1] Build feature', parentTaskId: 'parent' })).toBe('retry');
  });

  it('returns retry for [Retry] prefix', () => {
    expect(deriveTaskType({ title: '[Retry #2] Build feature', parentTaskId: 'parent' })).toBe('retry');
  });

  it('returns retry fallback for parentTaskId with no recognized prefix and no mode', () => {
    expect(deriveTaskType({ title: 'Some unlabeled task', parentTaskId: 'parent' })).toBe('retry');
  });

  // Spawned builder tasks created by approve_plan: mode='execution', no recognized prefix
  it('returns null for mode=execution task (spawned builder, distinct deliverable)', () => {
    expect(deriveTaskType({ title: 'feat: /api/models route', parentTaskId: 'planning-task', mode: 'execution' })).toBeNull();
  });

  it('returns null for mode=execution regardless of parentTaskId presence', () => {
    expect(deriveTaskType({ title: 'chore: registry hygiene', parentTaskId: 'plan', mode: 'execution' })).toBeNull();
  });

  // Recognized prefix takes priority over mode
  it('[reviewer retry] prefix takes priority even if mode=execution', () => {
    expect(deriveTaskType({ title: '[reviewer retry #1] feat', parentTaskId: 'p', mode: 'execution' })).toBe('review-retry');
  });

  it('[CI Retry] prefix takes priority even if mode=execution', () => {
    expect(deriveTaskType({ title: '[CI Retry #1] feat', parentTaskId: 'p', mode: 'execution' })).toBe('retry');
  });

  it('mode=planning is not treated as execution (still fallback retry if parentTaskId set)', () => {
    // planning tasks with parentTaskId would be unusual but should not be classified as spawned
    expect(deriveTaskType({ title: 'Mission: plan', parentTaskId: 'parent', mode: 'planning' })).toBe('retry');
  });
});

describe('isDeliverableTask', () => {
  it('returns true for a normal task with no special kind or title', () => {
    expect(isDeliverableTask({ title: 'Build the auth module', kind: 'engineering' })).toBe(true);
  });

  it('returns true when kind and title are both null', () => {
    expect(isDeliverableTask({ kind: null, title: null })).toBe(true);
  });

  it('returns true for undefined kind and title', () => {
    expect(isDeliverableTask({})).toBe(true);
  });

  it('returns false for coordination kind', () => {
    expect(isDeliverableTask({ kind: 'coordination', title: 'Coordinate work' })).toBe(false);
  });

  it('returns false for title starting with "Aggregate results:"', () => {
    expect(isDeliverableTask({ title: 'Aggregate results: Mission sprint' })).toBe(false);
  });

  it('returns false for title starting with "Mission:"', () => {
    expect(isDeliverableTask({ title: 'Mission: Build feature X' })).toBe(false);
  });

  it('returns false for title starting with "Close mission"', () => {
    expect(isDeliverableTask({ title: 'Close mission — Sprint 4' })).toBe(false);
  });

  it('returns true for a title that contains but does not start with "Mission:"', () => {
    expect(isDeliverableTask({ title: 'Update the Mission: docs' })).toBe(true);
  });

  it('returns true for a task with a non-coordination kind', () => {
    expect(isDeliverableTask({ kind: 'research', title: 'Investigate caching strategy' })).toBe(true);
  });

  it('uses kind=coordination as the first gate even when title is normal', () => {
    expect(isDeliverableTask({ kind: 'coordination', title: 'Normal-looking title' })).toBe(false);
  });

  it('ignores creationSource when deciding deliverability', () => {
    expect(isDeliverableTask({ creationSource: 'schedule', title: 'Weekly sync report' })).toBe(true);
  });

  it('returns false for reviewer tasks (category="review")', () => {
    expect(isDeliverableTask({ category: 'review', title: '[reviewer] PR #42: feat: add auth' })).toBe(false);
  });

  it('returns true when category is undefined (backwards-compatible)', () => {
    expect(isDeliverableTask({ title: 'Build the feature' })).toBe(true);
  });
});

describe('isDeliverableTask — progress calculation', () => {
  function calcProgress(tasks: Array<{ kind?: string | null; title?: string | null; creationSource?: string | null; status: string }>) {
    const deliverable = tasks.filter(isDeliverableTask);
    const total = deliverable.length;
    const completed = deliverable.filter(t => t.status === 'completed').length;
    return total > 0 ? Math.round((completed / total) * 100) : 0;
  }

  it('returns 0 when there are no tasks at all', () => {
    expect(calcProgress([])).toBe(0);
  });

  it('returns 0 when all tasks are housekeeping (no deliverables)', () => {
    const tasks = [
      { kind: 'coordination', title: 'Coordinate', status: 'completed' },
      { title: 'Aggregate results: sprint', status: 'completed' },
      { title: 'Mission: plan', status: 'completed' },
    ];
    expect(calcProgress(tasks)).toBe(0);
  });

  it('computes correct progress ignoring housekeeping tasks', () => {
    const tasks = [
      { title: 'Build feature A', status: 'completed' },
      { title: 'Build feature B', status: 'pending' },
      { kind: 'coordination', title: 'Coordinate', status: 'completed' },
      { title: 'Aggregate results: done', status: 'completed' },
      { title: 'Mission: init', status: 'completed' },
    ];
    // Only 2 deliverable tasks, 1 completed → 50%
    expect(calcProgress(tasks)).toBe(50);
  });

  it('returns 100 when all deliverable tasks are completed', () => {
    const tasks = [
      { title: 'Build feature A', status: 'completed' },
      { title: 'Build feature B', status: 'completed' },
      { kind: 'coordination', title: 'Orchestrate', status: 'pending' },
    ];
    expect(calcProgress(tasks)).toBe(100);
  });
});

// ── computeMissionProgress ───────────────────────────────────────────────────

describe('computeMissionProgress', () => {
  type Task = Parameters<typeof computeMissionProgress>[0][number];

  function makeTask(
    status: string,
    title = 'Do some work',
    opts: { kind?: string; mode?: string } = {},
  ): Task {
    return { status, title, ...opts };
  }

  it('returns 0 progress with no tasks', () => {
    const result = computeMissionProgress([]);
    expect(result.totalTasks).toBe(0);
    expect(result.completedTasks).toBe(0);
    expect(result.progress).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it('reaches 100% when all non-cancelled deliverables are completed', () => {
    const tasks = [
      makeTask('completed'),
      makeTask('cancelled'),
      makeTask('cancelled'),
      makeTask('cancelled'),
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('counts failed tasks against progress (failed = unfinished intended work)', () => {
    const tasks = [
      makeTask('completed'),
      makeTask('failed'),
      makeTask('cancelled'),
    ];
    // cancelled excluded → 2 countable (completed + failed), 1 done → 50%
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(2);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(50);
  });

  it('returns 0 when only cancelled tasks exist (empty denominator)', () => {
    const tasks = [makeTask('cancelled'), makeTask('cancelled')];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(0);
    expect(result.completedTasks).toBe(0);
    expect(result.progress).toBe(0);
  });

  it('handles mixed statuses: in_progress counted but not completed', () => {
    const tasks = [
      makeTask('completed'),
      makeTask('completed'),
      makeTask('in_progress'),
      makeTask('cancelled'),
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(3);
    expect(result.completedTasks).toBe(2);
    expect(result.progress).toBe(67);
  });

  it('excludes planning/housekeeping tasks from denominator', () => {
    const tasks = [
      makeTask('completed'),
      makeTask('completed', 'Mission: Organizer', { mode: 'planning' }),
      makeTask('pending', 'Aggregate results: sprint 1'),
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('excludes cancelled AND planning tasks together', () => {
    const tasks = [
      makeTask('completed', 'Implement feature A'),
      makeTask('cancelled', 'Implement feature A (duplicate)'),
      makeTask('cancelled', 'Implement feature A (duplicate 2)'),
      makeTask('completed', 'Mission: Planner', { mode: 'planning' }),
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('returns 0 when only planning tasks exist (none deliverable)', () => {
    const tasks = [makeTask('completed', 'Mission: Planner', { mode: 'planning' })];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(0);
    expect(result.progress).toBe(0);
  });

  it('rounds to nearest integer', () => {
    const tasks = [makeTask('completed'), makeTask('completed'), makeTask('pending')];
    expect(computeMissionProgress(tasks).progress).toBe(67);
  });

  // ── attempt collapse (parentTaskId) ──────────────────────────────────────────

  it('CI retry success: parent failed + child completed → 1 completed task', () => {
    const tasks: Task[] = [
      { id: 'parent', status: 'failed', title: 'Implement feature' },
      { id: 'retry', status: 'completed', title: '[CI Retry #1] Implement feature', parentTaskId: 'parent' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('CI retry failure: parent failed + child failed → 1 failed task', () => {
    const tasks: Task[] = [
      { id: 'parent', status: 'failed', title: 'Implement feature' },
      { id: 'retry', status: 'failed', title: '[CI Retry #1] Implement feature', parentTaskId: 'parent' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    expect(result.progress).toBe(0);
  });

  it('CI retry in progress: parent failed + child pending → 1 pending task', () => {
    const tasks: Task[] = [
      { id: 'parent', status: 'failed', title: 'Implement feature' },
      { id: 'retry', status: 'pending', title: '[CI Retry #1] Implement feature', parentTaskId: 'parent' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    expect(result.progress).toBe(0);
  });

  it('reviewer task does not inflate count', () => {
    const tasks: Task[] = [
      { id: 'original', status: 'completed', title: 'Implement feature' },
      { id: 'reviewer', status: 'completed', category: 'review', parentTaskId: 'original' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('approve_plan execution tasks count as separate deliverables even with parentTaskId', () => {
    // Orchestrator creates a planning task, then approve_plan spawns execution-mode builders.
    // All builders have parentTaskId=planningTaskId but must count individually.
    const tasks: Task[] = [
      { id: 'plan', status: 'completed', title: 'Mission: Build the feature', mode: 'planning' },
      { id: 'b1', status: 'completed', title: 'Build auth module', mode: 'execution', parentTaskId: 'plan' },
      { id: 'b2', status: 'completed', title: 'Build API layer', mode: 'execution', parentTaskId: 'plan' },
      { id: 'b3', status: 'pending', title: 'Write tests', mode: 'execution', parentTaskId: 'plan' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(3);
    expect(result.completedTasks).toBe(2);
    expect(result.progress).toBe(67);
  });

  it('retry of an execution task is still collapsed (parentTaskId + no execution mode)', () => {
    const tasks: Task[] = [
      { id: 'b1', status: 'failed', title: 'Build auth module', mode: 'execution', parentTaskId: 'plan' },
      { id: 'b1-retry', status: 'completed', title: '[CI Retry #1] Build auth module', parentTaskId: 'b1' },
    ];
    const result = computeMissionProgress(tasks);
    // b1 is execution → counts; b1-retry has no mode=execution → collapsed into b1
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('orphaned attempt (no parent in list) does not appear in results', () => {
    // Parent was filtered out by caller; orphaned child should not count
    const tasks: Task[] = [
      { id: 'retry', status: 'completed', title: '[CI Retry #1] Feature', parentTaskId: 'missing-parent' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(0);
    expect(result.completedTasks).toBe(0);
    expect(result.progress).toBe(0);
  });

  // ── spawned builder tasks (approve_plan) ──────────────────────────────────────

  it('spawned builder tasks (mode=execution) count as separate deliverables, not attempts', () => {
    const tasks: Task[] = [
      { id: 'plan', status: 'completed', title: 'Mission: Build API', mode: 'planning' },
      { id: 'b1', status: 'completed', title: 'feat: route', mode: 'execution', parentTaskId: 'plan' },
      { id: 'b2', status: 'completed', title: 'feat: component', mode: 'execution', parentTaskId: 'plan' },
      { id: 'b3', status: 'completed', title: 'chore: cleanup', mode: 'execution', parentTaskId: 'plan' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(3);
    expect(result.completedTasks).toBe(3);
    expect(result.progress).toBe(100);
  });

  it('regression: mission 83e86c15 shape — 3 spawned builders + 4 reviewer/retry + 2 bookkeeping → totalTasks=3', () => {
    // Mirrors the shape of the real mission that exposed the overcorrection
    const tasks: Task[] = [
      // Planning/orchestrator task — bookkeeping, not a deliverable
      { id: 'plan', status: 'completed', title: 'Mission: Tier-first model selection', mode: 'planning' },
      // 3 spawned builder tasks via approve_plan
      { id: 'b1', status: 'completed', title: 'feat: /api/models route', mode: 'execution', parentTaskId: 'plan',
        workers: [{ status: 'completed', prUrl: 'https://github.com/pr/1598', mergedAt: '2025-01-01' }] },
      { id: 'b2', status: 'completed', title: 'feat: tier-first ModelPicker', mode: 'execution', parentTaskId: 'plan',
        workers: [{ status: 'completed', prUrl: 'https://github.com/pr/1599', mergedAt: '2025-01-02' }] },
      { id: 'b3', status: 'completed', title: 'chore: registry hygiene', mode: 'execution', parentTaskId: 'plan',
        workers: [{ status: 'completed', prUrl: 'https://github.com/pr/1597', mergedAt: '2025-01-03' }] },
      // 4 reviewer / retry tasks — attempts, not deliverables
      { id: 'r1', status: 'completed', title: '[reviewer] feat: /api/models', category: 'review', parentTaskId: 'b1' },
      { id: 'r2', status: 'completed', title: '[reviewer] feat: tier-first', category: 'review', parentTaskId: 'b2' },
      { id: 'r3', status: 'completed', title: '[reviewer] chore: registry', category: 'review', parentTaskId: 'b3' },
      { id: 'r4', status: 'completed', title: '[reviewer retry #1] chore: registry', category: 'review', parentTaskId: 'b3' },
      // Aggregate results — bookkeeping
      { id: 'agg', status: 'completed', title: 'Aggregate results: Tier-first model selection' },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(3);
    expect(result.completedTasks).toBe(3);
    expect(result.progress).toBe(100);
    // Each builder task gets its own segment
    expect(result.segments).toHaveLength(3);
    const segmentIds = result.segments.map(s => s.taskId).sort();
    expect(segmentIds).toEqual(['b1', 'b2', 'b3'].sort());
  });

  it('spawned builder tasks retain their own workers (not merged into planning task)', () => {
    const tasks: Task[] = [
      { id: 'plan', status: 'completed', title: 'Mission: plan', mode: 'planning' },
      { id: 'b1', status: 'completed', title: 'feat: route', mode: 'execution', parentTaskId: 'plan',
        workers: [{ status: 'completed', prUrl: 'https://github.com/pr/1', mergedAt: '2025-01-01' }] },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.segments[0].state).toBe('solid'); // has merged PR → solid
  });

  it('CI retry of a spawned builder task still collapses correctly', () => {
    // Builder task failed, then retried via [CI Retry #1]
    const tasks: Task[] = [
      { id: 'plan', status: 'completed', title: 'Mission: plan', mode: 'planning' },
      { id: 'b1', status: 'failed', title: 'feat: route', mode: 'execution', parentTaskId: 'plan' },
      { id: 'retry', status: 'completed', title: '[CI Retry #1] feat: route', parentTaskId: 'b1' },
    ];
    const result = computeMissionProgress(tasks);
    // b1 is a spawned deliverable; retry is an attempt under b1; net: 1 task, completed
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  // ── orchestrator-completed case ───────────────────────────────────────────────

  it('planning task with a merged PR counts as a done deliverable (orchestrator mode)', () => {
    const tasks: Task[] = [
      {
        id: 'plan',
        status: 'completed',
        title: 'Mission: Build API',
        mode: 'planning',
        workers: [{ status: 'completed', prUrl: 'https://github.com/org/repo/pull/42', mergedAt: '2025-01-01' }],
      },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('planning task with an UNmerged PR counts as a deliverable but not done — awaiting merge', () => {
    const tasks: Task[] = [
      {
        id: 'plan',
        status: 'completed',
        title: 'Mission: Build API',
        mode: 'planning',
        workers: [{ status: 'completed', prUrl: 'https://github.com/org/repo/pull/42', mergedAt: null }],
      },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    expect(result.awaitingMerge).toBe(1);
    expect(result.progress).toBe(0);
  });

  it('planning task without a PR is still excluded', () => {
    const tasks: Task[] = [
      { id: 'plan', status: 'completed', title: 'Mission: Build API', mode: 'planning', workers: [] },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(0);
    expect(result.progress).toBe(0);
  });

  // ── call-site consistency ─────────────────────────────────────────────────────
  // Every surface (list route, detail route, RSC page, initiative rollup) must
  // pass taskClass to computeMissionProgress so the fast path runs. These tests
  // verify that the fast path and fallback heuristics agree on the canonical cases.

  it('taskClass fast-path agrees with fallback for work tasks', () => {
    // Same tasks: once with taskClass set (fast path), once without (fallback).
    const tasksWithClass: Task[] = [
      { id: 't1', status: 'completed', taskClass: 'work' },
      { id: 't2', status: 'pending',   taskClass: 'work' },
    ];
    const tasksWithoutClass: Task[] = [
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'pending' },
    ];
    const withClass    = computeMissionProgress(tasksWithClass);
    const withoutClass = computeMissionProgress(tasksWithoutClass);
    expect(withClass.totalTasks).toBe(withoutClass.totalTasks);
    expect(withClass.completedTasks).toBe(withoutClass.completedTasks);
    expect(withClass.progress).toBe(withoutClass.progress);
  });

  it('taskClass fast-path excludes bookkeeping that fallback would miss without kind/title markers', () => {
    // A bookkeeping task with no kind/title/mode signal — only taskClass distinguishes it.
    const tasksWithClass: Task[] = [
      { id: 'w1', status: 'completed', taskClass: 'work' },
      { id: 'bk', status: 'completed', taskClass: 'bookkeeping' }, // excluded via fast path
    ];
    const result = computeMissionProgress(tasksWithClass);
    expect(result.totalTasks).toBe(1);   // only w1 counts
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('taskClass fast-path excludes attempt tasks that fallback would miss without prefix/parentTaskId', () => {
    const tasksWithClass: Task[] = [
      { id: 'w1', status: 'failed',   taskClass: 'work' },
      { id: 'at', status: 'completed', taskClass: 'attempt', parentTaskId: 'w1' }, // collapses into w1
    ];
    const result = computeMissionProgress(tasksWithClass);
    // w1 is root; at collapses under it — effective status is 'completed' (best of failed/completed)
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
  });
});

// ── computeMissionProgress — segments ────────────────────────────────────────

describe('computeMissionProgress — segments', () => {
  type TaskInput = Parameters<typeof computeMissionProgress>[0][number];

  function makeTaskWithWorkers(
    id: string,
    status: string,
    workers: Array<{
      status: string;
      prUrl?: string | null;
      mergedAt?: string | null;
      prLifecycleStatus?: string | null;
      supersededByPrNumber?: number | null;
    }> = [],
    opts: { kind?: string } = {},
  ): TaskInput {
    return { id, status, title: 'Do some work', workers, ...opts };
  }

  it('returns an empty segments array when no countable tasks', () => {
    const result = computeMissionProgress([]);
    expect(result.segments).toEqual([]);
  });

  it('cancelled tasks are excluded from segments', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'cancelled'),
      makeTaskWithWorkers('b', 'completed'),
    ];
    const { segments } = computeMissionProgress(tasks);
    expect(segments).toHaveLength(1);
    expect(segments[0].taskId).toBe('b');
  });

  it('solid — completed with merged PR', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'completed', [{ status: 'completed', prUrl: 'https://github.com/pr/1', mergedAt: '2025-01-01' }]),
    ];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('solid');
  });

  it('solid — completed with no PR at all', () => {
    const tasks = [makeTaskWithWorkers('a', 'completed', [{ status: 'completed', prUrl: null }])];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('solid');
  });

  it('solid — completed with no workers', () => {
    const tasks = [makeTaskWithWorkers('a', 'completed', [])];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('solid');
  });

  it('half — completed with open (unmerged) PR', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'completed', [{ status: 'completed', prUrl: 'https://github.com/pr/2', mergedAt: null }]),
    ];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('half');
  });

  it('half — awaitingMerge counts it, completedTasks does not (AC-2)', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'completed', [{ status: 'completed', prUrl: 'https://github.com/pr/2020', mergedAt: null, prLifecycleStatus: 'pr_open' }]),
    ];
    const result = computeMissionProgress(tasks);
    expect(result.segments[0].state).toBe<MissionSegmentState>('half');
    expect(result.completedTasks).toBe(0);
    expect(result.awaitingMerge).toBe(1);
    expect(result.progress).toBe(0);
  });

  it('notch — closed PR without merging is not "awaiting merge" (AC-4: renders as its own dead-end, not done)', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'completed', [{ status: 'completed', prUrl: 'https://github.com/pr/3', mergedAt: null, prLifecycleStatus: 'closed' }]),
    ];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('notch');
  });

  it('solid — closed PR recorded as superseded by a merged PR counts as done, not a dead end (task fcaf83d5)', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'completed', [{
        status: 'completed',
        prUrl: 'https://github.com/pr/2287',
        mergedAt: null,
        prLifecycleStatus: 'closed',
        supersededByPrNumber: 2293,
      }]),
    ];
    const result = computeMissionProgress(tasks);
    expect(result.segments[0].state).toBe<MissionSegmentState>('solid');
    expect(result.completedTasks).toBe(1);
    expect(result.awaitingMerge).toBe(0);
  });

  it('ghost — task has a live worker (running)', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'in_progress', [{ status: 'running', prUrl: null }]),
    ];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('ghost');
  });

  it('ghost — task has a live worker (waiting_input)', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'in_progress', [{ status: 'waiting_input', prUrl: null }]),
    ];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('ghost');
  });

  it('ghost — live worker takes precedence over completed status', () => {
    // Shouldn't happen in practice but the live-worker signal wins
    const tasks = [
      makeTaskWithWorkers('a', 'completed', [{ status: 'running', prUrl: null }]),
    ];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('ghost');
  });

  it('notch — failed task', () => {
    const tasks = [makeTaskWithWorkers('a', 'failed')];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('notch');
  });

  it('empty — pending task with no workers', () => {
    const tasks = [makeTaskWithWorkers('a', 'pending')];
    const { segments } = computeMissionProgress(tasks);
    expect(segments[0].state).toBe<MissionSegmentState>('empty');
  });

  it('progress percentages unchanged when segments are added', () => {
    const tasks = [
      makeTaskWithWorkers('a', 'completed'),
      makeTaskWithWorkers('b', 'completed'),
      makeTaskWithWorkers('c', 'pending'),
      makeTaskWithWorkers('d', 'cancelled'),
    ];
    const result = computeMissionProgress(tasks);
    expect(result.progress).toBe(67);
    expect(result.totalTasks).toBe(3);
    expect(result.completedTasks).toBe(2);
    expect(result.segments).toHaveLength(3);
  });

  it('mixed segment states in one mission', () => {
    const tasks = [
      makeTaskWithWorkers('solid-id', 'completed', [{ status: 'completed', prUrl: 'p', mergedAt: '2025-01-01' }]),
      makeTaskWithWorkers('half-id', 'completed', [{ status: 'completed', prUrl: 'p', mergedAt: null }]),
      makeTaskWithWorkers('ghost-id', 'in_progress', [{ status: 'running', prUrl: null }]),
      makeTaskWithWorkers('empty-id', 'pending'),
      makeTaskWithWorkers('notch-id', 'failed'),
    ];
    const { segments } = computeMissionProgress(tasks);
    const stateMap = Object.fromEntries(segments.map(s => [s.taskId, s.state]));
    expect(stateMap['solid-id']).toBe('solid');
    expect(stateMap['half-id']).toBe('half');
    expect(stateMap['ghost-id']).toBe('ghost');
    expect(stateMap['empty-id']).toBe('empty');
    expect(stateMap['notch-id']).toBe('notch');
  });
});

describe('deriveMissionProgressMetric', () => {
  const work = (status: string) => ({ taskClass: 'work' as const, status });

  it('returns unavailable with reason no_scope when no countable tasks', () => {
    const result = deriveMissionProgressMetric([]);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('no_scope');
  });

  it('returns unavailable when all tasks are cancelled', () => {
    const result = deriveMissionProgressMetric([work('cancelled')]);
    expect(result.kind).toBe('unavailable');
  });

  it('returns value 0 when tasks exist but none completed', () => {
    const result = deriveMissionProgressMetric([work('pending'), work('pending')]);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value).toBe(0);
  });

  it('returns value 100 when all tasks completed', () => {
    const result = deriveMissionProgressMetric([work('completed'), work('completed')]);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value).toBe(100);
  });

  it('returns actual ratio — does not force 100 for a completed mission', () => {
    // Simulate: mission marked completed but 1 of 2 tasks finished
    const result = deriveMissionProgressMetric([work('completed'), work('pending')]);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value).toBe(50);
  });

  it('rounds to nearest integer', () => {
    // 1 of 3 completed = 33.33...%
    const result = deriveMissionProgressMetric([work('completed'), work('pending'), work('pending')]);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value).toBe(33);
  });
});

// ── Authorship health: human task share + post-completion follow-ups ──────────

describe('deriveHumanTaskShareMetric', () => {
  const MISSION_START = '2025-01-01T00:00:00Z';
  const agentTask = (createdAt: string) => ({
    taskClass: 'work' as const, createdByWorkerId: 'worker-1', createdByAccountId: null, createdAt,
  });
  const humanTask = (createdAt: string) => ({
    taskClass: 'work' as const, createdByWorkerId: null, createdByAccountId: 'account-1', createdAt,
  });

  it('returns unavailable with reason no_scope when there are no countable tasks', () => {
    const result = deriveHumanTaskShareMetric([], MISSION_START);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('no_scope');
  });

  it('excludes attempt tasks from the denominator', () => {
    const attempt = { taskClass: 'attempt' as const, createdByWorkerId: null, createdByAccountId: 'account-1', createdAt: MISSION_START };
    const result = deriveHumanTaskShareMetric([attempt], MISSION_START);
    expect(result.kind).toBe('unavailable');
  });

  it('counts bookkeeping tasks toward the denominator alongside work', () => {
    const bookkeeping = { taskClass: 'bookkeeping' as const, createdByWorkerId: 'worker-1', createdByAccountId: null, createdAt: MISSION_START };
    const result = deriveHumanTaskShareMetric([bookkeeping], MISSION_START);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value.totalCount).toBe(1);
  });

  it('splits human tasks into at-start (<2h) and mid-flight (>=2h)', () => {
    const tasks = [
      agentTask(MISSION_START),
      humanTask('2025-01-01T00:30:00Z'), // 30 min after start — at start
      humanTask('2025-01-01T05:00:00Z'), // 5h after start — mid-flight
    ];
    const result = deriveHumanTaskShareMetric(tasks, MISSION_START);
    expect(result.kind).toBe('value');
    if (result.kind !== 'value') return;
    expect(result.value.humanCount).toBe(2);
    expect(result.value.totalCount).toBe(3);
    expect(result.value.atStart).toBe(1);
    expect(result.value.midFlight).toBe(1);
    expect(result.value.pct).toBe(67);
  });

  it('reports 0% when every countable task is agent-authored', () => {
    const result = deriveHumanTaskShareMetric([agentTask(MISSION_START), agentTask(MISSION_START)], MISSION_START);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value.pct).toBe(0);
  });
});

describe('deriveMissionFollowupMetric', () => {
  it('returns unavailable with reason no_baseline when the mission has no completedAt', () => {
    const result = deriveMissionFollowupMetric([], null);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('no_baseline');
  });

  it('counts 0 as a real measured value once completedAt is known', () => {
    const result = deriveMissionFollowupMetric([], '2025-01-02T00:00:00Z');
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value.count).toBe(0);
  });

  it('counts pre-filtered follow-up tasks', () => {
    const result = deriveMissionFollowupMetric(
      [{ id: 't1', createdAt: '2025-01-03T00:00:00Z' }, { id: 't2', createdAt: '2025-01-04T00:00:00Z' }],
      '2025-01-02T00:00:00Z',
    );
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value.count).toBe(2);
  });
});

describe('computeMissionAuthorshipHealth', () => {
  it('computes both metrics from one call, on a mixed-authorship mission with a post-completion follow-up', () => {
    const missionCreatedAt = '2025-01-01T00:00:00Z';
    const missionCompletedAt = '2025-01-05T00:00:00Z';
    const tasks = [
      { taskClass: 'work' as const, createdByWorkerId: 'worker-1', createdByAccountId: null, createdAt: missionCreatedAt },
      { taskClass: 'work' as const, createdByWorkerId: null, createdByAccountId: 'account-1', createdAt: '2025-01-01T00:15:00Z' },
      { taskClass: 'work' as const, createdByWorkerId: null, createdByAccountId: 'account-1', createdAt: '2025-01-02T00:00:00Z' },
      { taskClass: 'attempt' as const, createdByWorkerId: null, createdByAccountId: 'account-1', createdAt: missionCreatedAt },
    ];
    const followupTasks = [{ id: 'followup-1', createdAt: '2025-01-06T00:00:00Z' }];

    const health = computeMissionAuthorshipHealth({ tasks, missionCreatedAt, missionCompletedAt, followupTasks });

    expect(health.humanShare.kind).toBe('value');
    if (health.humanShare.kind === 'value') {
      expect(health.humanShare.value.totalCount).toBe(3); // attempt excluded
      expect(health.humanShare.value.humanCount).toBe(2);
      expect(health.humanShare.value.atStart).toBe(1);
      expect(health.humanShare.value.midFlight).toBe(1);
    }

    expect(health.followups.kind).toBe('value');
    if (health.followups.kind === 'value') expect(health.followups.value.count).toBe(1);
  });

  it('renders followups as no_baseline while humanShare still resolves, for an active mission', () => {
    const health = computeMissionAuthorshipHealth({
      tasks: [{ taskClass: 'work' as const, createdByWorkerId: 'worker-1', createdByAccountId: null, createdAt: '2025-01-01T00:00:00Z' }],
      missionCreatedAt: '2025-01-01T00:00:00Z',
      missionCompletedAt: null,
      followupTasks: [],
    });
    expect(health.humanShare.kind).toBe('value');
    expect(health.followups.kind).toBe('unavailable');
    if (health.followups.kind === 'unavailable') expect(health.followups.reason).toBe('no_baseline');
  });
});

// ── deriveCriteriaGatePresentation ───────────────────────────────────────────
// Pins the four states shared by the mission card pill, the mission detail
// banner, and the initiative KPI chip. The bug this guards against: a
// never-evaluated criterion on a fresh mission rendering as a red "BLOCKED"
// banner, indistinguishable from an actual failure or a real work-stopping state.

describe('deriveCriteriaGatePresentation', () => {
  it('returns null when there are no criteria — nothing to gate on', () => {
    expect(deriveCriteriaGatePresentation({ criteriaCount: 0, overall: null })).toBeNull();
  });

  it('"clear": overall pass renders success, no alarm', () => {
    const result = deriveCriteriaGatePresentation({ criteriaCount: 2, overall: 'pass' });
    expect(result).toEqual({ state: 'clear', label: 'Verified', tone: 'success', detail: null });
  });

  it('"unverified": never evaluated on a young/active mission renders quiet, not BLOCKED', () => {
    const result = deriveCriteriaGatePresentation({ criteriaCount: 1, overall: null });
    expect(result!.state).toBe('unverified');
    expect(result!.tone).toBe('neutral');
    expect(result!.label).not.toMatch(/blocked/i);
  });

  it('"unverified": UNVERIFIED overall with no completion attempt still renders quiet', () => {
    const result = deriveCriteriaGatePresentation({
      criteriaCount: 1,
      overall: 'UNVERIFIED',
      items: [{ verdict: 'UNVERIFIED', label: 'no PRs yet' }],
    });
    expect(result!.state).toBe('unverified');
    expect(result!.tone).toBe('neutral');
  });

  it('"failing": a failed criterion renders warning styling naming the criterion and its evidence', () => {
    const result = deriveCriteriaGatePresentation({
      criteriaCount: 2,
      overall: 'fail',
      items: [
        { verdict: 'pass', label: 'all PRs merged' },
        { verdict: 'fail', label: 'coverage check', evidence: 'coverage 62% < 80%' },
      ],
    });
    expect(result!.state).toBe('failing');
    expect(result!.tone).toBe('warning');
    expect(result!.detail).toBe('coverage check: coverage 62% < 80%');
    expect(result!.label).not.toMatch(/blocked/i);
  });

  it('"refused": completion attempted while criteria are unverified is prominent and distinct from "failing"', () => {
    const result = deriveCriteriaGatePresentation({
      criteriaCount: 1,
      overall: 'UNVERIFIED',
      items: [{ verdict: 'UNVERIFIED', label: 'no PRs yet' }],
      completionAttempted: true,
    });
    expect(result!.state).toBe('refused');
    expect(result!.tone).toBe('error');
    expect(result!.label).toBe('Completion refused');
  });

  it('"refused": completion attempted with a failing criterion also refuses, naming the failure', () => {
    const result = deriveCriteriaGatePresentation({
      criteriaCount: 1,
      overall: 'fail',
      items: [{ verdict: 'fail', label: 'tests pass', evidence: '3 tests failing' }],
      completionAttempted: true,
    });
    expect(result!.state).toBe('refused');
    expect(result!.tone).toBe('error');
    expect(result!.detail).toBe('tests pass: 3 tests failing');
  });

  it('BLOCKED never appears in any state label', () => {
    const states: Array<Parameters<typeof deriveCriteriaGatePresentation>[0]> = [
      { criteriaCount: 1, overall: null },
      { criteriaCount: 1, overall: 'pass' },
      { criteriaCount: 1, overall: 'fail', items: [{ verdict: 'fail', label: 'x' }] },
      { criteriaCount: 1, overall: 'UNVERIFIED', completionAttempted: true },
    ];
    for (const opts of states) {
      const result = deriveCriteriaGatePresentation(opts);
      expect(result?.label ?? '').not.toMatch(/blocked/i);
    }
  });
});

// ── deriveWorkLane ──────────────────────────────────────────────────────────

describe('deriveWorkLane', () => {
  it('rung 1: taskClass=attempt → check, regardless of anything else', () => {
    expect(deriveWorkLane({
      taskClass: 'attempt',
      roleSlug: 'builder',
      kind: 'engineering',
      title: 'Build the auth module',
    })).toBe('check');
  });

  it('rung 2: roleSlug=reviewer → check', () => {
    expect(deriveWorkLane({ roleSlug: 'reviewer' })).toBe('check');
  });

  it('rung 2: roleSlug=spec-validator → check', () => {
    expect(deriveWorkLane({ roleSlug: 'spec-validator' })).toBe('check');
  });

  it('rung 2: roleSlug=researcher → think', () => {
    expect(deriveWorkLane({ roleSlug: 'researcher' })).toBe('think');
  });

  it('rung 2: roleSlug=organizer → think', () => {
    expect(deriveWorkLane({ roleSlug: 'organizer' })).toBe('think');
  });

  it('rung 2: roleSlug=architect → think', () => {
    expect(deriveWorkLane({ roleSlug: 'architect' })).toBe('think');
  });

  it('rung 2: roleSlug=builder → build', () => {
    expect(deriveWorkLane({ roleSlug: 'builder' })).toBe('build');
  });

  it('rung 2 takes priority over rung 3 kind', () => {
    expect(deriveWorkLane({ roleSlug: 'reviewer', kind: 'engineering' })).toBe('check');
  });

  it('rung 3: kind=coordination → think', () => {
    expect(deriveWorkLane({ kind: 'coordination' })).toBe('think');
  });

  it('rung 3: kind=research → think', () => {
    expect(deriveWorkLane({ kind: 'research' })).toBe('think');
  });

  it('rung 3: kind=analysis → think', () => {
    expect(deriveWorkLane({ kind: 'analysis' })).toBe('think');
  });

  it('rung 3: kind=design → think', () => {
    expect(deriveWorkLane({ kind: 'design' })).toBe('think');
  });

  it('rung 3: kind=engineering → build', () => {
    expect(deriveWorkLane({ kind: 'engineering' })).toBe('build');
  });

  it('rung 3: kind=writing → build', () => {
    expect(deriveWorkLane({ kind: 'writing' })).toBe('build');
  });

  it('rung 3 takes priority over rung 4 title', () => {
    expect(deriveWorkLane({ kind: 'engineering', title: 'review the changes' })).toBe('build');
  });

  it('rung 4: title starting with [surface audit] → check', () => {
    expect(deriveWorkLane({ title: '[surface audit] apps/web' })).toBe('check');
  });

  it('rung 4: title starting with verify → check', () => {
    expect(deriveWorkLane({ title: 'Verify the migration ran cleanly' })).toBe('check');
  });

  it('rung 4: title containing review → check', () => {
    expect(deriveWorkLane({ title: 'Code review: auth module' })).toBe('check');
  });

  it('rung 4 is case-insensitive', () => {
    expect(deriveWorkLane({ title: 'VERIFY the deploy' })).toBe('check');
  });

  it('rung 5: nothing matches → null', () => {
    expect(deriveWorkLane({ title: 'Build the auth module' })).toBeNull();
  });

  it('rung 5: empty task → null', () => {
    expect(deriveWorkLane({})).toBeNull();
  });

  it('unrecognized roleSlug falls through to kind/title rungs', () => {
    expect(deriveWorkLane({ roleSlug: 'some-custom-role', kind: 'engineering' })).toBe('build');
  });

  it('unrecognized kind falls through to title rung', () => {
    expect(deriveWorkLane({ kind: 'some-custom-kind', title: 'review this' })).toBe('check');
  });
});

describe('hasNoWorkLaneData', () => {
  it('returns true when every task in a mission resolves to null', () => {
    const tasks = [
      { title: 'Build the auth module' },
      { title: 'Ship the release' },
      {},
    ];
    expect(hasNoWorkLaneData(tasks)).toBe(true);
  });

  it('returns false when at least one task resolves to a lane', () => {
    const tasks = [
      { title: 'Build the auth module' },
      { roleSlug: 'reviewer' },
    ];
    expect(hasNoWorkLaneData(tasks)).toBe(false);
  });

  it('returns false for an empty task list (nothing to be untrustworthy about)', () => {
    expect(hasNoWorkLaneData([])).toBe(false);
  });
});

describe('hasPendingDeliverableWork', () => {
  it('false when every deliverable is terminal', () => {
    expect(hasPendingDeliverableWork([
      { status: 'completed', taskClass: 'work' },
      { status: 'failed', taskClass: 'work' },
      { status: 'cancelled', taskClass: 'work' },
    ])).toBe(false);
  });

  it('true when a deliverable is still open', () => {
    for (const status of ['pending', 'assigned', 'in_progress']) {
      expect(hasPendingDeliverableWork([
        { status: 'completed', taskClass: 'work' },
        { status, taskClass: 'work' },
      ])).toBe(true);
    }
  });

  it('ignores open non-deliverables (attempts, bookkeeping, review)', () => {
    expect(hasPendingDeliverableWork([
      { status: 'completed', taskClass: 'work' },
      { status: 'pending', taskClass: 'attempt' },
      { status: 'pending', taskClass: 'bookkeeping' },
      { status: 'assigned', taskClass: null, category: 'review' },
    ])).toBe(false);
  });

  it('false for a mission with no tasks', () => {
    expect(hasPendingDeliverableWork([])).toBe(false);
  });
});
