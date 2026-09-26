/**
 * A failing structural criterion names what holds it (F2), and one predicate
 * says whether a mission's next step is the owner's (F1). Fixtures are
 * illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { deriveCriteriaGatePresentation } from '@buildd/core/mission-helpers';
import {
  CRITERION_BLOCKERS_VISIBLE,
  deriveMissionStateView,
  missionNeedsYou,
  situationDetail,
  type MissionStateInput,
} from './mission-state-view';

const noOpenTasksFailing = [{ verdict: 'fail', type: 'no_open_tasks', label: 'no open tasks' }];

function input(over: Partial<MissionStateInput> = {}): MissionStateInput {
  const items = over.criteriaItems ?? noOpenTasksFailing;
  return {
    status: 'active',
    isHeld: false,
    activeAgents: 0,
    health: 'NOMINAL',
    progress: 100,
    criteriaItems: items,
    criteriaGate: deriveCriteriaGatePresentation({
      criteriaCount: items.length,
      overall: 'fail',
      items: items as any,
      completionAttempted: false,
    }),
    ...over,
  };
}

describe('F2: a failing "no open tasks" names the open tasks', () => {
  const open = [
    { id: 't1', status: 'pending', title: 'Wire the claim route' },
    { id: 't2', status: 'in_progress', title: 'Backfill the column' },
    { id: 't3', status: 'assigned', title: 'Document the flag' },
    { id: 't4', status: 'pending', title: 'Drop the old index' },
  ];

  it('lists up to three blockers with their status, and counts the rest', () => {
    // A live worker so the open tasks are not a stall; the criterion is then
    // reported in `outstanding` with its blockers.
    const view = deriveMissionStateView(input({ activeAgents: 1, openTasks: open }));
    const fact = view.outstanding.find(f => f.kind === 'criterion_failing');
    if (!fact || fact.kind !== 'criterion_failing') throw new Error('expected a criterion fact');
    expect(fact.blockers?.map(b => b.taskId)).toEqual(['t1', 't2', 't3', 't4']);
    expect(fact.blockers?.[0]).toEqual({ taskId: 't1', title: 'Wire the claim route', status: 'queued' });
    expect(fact.blockers?.[1].status).toBe('running');
    expect(CRITERION_BLOCKERS_VISIBLE).toBe(3);
  });

  it('the auto-appended surface audit is not a blocker (same rule as the evaluator)', () => {
    const view = deriveMissionStateView(input({
      activeAgents: 1,
      openTasks: [...open.slice(0, 1), { id: 'sa', status: 'pending', title: '[surface audit] Claim loop' }],
    }));
    const fact = view.outstanding.find(f => f.kind === 'criterion_failing');
    if (!fact || fact.kind !== 'criterion_failing') throw new Error('expected a criterion fact');
    expect(fact.blockers?.map(b => b.taskId)).toEqual(['t1']);
  });

  it('situationDetail renders the blockers (capped) instead of re-stating the criterion', () => {
    const view = deriveMissionStateView(input({ activeAgents: 1, openTasks: open }));
    const situation = { ...view.situation, focus: view.outstanding.find(f => f.kind === 'criterion_failing')! };
    const detail = situationDetail(situation, [
      { order: 1, claim: 'Goal criterion "no open tasks" returned a failing verdict.', derivedFrom: 'missions.goalCriteriaState', refs: { criterion: 'no open tasks' } },
    ]);
    expect(detail?.kind).toBe('blockers');
    if (detail?.kind !== 'blockers') throw new Error('unreachable');
    expect(detail.items.map(b => b.taskId)).toEqual(['t1', 't2', 't3']);
    expect(detail.more).toBe(1);
  });

  it('names unmerged PRs for a failing all_prs_merged', () => {
    const items = [{ verdict: 'fail', type: 'all_prs_merged', label: 'every PR merged' }];
    const view = deriveMissionStateView(input({
      activeAgents: 1,
      criteriaItems: items,
      openTasks: [],
      unmergedPrs: [{ taskId: 't9', title: 'Rename the helper', prNumber: 41, prUrl: 'https://example.test/pr/41' }],
    }));
    const fact = view.outstanding.find(f => f.kind === 'criterion_failing');
    if (!fact || fact.kind !== 'criterion_failing') throw new Error('expected a criterion fact');
    expect(fact.blockers).toEqual([{ taskId: 't9', title: 'Rename the helper', status: 'PR #41 open' }]);
  });
});

describe('F2: a failing verdict that the live rows contradict says so', () => {
  it('nothing is open now → the headline asks for re-verification, not "is failing"', () => {
    const view = deriveMissionStateView(input({ openTasks: [] }));
    expect(view.kind).toBe('awaiting_verification');
    const focus = view.situation.focus;
    if (!focus || focus.kind !== 'criterion_failing') throw new Error('expected criterion focus');
    expect(focus.stale).toBe(true);
    expect(view.situation.headline).toContain('no task is open.');
    expect(view.situation.headline).not.toContain('is failing');
    expect(view.situation.nextAction).toMatch(/re-run/i);
  });

  it('without task rows the verdict is taken as it stands (never a stale claim)', () => {
    const view = deriveMissionStateView(input({}));
    const focus = view.situation.focus;
    if (!focus || focus.kind !== 'criterion_failing') throw new Error('expected criterion focus');
    expect(focus.stale).toBeFalsy();
  });
});

describe('F2: the situation says it once', () => {
  it('a criterion focus without blockers explains with the next action, not the causal claim', () => {
    const view = deriveMissionStateView(input({ openTasks: [] }));
    const detail = situationDetail(view.situation, [
      { order: 1, claim: 'Goal criterion "no open tasks" returned a failing verdict.', derivedFrom: 'missions.goalCriteriaState', refs: { criterion: 'no open tasks' } },
    ]);
    expect(detail).toEqual({ kind: 'text', text: view.situation.nextAction! });
  });

  it('other kinds keep the one-line why', () => {
    const view = deriveMissionStateView({
      status: 'active', isHeld: false, activeAgents: 0, health: 'STALLED',
      openTasks: [{ id: 't1', status: 'pending', title: 'Wire the claim route' }],
    });
    const because = [{ order: 1, claim: '1 task is open with no live worker.', derivedFrom: 'deriveTaskHealthSignal', refs: { taskId: 't1' } }];
    expect(situationDetail(view.situation, because)).toEqual({ kind: 'why', link: because[0] });
  });
});

describe('F1: missionNeedsYou', () => {
  it('a failing criterion verdict needs you', () => {
    expect(missionNeedsYou(deriveMissionStateView(input({ openTasks: [] })))).toBe(true);
  });

  it('an unmerged PR needs you, even behind a live worker', () => {
    const view = deriveMissionStateView({
      status: 'active', isHeld: false, activeAgents: 1, health: 'NOMINAL',
      unmergedPrs: [{ taskId: 't1', title: 'Rename the helper', prNumber: 41, prUrl: null }],
    });
    expect(missionNeedsYou(view)).toBe(true);
  });

  it('a held mission whose only ask is arming does not', () => {
    const view = deriveMissionStateView({ status: 'active', isHeld: true, activeAgents: 0, health: 'NOMINAL' });
    expect(view.kind).toBe('held');
    expect(missionNeedsYou(view)).toBe(false);
  });

  it('a held mission with an unmerged PR does', () => {
    const view = deriveMissionStateView({
      status: 'active', isHeld: true, activeAgents: 0, health: 'NOMINAL',
      unmergedPrs: [{ taskId: 't1', title: 'Rename the helper', prNumber: 41, prUrl: null }],
    });
    expect(missionNeedsYou(view)).toBe(true);
  });

  it('a running mission with nothing outstanding does not; nor a complete one', () => {
    expect(missionNeedsYou(deriveMissionStateView({ status: 'active', isHeld: false, activeAgents: 2, health: 'NOMINAL' }))).toBe(false);
    expect(missionNeedsYou(deriveMissionStateView(input({ status: 'completed', openTasks: [] })))).toBe(false);
  });

  it('an in-flight failing criterion (tasks still moving) is not an ask by itself', () => {
    const view = deriveMissionStateView(input({
      activeAgents: 1,
      progress: 50,
      openTasks: [{ id: 't1', status: 'in_progress', title: 'Wire the claim route' }],
    }));
    expect(view.kind).toBe('running');
    expect(missionNeedsYou(view)).toBe(false);
  });
});
