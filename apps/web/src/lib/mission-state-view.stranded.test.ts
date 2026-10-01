/**
 * Two readings the owner hit on the mobile Home cards:
 *
 * 1. A local mission whose session has ended, with claimable work nobody will
 *    claim, read LOCAL as if work were happening. It is STRANDED, and the one
 *    action that moves it is "Continue on a runner".
 * 2. A mission whose only open work is waiting on its dependencies read as an
 *    ask ("Dispatch a worker"). Nothing is the owner's to do; the copy names
 *    what it is waiting on instead.
 */
import { describe, expect, it } from 'bun:test';
import { deriveMissionStateView, missionNeedsYou, type MissionStateInput } from './mission-state-view';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };

const localQueued: MissionStateInput = {
  ...base,
  executor: 'local',
  openTasks: [{ id: 't1', status: 'pending', title: 'docs: something' }],
};

describe('stranded local mission', () => {
  const stranded: MissionStateInput = {
    ...localQueued,
    localStrand: { stranded: true, quietMs: 2 * 60 * 60_000, claimableTaskIds: ['t1'], flipBlockedReason: null },
  };

  it('reads STRANDED and asks the owner, instead of LOCAL', () => {
    const view = deriveMissionStateView(stranded);
    expect(view.kind).toBe('awaiting_decision');
    expect(view.chip.label).toBe('STRANDED');
    expect(view.derivedFrom.kind).toBe('deriveLocalStrand');
    expect(missionNeedsYou(view)).toBe(true);
  });

  it('headline: "Stranded: no local session for 2h. Continue on a runner?"', () => {
    const view = deriveMissionStateView(stranded);
    expect(view.situation.headline).toBe('Stranded: no local session for 2h. Continue on a runner?');
    expect(view.situation.focus?.kind).toBe('task');
  });

  it('next action offers the flip and the keep-local path', () => {
    const view = deriveMissionStateView(stranded);
    expect(view.nextAction).toContain('Continue on a runner');
    expect(view.nextAction).toContain('claim_task');
    expect(view.nextAction).not.toContain('Dispatch a worker');
  });

  it('a refused flip is named in the next action, not offered', () => {
    const view = deriveMissionStateView({
      ...stranded,
      localStrand: { ...stranded.localStrand!, flipBlockedReason: 'The mission has no workspace.' },
    });
    expect(view.nextAction).toContain("Can't continue on a runner: The mission has no workspace.");
    expect(view.situation.focus?.kind === 'task' && view.situation.focus.stranded?.flipBlockedReason).toBe('The mission has no workspace.');
  });

  it('outranks a merge fact: a reviewer nobody can claim is the reason the PR has not merged', () => {
    const view = deriveMissionStateView({
      ...stranded,
      unmergedPrs: [{ taskId: 'done1', prNumber: 7, prUrl: 'https://example.invalid/pr/7' }],
    });
    expect(view.kind).toBe('awaiting_decision');
    expect(view.outstanding.some(f => f.kind === 'merge')).toBe(true);
  });

  it('not stranded yet: the existing local reading stands (waiting for a local session)', () => {
    const view = deriveMissionStateView({
      ...localQueued,
      localStrand: { stranded: false, quietMs: 5 * 60_000, claimableTaskIds: ['t1'], flipBlockedReason: null },
    });
    expect(view.kind).toBe('running');
    expect(view.chip.label).toBe('LOCAL');
    expect(view.situation.headline).toBe('Waiting for a local session to claim the open task.');
  });

  it('held beats it, even if a caller passes a strand', () => {
    const view = deriveMissionStateView({ ...stranded, isHeld: true });
    expect(view.kind).toBe('held');
  });

  it('a runner mission ignores a strand', () => {
    const view = deriveMissionStateView({ ...stranded, executor: 'runner' });
    expect(view.kind).not.toBe('awaiting_decision');
  });
});

describe('dependency-blocked work is not an ask', () => {
  const depBlockedOnPrs: MissionStateInput = {
    ...base,
    openTasks: [{
      id: 'spec', status: 'pending', title: 'docs: promote the design to a spec',
      waitingOnTaskIds: ['a', 'b'], waitingOnPrs: { a: 3319, b: 3317 },
    }],
  };

  it('card shape (no completion decision, health NOMINAL) still names the wait', () => {
    const view = deriveMissionStateView(depBlockedOnPrs);
    expect(view.kind).toBe('waiting');
    expect(missionNeedsYou(view)).toBe(false);
    expect(view.situation.headline).toBe('1 task is waiting on #3319 and #3317 to merge.');
  });

  it('nextAction names the blocking PRs instead of "Dispatch a worker"', () => {
    const view = deriveMissionStateView(depBlockedOnPrs);
    expect(view.nextAction).toBe('Nothing to do yet. Unblocks when #3319 and #3317 merge.');
  });

  it('explain shape (completion says pending_deliverables) reads the same', () => {
    const view = deriveMissionStateView({
      ...depBlockedOnPrs,
      completion: { ok: false, code: 'pending_deliverables', reason: 'open', pendingDeliverables: 1, pendingByStatus: { pending: 1 } },
    });
    expect(view.kind).toBe('waiting');
    expect(view.nextAction).toBe('Nothing to do yet. Unblocks when #3319 and #3317 merge.');
  });

  it('dependencies still running: unblocks when they finish', () => {
    const view = deriveMissionStateView({
      ...base,
      openTasks: [{ id: 'x', status: 'pending', waitingOnTaskIds: ['a', 'b'] }],
    });
    expect(view.nextAction).toBe('Nothing to do yet. Unblocks when 2 upstream tasks finish.');
    expect(missionNeedsYou(view)).toBe(false);
  });

  it('a mix names both', () => {
    const view = deriveMissionStateView({
      ...base,
      openTasks: [{ id: 'x', status: 'pending', waitingOnTaskIds: ['a', 'b'], waitingOnPrs: { a: 12 } }],
    });
    expect(view.nextAction).toBe('Nothing to do yet. Unblocks when #12 merges and 1 upstream task finishes.');
  });

  it('a claimable sibling still reads as the stall it is', () => {
    const view = deriveMissionStateView({
      ...base,
      health: 'STALLED',
      openTasks: [
        { id: 'x', status: 'pending', waitingOnTaskIds: ['a'] },
        { id: 'y', status: 'pending' },
      ],
    });
    expect(view.kind).toBe('blocked');
    expect(view.nextAction).toContain('Dispatch a worker');
  });

  it('a stranded local mission whose only work is dep-blocked is not stranded (nothing is claimable)', () => {
    const view = deriveMissionStateView({
      ...depBlockedOnPrs,
      executor: 'local',
      localStrand: { stranded: false, quietMs: 0, claimableTaskIds: [], flipBlockedReason: null },
    });
    expect(view.kind).not.toBe('awaiting_decision');
    expect(missionNeedsYou(view)).toBe(false);
  });
});
