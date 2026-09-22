/**
 * Regression tests for the defect that produced this file: a mission whose work
 * was finished, whose integration PR was still open, and whose screen offered
 * seven equally-weighted buttons and no statement of what was being asked.
 *
 * The accessor already knew the answer. These tests pin the two properties that
 * make it reach a screen:
 *
 * 1. The precedence verdict ranks facts; it does not erase them. `waitingOn`
 *    may go null while `outstanding` still names an open PR.
 * 2. A repeated claim-loop deferral is a fact the owner is owed, not a spinner.
 */
import { describe, it, expect } from 'bun:test';
import {
  deriveMissionStateView,
  OUTSTANDING_RANK,
  type MissionStateInput,
  type WaitingOnDescriptor,
} from './mission-state-view';
import { SURFACE_DEFERRAL_MS, STRAND_MS, MIN_CONSECUTIVE_DEFERRALS } from './claim-deferral-thresholds';

const base: MissionStateInput = {
  status: 'active',
  isHeld: false,
  activeAgents: 0,
  health: 'NOMINAL',
};

/** All work merged, goal criteria clear, and the mission's own PR still open. */
const workFinishedMissionPrOpen: MissionStateInput = {
  ...base,
  progress: 100,
  completion: {
    ok: false,
    code: 'awaiting_mission_pr',
    reason: 'the mission PR has not merged',
    awaitingMerge: 1,
    awaitingMergeDetails: [],
  },
  missionPr: { prNumber: 4242, prUrl: 'https://example.invalid/pr/4242' },
};

function factOfKind(facts: readonly WaitingOnDescriptor[], kind: WaitingOnDescriptor['kind']) {
  const f = facts.find(x => x.kind === kind);
  expect(f).toBeDefined();
  return f!;
}

describe('all work merged, mission PR open', () => {
  it('states waiting-on-you and offers merge as the one next action', () => {
    const view = deriveMissionStateView(workFinishedMissionPrOpen);

    expect(view.kind).toBe('awaiting_merge');
    expect(view.situation.headline).toBe('Waiting on you to merge the mission PR #4242.');
    expect(view.situation.focus?.kind).toBe('merge');
    expect(view.situation.nextAction).toContain('Land the mission PR');
  });

  it('carries the PR href, so the affordance has somewhere to go', () => {
    const view = deriveMissionStateView(workFinishedMissionPrOpen);
    const merge = factOfKind(view.outstanding, 'merge');
    if (merge.kind !== 'merge') throw new Error('unreachable');

    expect(merge.missionPr).toBe(true);
    expect(merge.prUrls).toEqual(['https://example.invalid/pr/4242']);
  });

  it('ranks merge above the capabilities a mission merely supports', () => {
    // Delete / Disarm / Complete are not facts at all — they never enter
    // `outstanding`, which is the structural reason they cannot be primary.
    const view = deriveMissionStateView(workFinishedMissionPrOpen);
    expect(view.outstanding.map(f => f.kind)).toEqual(['merge']);
  });
});

describe('Part 2 — guidance survives a wrong state read', () => {
  it('STILL states the open mission PR when a live worker row makes state read running', () => {
    // The observed failure exactly: one stale attempt row makes `activeAgents`
    // non-zero, `running` wins precedence, and the old code returned
    // `waitingOn: null` — "no source reports anything outstanding" — over the
    // top of an open PR.
    const view = deriveMissionStateView({ ...workFinishedMissionPrOpen, activeAgents: 1 });

    expect(view.kind).toBe('running');
    expect(view.waitingOn).toBeNull();

    const merge = factOfKind(view.outstanding, 'merge');
    if (merge.kind !== 'merge') throw new Error('unreachable');
    expect(merge.missionPr).toBe(true);
    expect(view.situation.headline).toBe('Running (1 agent) — but waiting on you to merge the mission PR #4242.');
    expect(view.situation.nextAction).toContain('Land the mission PR');
  });

  it('states an unmet goal criterion even when state reads running', () => {
    const view = deriveMissionStateView({
      ...base,
      activeAgents: 2,
      criteriaGate: { state: 'failing', tone: 'warning', label: 'FAIL', detail: 'ships on trunk' },
      criteriaItems: [{ verdict: 'fail', label: 'ships on trunk' }],
    });

    expect(view.kind).toBe('running');
    const criterion = factOfKind(view.outstanding, 'criterion_failing');
    expect(criterion.label).toContain('ships on trunk');
    expect(view.situation.headline).toContain('ships on trunk');
  });

  it('states unfinished deliverables even when state reads running', () => {
    const view = deriveMissionStateView({
      ...base,
      activeAgents: 1,
      openTasks: [{ id: 't1', status: 'pending' }, { id: 't2', status: 'in_progress' }],
    });

    const open = factOfKind(view.outstanding, 'task');
    if (open.kind !== 'task') throw new Error('unreachable');
    expect(open.count).toBe(2);
    // "Still open" — NOT "open with no live worker", which a live worker refutes.
    expect(open.label).toContain('still open');
    expect(open.tone).toBe('neutral');
  });

  it('drops a self-resolving wait when something is live, rather than contradicting itself', () => {
    const view = deriveMissionStateView({
      ...base,
      activeAgents: 1,
      wait: { reason: 'budget window', waitUntil: '2026-09-19T14:20:00.000Z' },
    });

    expect(view.outstanding.some(f => f.kind === 'self_resolving_wait')).toBe(false);
  });

  it('keeps the self-resolving wait when nothing is live', () => {
    const view = deriveMissionStateView({
      ...base,
      wait: { reason: 'budget window', waitUntil: '2026-09-19T14:20:00.000Z' },
    });

    expect(view.kind).toBe('waiting');
    expect(factOfKind(view.outstanding, 'self_resolving_wait')).toBeDefined();
  });
});

describe('Part 2 — repeated claim-loop deferrals', () => {
  // A streak that has been running for `elapsedMs`, at the real measured
  // claim cadence (p50 over five minutes) rather than the ~30s this used to
  // assume — a handful of deferrals, not hundreds.
  const deferred = (elapsedMs: number, n = MIN_CONSECUTIVE_DEFERRALS): MissionStateInput => ({
    ...base,
    activeAgents: 1,
    deferrals: [{
      taskId: 'task-stuck',
      reason: 'workspace_cap',
      consecutiveDeferrals: n,
      firstDeferredAt: new Date(Date.now() - elapsedMs).toISOString(),
    }],
  });

  it('names the deferral and its reason instead of rendering a healthy spinner', () => {
    const view = deriveMissionStateView(deferred(SURFACE_DEFERRAL_MS * 2, 13));

    const fact = factOfKind(view.outstanding, 'claim_deferral');
    if (fact.kind !== 'claim_deferral') throw new Error('unreachable');
    expect(fact.reason).toBe('workspace_cap');
    expect(fact.consecutiveDeferrals).toBe(13);
    expect(fact.taskIds).toEqual(['task-stuck']);
    expect(view.situation.headline).toContain('workspace_cap');
    expect(view.situation.headline).toContain('13 times in a row');
    expect(view.situation.derivedFrom).toBe('gateEvents.claimLoopDeferral');
  });

  it('stays quiet below the surfacing threshold — transient contention is not news', () => {
    const view = deriveMissionStateView(deferred(SURFACE_DEFERRAL_MS - 1000));
    expect(view.outstanding.some(f => f.kind === 'claim_deferral')).toBe(false);
  });

  it('speaks at the threshold, and long before the stranding sweep gives up', () => {
    expect(deriveMissionStateView(deferred(SURFACE_DEFERRAL_MS)).outstanding.some(f => f.kind === 'claim_deferral')).toBe(true);
    expect(SURFACE_DEFERRAL_MS).toBeLessThan(STRAND_MS);
  });

  it('stays quiet no matter the poll count when the streak has not run long enough — this is the bug the old poll-count threshold had', () => {
    // A huge consecutiveDeferrals count from a hyperactive claim loop, but the
    // streak only started a moment ago — should NOT surface.
    const view = deriveMissionStateView(deferred(1000, 9999));
    expect(view.outstanding.some(f => f.kind === 'claim_deferral')).toBe(false);
  });

  it('never becomes the precedence verdict — it annotates the state, it is not a state', () => {
    const view = deriveMissionStateView(deferred(SURFACE_DEFERRAL_MS * 2, 50));
    expect(view.kind).toBe('running');
    expect(view.waitingOn).toBeNull();
  });

  it('leads with the owner-actionable merge when both are outstanding', () => {
    // The observed mission: a PR the owner had to merge, AND a task the claim
    // loop kept refusing. Both are said; the one only the owner can clear leads.
    const view = deriveMissionStateView({
      ...workFinishedMissionPrOpen,
      activeAgents: 1,
      deferrals: [{
        taskId: 'task-stuck',
        reason: 'workspace_cap',
        consecutiveDeferrals: 13,
        firstDeferredAt: new Date(Date.now() - SURFACE_DEFERRAL_MS * 2).toISOString(),
      }],
    });

    expect(view.situation.focus?.kind).toBe('merge');
    expect(view.situation.alsoOutstanding.map(f => f.kind)).toContain('claim_deferral');
    expect(OUTSTANDING_RANK.merge).toBeLessThan(OUTSTANDING_RANK.claim_deferral);
  });
});

describe('genuinely mid-flight with nothing outstanding', () => {
  it('says running, offers no action, and names no blocker', () => {
    const view = deriveMissionStateView({ ...base, activeAgents: 3 });

    expect(view.kind).toBe('running');
    expect(view.outstanding).toEqual([]);
    expect(view.situation.focus).toBeNull();
    expect(view.situation.nextAction).toBeNull();
    expect(view.situation.headline).toBe('Running — 3 agents in flight, nothing outstanding.');
  });

  it('says so plainly when idle, rather than falling back to a menu', () => {
    const view = deriveMissionStateView(base);

    expect(view.kind).toBe('idle');
    expect(view.situation.nextAction).toBeNull();
    expect(view.situation.headline).toBe('Nothing to do — no source reports anything outstanding.');
  });

  it('reports nothing outstanding for a completed mission', () => {
    const view = deriveMissionStateView({
      ...workFinishedMissionPrOpen,
      status: 'completed',
    });

    expect(view.kind).toBe('complete');
    expect(view.outstanding).toEqual([]);
    expect(view.situation.headline).toBe('Complete — nothing outstanding.');
  });
});

describe('degraded input — a caller that could not afford the full derivations', () => {
  it('finds the open mission PR from worker rows alone', () => {
    const view = deriveMissionStateView({
      ...base,
      progress: 100,
      missionPr: { prNumber: 77, prUrl: 'https://example.invalid/pr/77' },
    });

    expect(view.kind).toBe('awaiting_merge');
    expect(view.situation.derivedFrom).toBe('workers.prUrl + workers.mergedAt');
    expect(view.situation.headline).toBe('Waiting on you to merge the mission PR #77.');
  });

  it('finds unmerged task PRs from worker rows alone', () => {
    const view = deriveMissionStateView({
      ...base,
      unmergedPrs: [
        { taskId: 't1', title: 'a', prNumber: 1, prUrl: 'https://example.invalid/pr/1' },
        { taskId: 't2', title: 'b', prNumber: 2, prUrl: 'https://example.invalid/pr/2' },
      ],
    });

    const merge = factOfKind(view.outstanding, 'merge');
    if (merge.kind !== 'merge') throw new Error('unreachable');
    expect(merge.missionPr).toBe(false);
    expect(merge.count).toBe(2);
    expect(merge.prUrls).toHaveLength(2);
  });
});
