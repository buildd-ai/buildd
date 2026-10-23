/**
 * Navigation d25d923d R-14 / AC-14: a held task says why it is held on the
 * mission state view, its presentation and the because[] chain, and never
 * "next in line for a runner". The 14f6a2b1 case: ten `path_overlap`
 * deferrals behind another task's PR read NEXT IN LINE for weeks.
 */
import { describe, expect, it } from 'bun:test';
import { deriveMissionStateView, type MissionStateInput } from './mission-state-view';
import { presentMissionState } from './mission-state-presentation';
import { buildStateBecause } from './explain-because';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const H = 60 * 60 * 1000;
const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'STALLED', runnerOnline: true, now: NOW };

const HOLDER = { id: 'holder-1', title: 'approve a spec from chat or MCP', status: 'in_progress' };

function gated(view: ReturnType<typeof deriveMissionStateView>) {
  if (view.waitingOn?.kind !== 'task') throw new Error(`expected a task fact, got ${view.waitingOn?.kind}`);
  return view.waitingOn;
}

describe('a held task names its hold (R-14)', () => {
  const overlap: MissionStateInput = {
    ...base,
    holders: new Map([[HOLDER.id, HOLDER]]),
    openTasks: [{
      id: 't1', status: 'pending', title: 'Verify plumbing',
      createdAt: new Date(NOW - 6 * H),
      deferral: { reason: 'path_overlap', firstDeferredAt: new Date(NOW - 2 * H).toISOString(), detail: { blockingTaskId: HOLDER.id, prNumber: 5434, consecutiveDeferrals: 10 } },
    }],
  };

  it('regression 14f6a2b1: path_overlap deferrals read held, not next in line, on every read of the view', () => {
    const view = deriveMissionStateView(overlap);
    const w = gated(view);
    expect(w.nextInLine).toBeUndefined();
    expect(view.chip.label).not.toBe('NEXT IN LINE');
    expect(w.hold).toBe('held: runs after approve a spec from chat or MCP');
    expect(w.holdRow).toBe('Queued 2h · held: runs after approve a spec from chat or MCP');
    expect(w.holdKind).toBe('overlap');
    expect(w.holder).toEqual({ id: HOLDER.id, title: HOLDER.title, note: null });
    expect(view.situation.headline).toContain('held: runs after approve a spec from chat or MCP');
    expect(view.situation.headline).not.toContain('next in line');
    expect(view.situation.headline).not.toContain('holder-1');
    expect(view.nextAction).toContain('once that task merges');

    const p = presentMissionState(view);
    expect(p.state).toBe('queued');
    expect(p.cause).toBe('coordination');
    expect(p.causeText).toBe('held: runs after approve a spec from chat or MCP');
    expect(p.sentence).not.toContain('next in line');

    const chain = buildStateBecause(view, { missionId: 'm' }, {
      openTasks: [{ id: 't1', title: 'Verify plumbing', status: 'pending', live: false, pendingHold: w.holdRow ? { row: w.holdRow, kind: 'overlap', holder: w.holder ?? null } : undefined }],
    });
    expect(chain[0].claim).toBe('"Verify plumbing": Queued 2h · held: runs after approve a spec from chat or MCP.');
    expect(chain[0].refs.taskId).toBe(HOLDER.id);
    expect(chain.map(l => l.claim).join(' ')).not.toContain('next in line');
  });

  it('the bare reason still reads as a hold when a caller has no detail', () => {
    const view = deriveMissionStateView({ ...base, openTasks: [{ id: 't1', status: 'pending', holdReason: 'path_overlap' }] });
    const w = gated(view);
    expect(w.nextInLine).toBeUndefined();
    expect(w.hold).toBe('held: runs after another task on the same files');
  });

  it('a dependency not merged outranks the overlap: Waiting on <task>', () => {
    const view = deriveMissionStateView({
      ...overlap,
      openTasks: [{
        ...overlap.openTasks![0],
        waitingOnTaskIds: ['dep-1'],
        waitingOnPrs: { 'dep-1': 5440 },
        dependencies: [{ id: 'dep-1', title: 'Mirror the runner image', status: 'completed', merged: false }],
      }],
    });
    const w = gated(view);
    expect(w.blockedBy?.names).toEqual(['Mirror the runner image']);
    expect(w.label).toBe('1 task(s) waiting on Mirror the runner image');
    expect(view.situation.headline).toBe('1 task is waiting on Mirror the runner image to merge (#5440).');
    expect(view.nextAction).toBe('Unblocks when Mirror the runner image merges (#5440).');
    expect(presentMissionState(view).cause).toBe('dependency');
  });

  it('a dead dependency is said so', () => {
    const view = deriveMissionStateView({
      ...base,
      openTasks: [{
        id: 't1', status: 'pending', waitingOnTaskIds: ['dep-1'],
        dependencies: [{ id: 'dep-1', title: 'Old migration', status: 'pending', startAt: new Date('2026-10-24T08:00:00.000Z') }],
      }],
    });
    expect(gated(view).blockedBy?.names).toEqual(['Old migration (deferred until Oct 24)']);
    expect(view.situation.headline).toBe('1 task is waiting on Old migration (deferred until Oct 24) to finish.');
  });

  it('a dead overlap holder is said so, and the way out changes', () => {
    const view = deriveMissionStateView({ ...overlap, holders: new Map([[HOLDER.id, { ...HOLDER, status: 'cancelled' }]]) });
    const w = gated(view);
    expect(w.hold).toBe('held: runs after approve a spec from chat or MCP (cancelled)');
    expect(view.nextAction).toBe('The task it waits on is cancelled: start this one anyway, or cancel it.');
  });

  it('no runner can take it: the deferral reason, with its detail', () => {
    const view = deriveMissionStateView({
      ...base,
      openTasks: [{ id: 't1', status: 'pending', deferral: { reason: 'isolation_unenforced', detail: { requirement: 'docker' } } }],
    });
    const w = gated(view);
    expect(w.hold).toBe('no runner can take it: needs docker isolation');
    expect(w.holdKind).toBe('no_runner');
    expect(view.chip.label).toBe('WAITING');
    expect(presentMissionState(view).causeText).toBe('no runner can take it: needs docker isolation');
    expect(view.nextAction).toContain('a runner that can take it');
  });

  it('no runner online keeps its own reading', () => {
    const view = deriveMissionStateView({ ...base, runnerOnline: false, openTasks: [{ id: 't1', status: 'pending' }] });
    const w = gated(view);
    expect(w.noRunner).toBe(true);
    expect(w.label).toBe('No runner online: The open task is queued');
    expect(presentMissionState(view).causeText).toBe('no runner is online');
  });

  it('red trunk: merges paused', () => {
    const view = deriveMissionStateView({ ...base, trunkRed: { branch: 'dev' }, openTasks: [{ id: 't1', status: 'pending' }] });
    expect(gated(view).hold).toBe('merges paused: dev is red');
    expect(presentMissionState(view).cause).toBe('delivery');
  });

  it('budget: the reset time from the deferral', () => {
    const view = deriveMissionStateView({
      ...base,
      openTasks: [{ id: 't1', status: 'pending', deferral: { reason: 'budget_paused', detail: { resetsAt: new Date(NOW + 3 * H).toISOString() } } }],
    });
    expect(gated(view).hold).toBe('team daily budget reached, resumes in 3h 00m');
    expect(presentMissionState(view).cause).toBe('budget');
  });

  it('a scheduled start: starts <time>', () => {
    const view = deriveMissionStateView({ ...base, openTasks: [{ id: 't1', status: 'pending', startAt: new Date(NOW + 30 * 60_000) }] });
    expect(gated(view).hold).toBe('starts in 30m');
    expect(presentMissionState(view).state).toBe('queued');
  });

  it('a recorded hold the order does not rank keeps the gate wording, with the age', () => {
    const view = deriveMissionStateView({
      ...base,
      openTasks: [{ id: 't1', status: 'pending', createdAt: new Date(NOW - 40 * 60_000), holdReason: 'mission_concurrent' }],
    });
    const w = gated(view);
    expect(w.hold).toBe('the mission is already running as many tasks as it allows');
    expect(view.situation.headline).toBe('The open task is queued 40m · the mission is already running as many tasks as it allows.');
    expect(presentMissionState(view).cause).toBe('capacity');
  });

  it('only a task nothing holds is next in line, and it carries its age', () => {
    const view = deriveMissionStateView({ ...base, openTasks: [{ id: 't1', status: 'pending', createdAt: new Date(NOW - 2 * H) }] });
    const w = gated(view);
    expect(w.nextInLine).toBe(true);
    expect(w.holdRow).toBe('Queued 2h · next in line for a runner');
    expect(view.chip.label).toBe('NEXT IN LINE');
  });

  it('two rows held differently: queued for several reasons, no invented cause', () => {
    const view = deriveMissionStateView({
      ...base,
      openTasks: [
        { id: 't1', status: 'pending', holdReason: 'mission_concurrent' },
        { id: 't2', status: 'pending', deferral: { reason: 'path_overlap', detail: { prNumber: 9 } } },
      ],
    });
    const w = gated(view);
    expect(w.waitingNoCause).toBe(true);
    expect(w.label).toBe('2 open tasks are queued for several reasons');
    expect(presentMissionState(view).causeText).toBeNull();
  });
});
