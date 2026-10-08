import { describe, it, expect } from 'bun:test';
import {
  deriveMissionStateView,
  isGated,
  missionNeedsYou,
  type MissionStateInput,
  type MissionStateView,
  type WaitingOnDescriptor,
} from './mission-state-view';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };

function gated(view: MissionStateView): WaitingOnDescriptor {
  expect(isGated(view)).toBe(true);
  if (!isGated(view)) throw new Error('expected a gated view');
  return view.waitingOn;
}

const PR = { taskId: 'task-a', title: 'Ship the thing', prNumber: 3206, prUrl: 'https://example.invalid/pr/3206' };
const RED = { taskId: 'task-a', prNumber: 3206, attempts: 3, failing: ['build'] };

describe('a red PR whose fix chain has ended', () => {
  it('is blocked, not ready for review, when the rows say the PR is unmerged', () => {
    const view = deriveMissionStateView({ ...base, unmergedPrs: [PR], ciRed: [RED] });

    expect(view.kind).toBe('blocked');
    expect(view.displayState).toBe('blocked');
    expect(view.chip.label).toBe('BLOCKED');
    expect(view.chip.label).not.toBe('READY FOR REVIEW');
    const waiting = gated(view);
    expect(waiting.kind).toBe('ci_red');
    if (waiting.kind !== 'ci_red') throw new Error('unreachable');
    expect(waiting.tone).toBe('error');
    expect(waiting.attempts).toBe(3);
    expect(waiting.failing).toEqual(['build']);
    expect(waiting.prNumbers).toEqual([3206]);
    expect(waiting.taskIds).toEqual(['task-a']);
    expect(view.situation.headline).toContain('CI red after 3 fix attempts');
    expect(view.situation.headline).toContain('build');
    expect(view.situation.headline).not.toContain('ready to merge');
    expect(view.nextAction).not.toContain('Resolve and merge');
    expect(missionNeedsYou(view)).toBe(true);
  });

  it('is blocked on the completion-gate path too', () => {
    const view = deriveMissionStateView({
      ...base,
      completion: {
        ok: false,
        code: 'awaiting_merge',
        reason: '1 deliverable task(s) completed but not merged',
        awaitingMerge: 1,
        awaitingMergeDetails: [PR],
      },
      ciRed: [RED],
    });
    expect(view.kind).toBe('blocked');
    expect(view.displayState).toBe('blocked');
    expect(gated(view).kind).toBe('ci_red');
  });

  it('says "1 fix attempt", and names the PR with no failing check known', () => {
    const view = deriveMissionStateView({ ...base, unmergedPrs: [PR], ciRed: [{ ...RED, attempts: 1, failing: [] }] });
    expect(view.situation.headline).toContain('CI red after 1 fix attempt');
    expect(view.situation.headline).not.toContain('attempts');
    expect(view.situation.headline).toContain('#3206');
  });

  it('keeps the merge reading when another unmerged PR is not red', () => {
    const view = deriveMissionStateView({
      ...base,
      unmergedPrs: [PR, { taskId: 'task-b', title: 'Other', prNumber: 3207, prUrl: 'https://example.invalid/pr/3207' }],
      ciRed: [RED],
    });
    expect(view.kind).toBe('awaiting_merge');
    expect(gated(view).kind).toBe('merge');
    expect(view.chip.label).toBe('READY FOR REVIEW');
  });

  it('a green PR is still ready for review', () => {
    const view = deriveMissionStateView({ ...base, unmergedPrs: [PR] });
    expect(view.kind).toBe('awaiting_merge');
    expect(view.chip.label).toBe('READY FOR REVIEW');
  });

  it('an open fix attempt still wins: the platform owes the next push', () => {
    const view = deriveMissionStateView({
      ...base,
      unmergedPrs: [PR],
      ciRed: [RED],
      openAttempt: { taskId: 'fix-4', status: 'pending', iteration: 1, maxIterations: 3, claimed: false },
    });
    expect(gated(view).kind).toBe('task');
  });

  it('does not outrank a live worker, but stays in outstanding', () => {
    const view = deriveMissionStateView({ ...base, activeAgents: 1, unmergedPrs: [PR], ciRed: [RED] });
    expect(view.kind).toBe('running');
    expect(view.outstanding.map(f => f.kind)).toContain('ci_red');
  });
});
