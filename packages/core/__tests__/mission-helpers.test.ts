import { describe, it, expect } from 'bun:test';
import { isDeliverableTask, computeMissionProgress, type MissionSegmentState } from '../mission-helpers';

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
