import { describe, it, expect } from 'bun:test';
import {
  evaluateUpstreamGate,
  gateBlockedReason,
  describeUnmetCondition,
  type GateTask,
  type GateUpstream,
} from './mission-dependency-gate';

const url = (n: number) => `https://github.com/example/app/pull/${n}`;
const merged = (n: number) => ({ prUrl: url(n), prNumber: n, mergedAt: '2026-01-02T00:00:00Z', prLifecycleStatus: 'merged' });
const open = (n: number) => ({ prUrl: url(n), prNumber: n, mergedAt: null, prLifecycleStatus: 'pr_open' });
const closed = (n: number) => ({ prUrl: url(n), prNumber: n, mergedAt: null, prLifecycleStatus: 'closed' });

let seq = 0;
function task(over: Partial<GateTask> & { title: string }): GateTask {
  seq += 1;
  return { id: `t${seq}`, status: 'completed', taskClass: 'work', parentTaskId: null, worker: null, ...over };
}

const active = (over: Partial<GateUpstream> = {}): GateUpstream => ({ title: 'Upstream', status: 'active', integrationBranch: false, ...over });

describe('evaluateUpstreamGate: completed upstream', () => {
  it('meets both gates once the upstream is completed, without reading tasks', () => {
    for (const gate of ['merged', 'completed'] as const) {
      expect(evaluateUpstreamGate(gate, active({ status: 'completed' }), [])).toEqual({ met: true, unmet: [] });
    }
  });

  it('a completed upstream meets the merged gate even with a closed refresh PR and a queued re-audit on its rows', () => {
    // The shape that kept a downstream blocked: delivered, every criterion passed,
    // but one row still held a closed obsolete refresh PR and the visual pass was
    // on an earlier commit. Neither un-merges anything.
    const tasks = [
      task({ title: 'feat: the work', worker: merged(10) }),
      task({ title: 'chore(mission): merge dev into the integration branch', worker: closed(11) }),
      task({ title: '[surface audit] Upstream', status: 'pending', roleSlug: 'visual-auditor' }),
    ];
    expect(evaluateUpstreamGate('merged', active({ status: 'completed', integrationBranch: true }), tasks).met).toBe(true);
  });
});

describe('evaluateUpstreamGate: completed gate', () => {
  it('stays shut while the upstream is active and names its status', () => {
    const v = evaluateUpstreamGate('completed', active(), [task({ title: 'feat: x', worker: merged(1) })]);
    expect(v.met).toBe(false);
    expect(v.unmet).toEqual([{ kind: 'upstream_not_completed', status: 'active' }]);
  });
});

describe('evaluateUpstreamGate: merged gate on an active upstream', () => {
  it('meets the gate when every build PR merged, with no verification required', () => {
    const tasks = [
      task({ title: 'docs: spec', worker: merged(1) }),
      task({ title: 'feat: build', worker: merged(2) }),
      // Verification still owed (a re-audit on a new head, a final check) never holds it.
      task({ title: '[surface audit] Upstream', status: 'pending', roleSlug: 'visual-auditor' }),
      task({ title: 'verify the outcome', status: 'in_progress', context: { finalVerification: { revision: 1 } } }),
    ];
    expect(evaluateUpstreamGate('merged', active(), tasks)).toEqual({ met: true, unmet: [] });
  });

  it('ignores a trunk refresh closed as obsolete, and its attempts', () => {
    const refresh = task({ title: 'chore(mission): merge dev into the Upstream integration branch', worker: closed(20) });
    const tasks = [
      task({ title: 'feat: build', worker: merged(2) }),
      refresh,
      task({ title: '[builder · after conflict #1] chore(mission): merge dev into the Upstream integration branch', taskClass: 'attempt', parentTaskId: refresh.id, worker: closed(20) }),
      task({ title: '[reviewer] PR #20: chore(mission): merge dev', taskClass: 'attempt', parentTaskId: refresh.id }),
    ];
    expect(evaluateUpstreamGate('merged', active(), tasks).met).toBe(true);
  });

  it('a merge stamped on one row settles the PR for a retry attempt carrying it', () => {
    const parent = task({ title: 'feat: build', worker: merged(5) });
    const tasks = [
      parent,
      task({ title: '[builder · after CI #1] feat: build', taskClass: 'attempt', parentTaskId: parent.id, worker: open(5) }),
    ];
    expect(evaluateUpstreamGate('merged', active(), tasks).met).toBe(true);
  });

  it('stays shut on an open build PR and names it', () => {
    const v = evaluateUpstreamGate('merged', active(), [task({ title: 'feat: build', worker: open(7) })]);
    expect(v.met).toBe(false);
    expect(v.unmet[0]).toMatchObject({ kind: 'pr_open', prNumber: 7, title: 'feat: build' });
  });

  it('stays shut on an unfinished build task', () => {
    const v = evaluateUpstreamGate('merged', active(), [task({ title: 'feat: build', status: 'in_progress' })]);
    expect(v.unmet[0]).toMatchObject({ kind: 'task_open', status: 'in_progress' });
  });

  it('stays shut on a build PR closed without merging and no edge, never reading it as shipped', () => {
    const v = evaluateUpstreamGate('merged', active(), [task({ title: 'feat: build', worker: closed(8) })]);
    expect(v.unmet[0]).toMatchObject({ kind: 'pr_closed_unmerged', prNumber: 8 });
  });

  it('a recorded supersession, a merged retry PR, or a recorded abandonment settles a closed build PR', () => {
    const superseded = task({ title: 'feat: a', worker: { ...closed(9), supersededByPrNumber: 12 } });
    const abandoned = task({ title: 'feat: b', worker: { ...closed(13), abandonedAt: '2026-01-03T00:00:00Z' } });
    const parent = task({ title: 'feat: c', worker: closed(14) });
    const retry = task({ title: '[builder · after review #1] feat: c', taskClass: 'attempt', parentTaskId: parent.id, worker: merged(15) });
    expect(evaluateUpstreamGate('merged', active(), [superseded, abandoned, parent, retry]).met).toBe(true);
  });

  it('a kernel delivery is the authority over the row columns', () => {
    const w = { ...open(16), delivery: { state: 'MERGED' } };
    expect(evaluateUpstreamGate('merged', active(), [task({ title: 'feat: build', worker: w })]).met).toBe(true);
  });

  it('an active upstream that has shipped nothing has not met it: no tasks yet, or all cancelled', () => {
    expect(evaluateUpstreamGate('merged', active(), []).unmet).toEqual([{ kind: 'nothing_shipped' }]);
    expect(evaluateUpstreamGate('merged', active(), [task({ title: 'feat: dropped', status: 'cancelled' })]).unmet).toEqual([{ kind: 'nothing_shipped' }]);
    // Cancelled work beside shipped work does not hold it.
    expect(evaluateUpstreamGate('merged', active(), [task({ title: 'feat: dropped', status: 'cancelled' }), task({ title: 'feat: kept', worker: merged(3) })]).met).toBe(true);
  });

  it('bookkeeping rows never hold the gate', () => {
    const v = evaluateUpstreamGate('merged', active(), [
      task({ title: 'Mission: Upstream', taskClass: 'bookkeeping', status: 'in_progress' }),
      task({ title: 'feat: build', worker: merged(2) }),
    ]);
    expect(v.met).toBe(true);
  });
});

describe('evaluateUpstreamGate: mission branch', () => {
  const branch = active({ integrationBranch: true });

  it('needs the mission PR merged once work landed on the integration branch', () => {
    const v = evaluateUpstreamGate('merged', branch, [
      task({ title: 'feat: build', worker: merged(2) }),
      task({ title: 'Ship mission: Upstream', taskClass: 'bookkeeping', worker: open(30) }),
    ]);
    expect(v.unmet).toEqual([{ kind: 'mission_pr_unmerged', taskId: expect.any(String), prNumber: 30 }]);
  });

  it('says so when the mission PR has not been opened', () => {
    const v = evaluateUpstreamGate('merged', branch, [task({ title: 'feat: build', worker: merged(2) })]);
    expect(v.unmet).toEqual([{ kind: 'mission_pr_unmerged', taskId: null, prNumber: null }]);
    expect(describeUnmetCondition(v.unmet[0])).toBe('the mission PR has not been opened');
  });

  it('is met once the mission PR merged, with a closed refresh PR left behind', () => {
    const owner = task({ title: 'Ship mission: Upstream', taskClass: 'bookkeeping', worker: merged(30) });
    const v = evaluateUpstreamGate('merged', branch, [
      task({ title: 'feat: build', worker: merged(2) }),
      owner,
      task({ title: '[builder · after conflict #1] Ship mission: Upstream', taskClass: 'attempt', parentTaskId: owner.id, worker: open(30) }),
      task({ title: 'chore(mission): merge dev into the Upstream integration branch', worker: closed(31) }),
    ]);
    expect(v).toEqual({ met: true, unmet: [] });
  });

  it('asks no mission PR of a mission branch whose work was all cancelled; only completion releases it', () => {
    expect(evaluateUpstreamGate('merged', branch, [task({ title: 'feat: build', status: 'cancelled' })]).unmet).toEqual([{ kind: 'nothing_shipped' }]);
  });
});

describe('gateBlockedReason', () => {
  it('names the gate, the first unmet condition and how many more', () => {
    const v = evaluateUpstreamGate('merged', active(), [
      task({ title: 'feat: a', worker: closed(40) }),
      task({ title: 'feat: b', worker: open(41) }),
    ]);
    expect(gateBlockedReason('Upstream', 'merged', v.unmet)).toBe(
      'Waiting for mission "Upstream" PRs to merge: PR #40 for "feat: a" closed without merging, and no replacement PR or abandonment is recorded (and 1 more)',
    );
  });

  it('keeps the plain line when nothing specific is known', () => {
    expect(gateBlockedReason('Upstream', 'completed', [])).toBe('Waiting for mission "Upstream" to complete');
    expect(gateBlockedReason('Upstream', 'completed', [{ kind: 'upstream_not_completed', status: 'active' }]))
      .toBe('Waiting for mission "Upstream" to complete: it is active, not completed');
  });
});
