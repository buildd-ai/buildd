import { describe, it, expect } from 'bun:test';
import { isDeliverableTask, computeMissionProgress, deriveMissionProgressMetric, computeMissionSkyline, deriveTaskType, type MissionSegmentState } from '../mission-helpers';

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

  it('planning task with a PR counts as a deliverable (orchestrator mode)', () => {
    const tasks: Task[] = [
      {
        id: 'plan',
        status: 'completed',
        title: 'Mission: Build API',
        mode: 'planning',
        workers: [{ status: 'completed', prUrl: 'https://github.com/org/repo/pull/42' }],
      },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(1);
    expect(result.completedTasks).toBe(1);
    expect(result.progress).toBe(100);
  });

  it('planning task without a PR is still excluded', () => {
    const tasks: Task[] = [
      { id: 'plan', status: 'completed', title: 'Mission: Build API', mode: 'planning', workers: [] },
    ];
    const result = computeMissionProgress(tasks);
    expect(result.totalTasks).toBe(0);
    expect(result.progress).toBe(0);
  });
});

// ── computeMissionProgress — segments ────────────────────────────────────────

describe('computeMissionProgress — segments', () => {
  type TaskInput = Parameters<typeof computeMissionProgress>[0][number];

  function makeTaskWithWorkers(
    id: string,
    status: string,
    workers: Array<{ status: string; prUrl?: string | null; mergedAt?: string | null }> = [],
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

// ── computeMissionSkyline ─────────────────────────────────────────────────────

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

describe('computeMissionSkyline', () => {
  const T0 = new Date('2025-01-01T10:00:00Z').getTime();
  const SLOT = 15 * 60 * 1000; // 15 min

  function ms(offsetMin: number) {
    return new Date(T0 + offsetMin * 60_000).toISOString();
  }

  function makeWorker(
    startMin: number,
    endMin: number,
    opts: { status?: string; prUrl?: string | null; mergedAt?: string | null } = {},
  ) {
    return {
      startedAt: ms(startMin),
      completedAt: ms(endMin),
      status: opts.status ?? 'completed',
      prUrl: opts.prUrl ?? null,
      mergedAt: opts.mergedAt ?? null,
    };
  }

  it('returns null when no tasks have workers', () => {
    expect(computeMissionSkyline([])).toBeNull();
    expect(computeMissionSkyline([{ workers: [] }])).toBeNull();
  });

  it('returns null when no workers have startedAt', () => {
    expect(
      computeMissionSkyline([
        { workers: [{ startedAt: null, completedAt: null, status: 'completed', prUrl: null, mergedAt: null }] },
      ]),
    ).toBeNull();
  });

  it('sequential mission: flat lane 0, totalSlots = ceil(duration/15)', () => {
    // 30-min worker → 2 slots
    const result = computeMissionSkyline([{ workers: [makeWorker(0, 30)] }]);
    expect(result).not.toBeNull();
    expect(result!.totalSlots).toBe(2);
    expect(result!.peakLanes).toBe(1);
    expect(result!.foldedLanes).toBe(0);
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0]).toMatchObject({ lane: 0, startSlot: 0, endSlot: 2 });
  });

  it('minimum 1 slot for very short worker (<15m)', () => {
    const result = computeMissionSkyline([{ workers: [makeWorker(0, 5)] }]);
    expect(result!.blocks[0].endSlot - result!.blocks[0].startSlot).toBeGreaterThanOrEqual(1);
  });

  it('parallel tasks stack into lanes', () => {
    // two workers both starting at 0, ending at 30 → should be in different lanes
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 30)] },
      { workers: [makeWorker(0, 30)] },
    ]);
    expect(result!.peakLanes).toBe(2);
    const lanes = result!.blocks.map((b) => b.lane);
    expect(new Set(lanes).size).toBe(2);
  });

  it('sequential tasks pack into lane 0 (no wasted lanes)', () => {
    // worker B starts after worker A ends → both fit in lane 0
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 15)] },
      { workers: [makeWorker(15, 30)] },
    ]);
    expect(result!.peakLanes).toBe(1);
    expect(result!.blocks.every((b) => b.lane === 0)).toBe(true);
  });

  it('sequential workers have peakConcurrency=1 (touching boundary is not concurrent)', () => {
    // A ends at slot 1, B starts at slot 1 — they share a boundary but do NOT overlap
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 15)] }, // slots [0,1)
      { workers: [makeWorker(15, 30)] }, // slots [1,2)
    ]);
    expect(result!.peakConcurrency).toBe(1);
  });

  it('peak concurrency reflects simultaneous workers, not lanes', () => {
    // 3 workers all overlapping
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 30)] },
      { workers: [makeWorker(0, 30)] },
      { workers: [makeWorker(0, 30)] },
    ]);
    expect(result!.peakConcurrency).toBe(3);
  });

  it('state: failed when status=error', () => {
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 15, { status: 'error' })] },
    ]);
    expect(result!.blocks[0].state).toBe('failed');
  });

  it('state: awaiting when prUrl set and mergedAt null', () => {
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 15, { prUrl: 'https://github.com/pr/1', mergedAt: null })] },
    ]);
    expect(result!.blocks[0].state).toBe('awaiting');
  });

  it('state: merged when mergedAt set', () => {
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 15, { prUrl: 'https://github.com/pr/1', mergedAt: ms(20) })] },
    ]);
    expect(result!.blocks[0].state).toBe('merged');
  });

  it('state: merged for completed worker with no PR', () => {
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 15, { prUrl: null })] },
    ]);
    expect(result!.blocks[0].state).toBe('merged');
  });

  it('activeSpanMin = first start → last end in minutes', () => {
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 30)] },
      { workers: [makeWorker(10, 60)] },
    ]);
    expect(result!.activeSpanMin).toBe(60);
  });

  it('agentTimeMin = sum of individual worker durations', () => {
    // worker A: 30m, worker B: 20m → total 50m
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 30)] },
      { workers: [makeWorker(20, 40)] },
    ]);
    expect(result!.agentTimeMin).toBeCloseTo(50, 1);
  });

  it('parallelFactor = agentTimeMin / activeSpanMin', () => {
    // A: 0–30, B: 0–30 → activeSpan 30, agentTime 60 → factor 2.0
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 30)] },
      { workers: [makeWorker(0, 30)] },
    ]);
    expect(result!.parallelFactor).toBeCloseTo(2.0, 1);
  });

  it('folds lanes beyond 4 into foldedLanes', () => {
    // 6 simultaneous workers → 4 visible, 2 folded
    const result = computeMissionSkyline(
      Array.from({ length: 6 }, () => ({ workers: [makeWorker(0, 30)] })),
    );
    expect(result!.foldedLanes).toBe(2);
    expect(result!.blocks.some((b) => b.lane >= 4)).toBe(true);
  });

  it('reviewTailMin is set when missionCompletedAt is given after work ends', () => {
    // Work ends at 30m, mission closed at 90m → tail = 60m
    const result = computeMissionSkyline(
      [{ workers: [makeWorker(0, 30)] }],
      { missionCompletedAt: ms(90) },
    );
    expect(result!.reviewTailMin).toBeCloseTo(60, 0);
  });

  it('reviewTailMin is null when no missionCompletedAt is given', () => {
    const result = computeMissionSkyline([{ workers: [makeWorker(0, 30)] }]);
    expect(result!.reviewTailMin).toBeNull();
  });

  it('reviewTailMin is null when tail is ≤5m (negligible)', () => {
    const result = computeMissionSkyline(
      [{ workers: [makeWorker(0, 30)] }],
      { missionCompletedAt: ms(32) }, // only 2m after work ends
    );
    expect(result!.reviewTailMin).toBeNull();
  });

  // ── sub-slot sequential worker bug (regression) ───────────────────────────────
  // Workers shorter than one 15-minute slot all collapse to slot [0,1) in the
  // quantizer. Before the fix, the sweep-line and greedy packer would see all
  // three as concurrent, reporting peakConcurrency=3 and peakLanes=3.

  it('3 sequential sub-slot workers: peakConcurrency=1, peakLanes=1', () => {
    // Mirrors the failing mission: orchestrator, builder, reviewer ran back-to-back
    // in ~7 minutes total, never overlapping.
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 2)] },   // 0–2 min
      { workers: [makeWorker(2, 5)] },   // 2–5 min
      { workers: [makeWorker(5, 7)] },   // 5–7 min
    ]);
    expect(result!.peakConcurrency).toBe(1);
    expect(result!.peakLanes).toBe(1);
    expect(result!.parallelFactor).toBeCloseTo(1.0, 1);
  });

  it('3 sequential sub-slot workers produce a single merged render block in lane 0', () => {
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 2)] },
      { workers: [makeWorker(2, 5)] },
      { workers: [makeWorker(5, 7)] },
    ]);
    // All 3 quantize to slot [0,1) in the same lane — should be merged into 1 block
    const lane0Blocks = result!.blocks.filter((b) => b.lane === 0);
    expect(lane0Blocks).toHaveLength(1);
    expect(lane0Blocks[0]).toMatchObject({ lane: 0, startSlot: 0, endSlot: 1 });
  });

  it('3 genuinely overlapping sub-slot workers: peakConcurrency=3, peakLanes=3', () => {
    // All three run simultaneously (all start at 0, end at 2 min)
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 2)] },
      { workers: [makeWorker(0, 2)] },
      { workers: [makeWorker(0, 2)] },
    ]);
    expect(result!.peakConcurrency).toBe(3);
    expect(result!.peakLanes).toBe(3);
    // agentTime=6m (3×2m), activeSpan=2m → parallelFactor=3.0
    expect(result!.parallelFactor).toBeCloseTo(3.0, 1);
  });

  it('multi-slot overlapping workers: block geometry preserved (render regression)', () => {
    // Two workers spanning multiple slots, overlapping — geometry should be unchanged
    const result = computeMissionSkyline([
      { workers: [makeWorker(0, 30)] },  // slots [0,2)
      { workers: [makeWorker(15, 45)] }, // slots [1,3)
    ]);
    expect(result!.peakLanes).toBe(2);
    expect(result!.peakConcurrency).toBe(2);
    const block0 = result!.blocks.find((b) => b.lane === 0);
    const block1 = result!.blocks.find((b) => b.lane === 1);
    expect(block0).toMatchObject({ startSlot: 0, endSlot: 2 });
    expect(block1).toMatchObject({ startSlot: 1, endSlot: 3 });
  });
});
