import { describe, it, expect } from 'bun:test';
import { isDeliverableTask } from '../mission-helpers';

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
