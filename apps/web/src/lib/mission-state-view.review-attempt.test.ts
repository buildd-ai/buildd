/**
 * 00d288fd: an open reviewer is a review, never a fix. Its `iteration` counts
 * review rounds (0 for the first), so reading it as a fix said "Fix 0 of 3
 * queued, waiting for a runner" for a second review of the same head.
 */
import { describe, expect, it } from 'bun:test';
import { deriveMissionStateView, isGated, type MissionStateInput } from './mission-state-view';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };
const PR = { taskId: 'task-a', title: 'Ship the thing', prNumber: 7, prUrl: 'https://example.invalid/pr/7' };

describe('the open attempt on a PR', () => {
  it('a reviewer reads as a review', () => {
    const view = deriveMissionStateView({ ...base, unmergedPrs: [PR], openAttempt: { taskId: 'rev-1', status: 'pending', iteration: 0, maxIterations: 3, claimed: false, kind: 'review' } });
    if (!isGated(view)) throw new Error('expected a gated view');
    expect(view.waitingOn.label).toBe('Review queued, waiting for a runner');
    expect(JSON.stringify(view)).not.toContain('Fix 0 of 3');
  });
  it('a fix still reads as a fix, with its attempt number', () => {
    const view = deriveMissionStateView({ ...base, unmergedPrs: [PR], openAttempt: { taskId: 'fix-1', status: 'in_progress', iteration: 1, maxIterations: 3, claimed: true } });
    if (!isGated(view)) throw new Error('expected a gated view');
    expect(view.waitingOn.label).toBe('Fix 1 of 3 in progress');
  });
});
