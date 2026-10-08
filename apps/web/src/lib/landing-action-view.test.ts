import { describe, expect, it } from 'bun:test';
import { describeTapResult, taskPageHref } from './landing-action-view';

describe('taskPageHref', () => {
  it('links the task the page was raised for, exactly', () => {
    expect(taskPageHref('11111111-2222-4333-8444-555555555555', 'other-task')).toBe('/app/tasks/11111111-2222-4333-8444-555555555555');
  });

  it("falls back to the resolved worker's task, then home", () => {
    expect(taskPageHref(null, 'task-1')).toBe('/app/tasks/task-1');
    expect(taskPageHref(undefined, null)).toBe('/app/home');
  });
});

describe('describeTapResult', () => {
  it('a retry that left landing waiting on checks reads as progress, not as a failed fix', () => {
    const v = describeTapResult({ summary: 'Not mergeable yet: checks or the review are still running on the PR head.', outcome: 'waiting_ci' });
    expect(v.progressing).toBe(true);
    expect(v.heading).toBe('Landing is under way');
    expect(v.body).toContain('Nothing failed');
    expect(v.body).toContain('checks or the review are still running');
  });

  it('a refreshed branch is progress too', () => {
    expect(describeTapResult({ summary: 'The branch was updated.', outcome: 'updating_branch' }).progressing).toBe(true);
  });

  it('names a merge and a person-only stop plainly', () => {
    expect(describeTapResult({ summary: 'Merged.', outcome: 'merged' }).heading).toBe('Merged');
    expect(describeTapResult({ summary: 'size cap', outcome: 'needs_human' })).toMatchObject({ heading: 'Still needs a person', progressing: false });
  });
});
