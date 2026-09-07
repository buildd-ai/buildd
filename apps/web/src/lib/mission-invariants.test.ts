import { describe, it, expect } from 'bun:test';
import {
  INVARIANTS,
  countPlanSteps,
  emptySnapshot,
  evaluateInvariants,
  formatInvariantReport,
  invariantByKey,
  remoteRefKey,
  type InvariantKey,
  type InvariantSnapshot,
  type SnapshotMission,
  type SnapshotRelease,
  type SnapshotTask,
  type SnapshotWorker,
} from './mission-invariants';

// ── Fixture helpers ─────────────────────────────────────────────────────────
//
// Every id here is synthetic. These tests exist to prove each invariant fires
// on a constructed breach AND stays silent on the adjacent healthy state — the
// repo has a documented history of signals that were green because their query
// matched nothing, and a sweep that can only be observed against production is
// a sweep whose empty result is unfalsifiable.

const NOW = new Date('2026-09-10T12:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function mission(over: Partial<SnapshotMission> = {}): SnapshotMission {
  return {
    id: 'm-1',
    workspaceId: 'ws-1',
    title: 'Mission One',
    status: 'active',
    integrationBranchEnabled: false,
    workingBranch: null,
    criteriaEscalatedAt: null,
    hasGoalCriteria: false,
    criteriaOverallVerdict: null,
    updatedAt: ago(10 * HOUR),
    ...over,
  };
}

function task(over: Partial<SnapshotTask> = {}): SnapshotTask {
  return {
    id: 't-1',
    workspaceId: 'ws-1',
    missionId: null,
    parentTaskId: null,
    title: 'Do the thing',
    status: 'completed',
    mode: 'execution',
    taskClass: 'work',
    outputRequirement: 'auto',
    contextBaseBranch: null,
    planRaw: null,
    childCount: 0,
    createdAt: ago(10 * HOUR),
    updatedAt: ago(10 * HOUR),
    ...over,
  };
}

function worker(over: Partial<SnapshotWorker> = {}): SnapshotWorker {
  return {
    id: 'w-1',
    taskId: 't-1',
    workspaceId: 'ws-1',
    status: 'completed',
    branch: 'buildd/t-1-do-the-thing',
    prNumber: null,
    prUrl: null,
    prBaseRef: null,
    prLifecycleStatus: null,
    mergedAt: null,
    commitCount: 0,
    createdAt: ago(10 * HOUR),
    startedAt: ago(10 * HOUR),
    completedAt: ago(10 * HOUR),
    ...over,
  };
}

function release(over: Partial<SnapshotRelease> = {}): SnapshotRelease {
  return {
    id: 'r-1',
    workspaceId: 'ws-1',
    state: 'healthy',
    headSha: 'abc123',
    attributedTaskCount: 2,
    dispatchedAt: ago(10 * HOUR),
    createdAt: ago(10 * HOUR),
    ...over,
  };
}

function snapshot(over: Partial<InvariantSnapshot> = {}): InvariantSnapshot {
  return { ...emptySnapshot(), ...over };
}

/** Violating entity ids reported for one invariant key. */
function reported(key: InvariantKey, s: InvariantSnapshot): string[] {
  const result = evaluateInvariants(s, NOW).find(r => r.key === key);
  if (!result) throw new Error(`no invariant registered for key ${key}`);
  return result.violations.map(v => v.entityId);
}

// ── Registry ────────────────────────────────────────────────────────────────

describe('invariant registry', () => {
  it('ships the eleven observed defect shapes', () => {
    expect(INVARIANTS).toHaveLength(11);
  });

  it('gives every invariant a stable, unique key', () => {
    const keys = INVARIANTS.map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('gives every invariant a title, a remedy and a threshold', () => {
    for (const inv of INVARIANTS) {
      expect(inv.title.length, `${inv.key} title`).toBeGreaterThan(0);
      expect(inv.remedy.length, `${inv.key} remedy`).toBeGreaterThan(0);
      expect(inv.thresholdMs, `${inv.key} threshold`).toBeGreaterThanOrEqual(0);
    }
  });

  it('stages exactly one invariant to file a task', () => {
    const filing = INVARIANTS.filter(i => i.files).map(i => i.key);
    expect(filing).toEqual(['orphaned_integration_base']);
  });

  it('reports every invariant on every run, including the clean ones', () => {
    // A sweep that omits clean invariants cannot be told apart from a sweep
    // whose queries silently stopped matching anything.
    const results = evaluateInvariants(emptySnapshot(), NOW);
    expect(results.map(r => r.key).sort()).toEqual(INVARIANTS.map(i => i.key).sort());
    expect(results.every(r => r.violations.length === 0)).toBe(true);
  });
});

// ── 1. inert_integration_branch ─────────────────────────────────────────────

describe('inert_integration_branch', () => {
  const key = 'inert_integration_branch' as const;

  it('reports a mission whose flag is on while its working branch is null', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-inert', integrationBranchEnabled: true, workingBranch: null })],
      tasks: [task({ id: 't-a', missionId: 'm-inert', createdAt: ago(4 * HOUR) })],
    });
    expect(reported(key, s)).toEqual(['m-inert']);
  });

  it('does not report a mission whose flag is on and branch is set', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-ok', integrationBranchEnabled: true, workingBranch: 'mission/x-1234' })],
      tasks: [task({ id: 't-a', missionId: 'm-ok', createdAt: ago(4 * HOUR) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a mission whose flag is off', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-off', integrationBranchEnabled: false, workingBranch: null })],
      tasks: [task({ id: 't-a', missionId: 'm-off', createdAt: ago(4 * HOUR) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report before the branch is due — generation is lazy, on first task', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-new', integrationBranchEnabled: true, workingBranch: null })],
      tasks: [task({ id: 't-a', missionId: 'm-new', createdAt: ago(2 * MIN) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a mission that has no task to base anything on yet', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-empty', integrationBranchEnabled: true, workingBranch: null })],
      tasks: [],
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 2. orphaned_integration_base ────────────────────────────────────────────

describe('orphaned_integration_base', () => {
  const key = 'orphaned_integration_base' as const;

  const openPr = (over: Partial<SnapshotWorker> = {}) =>
    worker({
      id: 'w-pr',
      status: 'completed',
      prNumber: 4242,
      prUrl: 'https://github.com/o/r/pull/4242',
      prBaseRef: 'mission/checkout-1234',
      prLifecycleStatus: 'ci_green',
      mergedAt: null,
      createdAt: ago(6 * HOUR),
      ...over,
    });

  it('reports an open PR whose mission base no longer exists on the remote', () => {
    const s = snapshot({
      workers: [openPr()],
      remoteBranchExists: new Map([[remoteRefKey('ws-1', 'mission/checkout-1234'), false]]),
    });
    expect(reported(key, s)).toEqual(['4242']);
  });

  it('does not report while the mission base still exists on the remote', () => {
    const s = snapshot({
      workers: [openPr()],
      remoteBranchExists: new Map([[remoteRefKey('ws-1', 'mission/checkout-1234'), true]]),
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report when the remote could not be reached — unknown is not gone', () => {
    // This is the only invariant that files a task. An unreachable remote must
    // never be read as a deleted branch.
    const s = snapshot({
      workers: [openPr()],
      remoteBranchExists: new Map([[remoteRefKey('ws-1', 'mission/checkout-1234'), null]]),
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a PR that is already merged', () => {
    const s = snapshot({
      workers: [openPr({ mergedAt: ago(HOUR), prLifecycleStatus: 'merged' })],
      remoteBranchExists: new Map([[remoteRefKey('ws-1', 'mission/checkout-1234'), false]]),
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a PR based on trunk', () => {
    const s = snapshot({
      workers: [openPr({ prBaseRef: 'dev' })],
      remoteBranchExists: new Map([[remoteRefKey('ws-1', 'dev'), false]]),
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report inside the settling threshold', () => {
    const s = snapshot({
      workers: [openPr({ createdAt: ago(2 * MIN) })],
      remoteBranchExists: new Map([[remoteRefKey('ws-1', 'mission/checkout-1234'), false]]),
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 3. task_base_drift ──────────────────────────────────────────────────────

describe('task_base_drift', () => {
  const key = 'task_base_drift' as const;

  const trunk = new Map([['ws-1', new Set(['dev', 'main'])]]);

  it('reports a task assigned a mission base whose PR now sits on trunk', () => {
    const s = snapshot({
      tasks: [task({ id: 't-drift', contextBaseBranch: 'mission/checkout-1234' })],
      workers: [worker({ id: 'w-drift', taskId: 't-drift', prNumber: 91, prBaseRef: 'dev', createdAt: ago(5 * HOUR) })],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual(['t-drift']);
  });

  it('does not report when the PR still sits on the mission base', () => {
    const s = snapshot({
      tasks: [task({ id: 't-ok', contextBaseBranch: 'mission/checkout-1234' })],
      workers: [worker({ id: 'w-ok', taskId: 't-ok', prNumber: 91, prBaseRef: 'mission/checkout-1234', createdAt: ago(5 * HOUR) })],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a task that never asked for a mission base', () => {
    const s = snapshot({
      tasks: [task({ id: 't-direct', contextBaseBranch: 'dev' })],
      workers: [worker({ id: 'w-direct', taskId: 't-direct', prNumber: 91, prBaseRef: 'dev', createdAt: ago(5 * HOUR) })],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report when the PR base is unknown — a null base is not trunk', () => {
    const s = snapshot({
      tasks: [task({ id: 't-unknown', contextBaseBranch: 'mission/checkout-1234' })],
      workers: [worker({ id: 'w-unknown', taskId: 't-unknown', prNumber: 91, prBaseRef: null, createdAt: ago(5 * HOUR) })],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 4. worker_on_integration_branch ─────────────────────────────────────────

describe('worker_on_integration_branch', () => {
  const key = 'worker_on_integration_branch' as const;

  const missions = [
    mission({ id: 'm-int', integrationBranchEnabled: true, workingBranch: 'mission/checkout-1234' }),
  ];

  it('reports a task worker whose PR head is the mission integration branch', () => {
    const s = snapshot({
      missions,
      tasks: [task({ id: 't-on', missionId: 'm-int', taskClass: 'work', title: 'Add the checkout step' })],
      workers: [worker({ id: 'w-on', taskId: 't-on', branch: 'mission/checkout-1234', createdAt: ago(3 * HOUR) })],
    });
    expect(reported(key, s)).toEqual(['w-on']);
  });

  it('does not report the mission-PR owner, whose head IS the integration branch', () => {
    const s = snapshot({
      missions,
      tasks: [
        task({ id: 't-ship', missionId: 'm-int', taskClass: 'bookkeeping', title: 'Ship mission: Checkout arc' }),
      ],
      workers: [worker({ id: 'w-ship', taskId: 't-ship', branch: 'mission/checkout-1234', createdAt: ago(3 * HOUR) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a task worker on its own branch', () => {
    const s = snapshot({
      missions,
      tasks: [task({ id: 't-own', missionId: 'm-int', taskClass: 'work' })],
      workers: [worker({ id: 'w-own', taskId: 't-own', branch: 'buildd/t-own-add-step', createdAt: ago(3 * HOUR) })],
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 5. mission_merged_twice ─────────────────────────────────────────────────

describe('mission_merged_twice', () => {
  const key = 'mission_merged_twice' as const;

  const missions = [
    mission({ id: 'm-int', integrationBranchEnabled: true, workingBranch: 'mission/checkout-1234' }),
  ];
  const trunk = new Map([['ws-1', new Set(['dev', 'main'])]]);

  it('reports a mission with two merged trunk PRs', () => {
    const s = snapshot({
      missions,
      tasks: [task({ id: 't-a', missionId: 'm-int' }), task({ id: 't-b', missionId: 'm-int' })],
      workers: [
        worker({ id: 'w-a', taskId: 't-a', prNumber: 1, prBaseRef: 'dev', mergedAt: ago(3 * HOUR) }),
        worker({ id: 'w-b', taskId: 't-b', prNumber: 2, prBaseRef: 'dev', mergedAt: ago(2 * HOUR) }),
      ],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual(['m-int']);
  });

  it('does not report the one-merge-per-mission happy path', () => {
    const s = snapshot({
      missions,
      tasks: [task({ id: 't-a', missionId: 'm-int' }), task({ id: 't-b', missionId: 'm-int' })],
      workers: [
        worker({ id: 'w-a', taskId: 't-a', prNumber: 1, prBaseRef: 'mission/checkout-1234', mergedAt: ago(3 * HOUR) }),
        worker({ id: 'w-b', taskId: 't-b', prNumber: 2, prBaseRef: 'dev', mergedAt: ago(2 * HOUR) }),
      ],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a direct-strategy mission, where one trunk PR per task is the design', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-direct', integrationBranchEnabled: false })],
      tasks: [task({ id: 't-a', missionId: 'm-direct' }), task({ id: 't-b', missionId: 'm-direct' })],
      workers: [
        worker({ id: 'w-a', taskId: 't-a', prNumber: 1, prBaseRef: 'dev', mergedAt: ago(3 * HOUR) }),
        worker({ id: 'w-b', taskId: 't-b', prNumber: 2, prBaseRef: 'dev', mergedAt: ago(2 * HOUR) }),
      ],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('counts each PR once even when several worker rows carry the same PR number', () => {
    const s = snapshot({
      missions,
      tasks: [task({ id: 't-a', missionId: 'm-int' })],
      workers: [
        worker({ id: 'w-a', taskId: 't-a', prNumber: 1, prBaseRef: 'dev', mergedAt: ago(3 * HOUR) }),
        worker({ id: 'w-a2', taskId: 't-a', prNumber: 1, prBaseRef: 'dev', mergedAt: ago(3 * HOUR) }),
      ],
      trunkBranches: trunk,
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 6. plan_produced_no_children ────────────────────────────────────────────

describe('plan_produced_no_children', () => {
  const key = 'plan_produced_no_children' as const;

  const plan = [
    { ref: 'a', title: 'Step A', description: 'do a' },
    { ref: 'b', title: 'Step B', description: 'do b' },
  ];

  it('reports a completed planning task that produced a plan and no children', () => {
    const s = snapshot({
      tasks: [
        task({ id: 't-plan', mode: 'planning', status: 'completed', planRaw: plan, childCount: 0, updatedAt: ago(6 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual(['t-plan']);
  });

  it('reports the stringified-plan class the approval path could not read', () => {
    const s = snapshot({
      tasks: [
        task({ id: 't-str', mode: 'planning', status: 'completed', planRaw: JSON.stringify(plan), childCount: 0, updatedAt: ago(6 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual(['t-str']);
  });

  it('does not report a plan that produced children', () => {
    const s = snapshot({
      tasks: [
        task({ id: 't-ok', mode: 'planning', status: 'completed', planRaw: plan, childCount: 2, updatedAt: ago(6 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a planning task that legitimately produced no plan', () => {
    const s = snapshot({
      tasks: [
        task({ id: 't-none', mode: 'planning', status: 'completed', planRaw: [], childCount: 0, updatedAt: ago(6 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report inside the threshold', () => {
    const s = snapshot({
      tasks: [
        task({ id: 't-fresh', mode: 'planning', status: 'completed', planRaw: plan, childCount: 0, updatedAt: ago(5 * MIN) }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });
});

describe('countPlanSteps', () => {
  it('accepts an array', () => {
    expect(countPlanSteps([{ ref: 'a' }, { ref: 'b' }])).toBe(2);
  });
  it('accepts a JSON string that parses to an array', () => {
    expect(countPlanSteps('[{"ref":"a"}]')).toBe(1);
  });
  it('is zero for anything else', () => {
    expect(countPlanSteps(undefined)).toBe(0);
    expect(countPlanSteps(null)).toBe(0);
    expect(countPlanSteps('not json')).toBe(0);
    expect(countPlanSteps({ steps: [] })).toBe(0);
  });
});

// ── 7. criteria_escalated_unanswered ────────────────────────────────────────

describe('criteria_escalated_unanswered', () => {
  const key = 'criteria_escalated_unanswered' as const;

  it('reports an escalated mission whose question note is still open past the threshold', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-esc', criteriaEscalatedAt: ago(3 * 24 * HOUR) })],
      notes: [
        { id: 'n-1', missionId: 'm-esc', type: 'question', status: 'open', createdAt: ago(2 * 24 * HOUR) },
      ],
    });
    expect(reported(key, s)).toEqual(['m-esc']);
  });

  it('does not report once the question has been answered', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-ans', criteriaEscalatedAt: ago(3 * 24 * HOUR) })],
      notes: [
        { id: 'n-1', missionId: 'm-ans', type: 'question', status: 'answered', createdAt: ago(2 * 24 * HOUR) },
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a mission that never escalated', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-plain', criteriaEscalatedAt: null })],
      notes: [
        { id: 'n-1', missionId: 'm-plain', type: 'question', status: 'open', createdAt: ago(2 * 24 * HOUR) },
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a question that is only hours old', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-fresh', criteriaEscalatedAt: ago(3 * HOUR) })],
      notes: [
        { id: 'n-1', missionId: 'm-fresh', type: 'question', status: 'open', createdAt: ago(3 * HOUR) },
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 8. stranded_commits ─────────────────────────────────────────────────────

describe('stranded_commits', () => {
  const key = 'stranded_commits' as const;

  it('reports a completed worker that committed code and opened no PR', () => {
    const s = snapshot({
      tasks: [task({ id: 't-s' })],
      workers: [
        worker({ id: 'w-s', taskId: 't-s', status: 'completed', commitCount: 3, prNumber: null, completedAt: ago(5 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual(['w-s']);
  });

  it('does not report a completed worker that opened a PR', () => {
    const s = snapshot({
      tasks: [task({ id: 't-s' })],
      workers: [
        worker({ id: 'w-s', taskId: 't-s', status: 'completed', commitCount: 3, prNumber: 77, completedAt: ago(5 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a completed worker that wrote no code', () => {
    const s = snapshot({
      tasks: [task({ id: 't-s' })],
      workers: [
        worker({ id: 'w-s', taskId: 't-s', status: 'completed', commitCount: 0, prNumber: null, completedAt: ago(5 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a task that declared it owes no output', () => {
    const s = snapshot({
      tasks: [task({ id: 't-none', outputRequirement: 'none' })],
      workers: [
        worker({ id: 'w-none', taskId: 't-none', status: 'completed', commitCount: 3, prNumber: null, completedAt: ago(5 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a worker that is still running', () => {
    const s = snapshot({
      tasks: [task({ id: 't-run' })],
      workers: [
        worker({ id: 'w-run', taskId: 't-run', status: 'working', commitCount: 3, prNumber: null, completedAt: null }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 9. release_without_head ─────────────────────────────────────────────────

describe('release_without_head', () => {
  const key = 'release_without_head' as const;

  it('reports a healthy release with no head sha', () => {
    const s = snapshot({ releases: [release({ id: 'r-nohead', state: 'healthy', headSha: null })] });
    expect(reported(key, s)).toEqual(['r-nohead']);
  });

  it('reports a release with no attribution edges', () => {
    const s = snapshot({ releases: [release({ id: 'r-noattr', attributedTaskCount: 0 })] });
    expect(reported(key, s)).toEqual(['r-noattr']);
  });

  it('does not report a healthy, attributed release', () => {
    const s = snapshot({ releases: [release({ id: 'r-ok' })] });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a failed release, which ships nothing by definition', () => {
    const s = snapshot({ releases: [release({ id: 'r-failed', state: 'failed', headSha: null, attributedTaskCount: 0 })] });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a release still inside the attribution window', () => {
    const s = snapshot({
      releases: [release({ id: 'r-fresh', attributedTaskCount: 0, dispatchedAt: ago(10 * MIN), createdAt: ago(10 * MIN) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report rows that predate the attribution fix', () => {
    // The two known-bad rows in production are healthy-with-null-head-sha and
    // predate the guard that made that impossible. They are excluded by a
    // dispatched-before cutoff, so the sweep does not carry a permanent false
    // positive from its first run.
    const s = snapshot({
      releases: [
        release({
          id: 'r-old',
          headSha: null,
          attributedTaskCount: 0,
          dispatchedAt: new Date('2026-09-04T00:00:00.000Z'),
          createdAt: new Date('2026-09-04T00:00:00.000Z'),
        }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 10. approved_pr_unmerged ────────────────────────────────────────────────

describe('approved_pr_unmerged', () => {
  const key = 'approved_pr_unmerged' as const;

  const greenOpenPr = (over: Partial<SnapshotWorker> = {}) =>
    worker({
      id: 'w-appr',
      taskId: 't-appr',
      prNumber: 500,
      prUrl: 'https://github.com/o/r/pull/500',
      prBaseRef: 'dev',
      prLifecycleStatus: 'ci_green',
      mergedAt: null,
      ...over,
    });

  it('reports an approved, green, still-open PR past the threshold', () => {
    const s = snapshot({
      workers: [greenOpenPr()],
      reviews: [{ prNumber: 500, workspaceId: 'ws-1', verdict: 'approve', decidedAt: ago(6 * HOUR) }],
    });
    expect(reported(key, s)).toEqual(['500']);
  });

  it('does not report once the PR has merged', () => {
    const s = snapshot({
      workers: [greenOpenPr({ mergedAt: ago(HOUR), prLifecycleStatus: 'merged' })],
      reviews: [{ prNumber: 500, workspaceId: 'ws-1', verdict: 'approve', decidedAt: ago(6 * HOUR) }],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a PR whose checks are not green', () => {
    const s = snapshot({
      workers: [greenOpenPr({ prLifecycleStatus: 'ci_failed' })],
      reviews: [{ prNumber: 500, workspaceId: 'ws-1', verdict: 'approve', decidedAt: ago(6 * HOUR) }],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a PR the reviewer asked for changes on', () => {
    const s = snapshot({
      workers: [greenOpenPr()],
      reviews: [{ prNumber: 500, workspaceId: 'ws-1', verdict: 'request-changes', decidedAt: ago(6 * HOUR) }],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report inside the merge window', () => {
    const s = snapshot({
      workers: [greenOpenPr()],
      reviews: [{ prNumber: 500, workspaceId: 'ws-1', verdict: 'approve', decidedAt: ago(10 * MIN) }],
    });
    expect(reported(key, s)).toEqual([]);
  });
});

// ── 11. mission_unverifiable ────────────────────────────────────────────────

describe('mission_unverifiable', () => {
  const key = 'mission_unverifiable' as const;

  it('reports an active mission with no open deliverable work and no verdict', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-limbo', status: 'active', hasGoalCriteria: true, criteriaOverallVerdict: null })],
      tasks: [task({ id: 't-a', missionId: 'm-limbo', status: 'completed', updatedAt: ago(10 * HOUR) })],
    });
    expect(reported(key, s)).toEqual(['m-limbo']);
  });

  it('does not report a mission that still has deliverable work open', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-busy', status: 'active', hasGoalCriteria: true })],
      tasks: [
        task({ id: 't-a', missionId: 'm-busy', status: 'completed', updatedAt: ago(10 * HOUR) }),
        task({ id: 't-b', missionId: 'm-busy', status: 'in_progress', updatedAt: ago(10 * HOUR) }),
      ],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a mission whose criteria already reached a verdict', () => {
    const s = snapshot({
      missions: [
        mission({ id: 'm-done', status: 'active', hasGoalCriteria: true, criteriaOverallVerdict: 'pass' }),
      ],
      tasks: [task({ id: 't-a', missionId: 'm-done', status: 'completed', updatedAt: ago(10 * HOUR) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report during the twenty minutes after the last task completes', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-settling', status: 'active', hasGoalCriteria: true, updatedAt: ago(20 * MIN) })],
      tasks: [task({ id: 't-a', missionId: 'm-settling', status: 'completed', updatedAt: ago(20 * MIN) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a mission that has never had a task', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-empty', status: 'active', hasGoalCriteria: true })],
      tasks: [],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('does not report a mission that is not active', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-paused', status: 'paused', hasGoalCriteria: true })],
      tasks: [task({ id: 't-a', missionId: 'm-paused', status: 'completed', updatedAt: ago(10 * HOUR) })],
    });
    expect(reported(key, s)).toEqual([]);
  });

  it('reports attempt-only remainders — a reviewer task is not deliverable work', () => {
    // Reviewer tasks are taskClass 'attempt' (lib/reviewer.ts). A mission whose
    // only open row is a review of work that already landed is in limbo, not
    // mid-delivery.
    const s = snapshot({
      missions: [mission({ id: 'm-review', status: 'active', hasGoalCriteria: false })],
      tasks: [
        task({ id: 't-a', missionId: 'm-review', status: 'completed', updatedAt: ago(10 * HOUR) }),
        task({
          id: 't-rev',
          missionId: 'm-review',
          status: 'pending',
          taskClass: 'attempt',
          title: '[reviewer] PR #1: X',
          updatedAt: ago(10 * HOUR),
        }),
      ],
    });
    expect(reported(key, s)).toEqual(['m-review']);
  });

  it('reports bookkeeping-only remainders — a mission PR task is not deliverable work', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-book', status: 'active', hasGoalCriteria: true })],
      tasks: [
        task({ id: 't-a', missionId: 'm-book', status: 'completed', updatedAt: ago(10 * HOUR) }),
        task({
          id: 't-ship',
          missionId: 'm-book',
          status: 'pending',
          taskClass: 'bookkeeping',
          title: 'Ship mission: X',
          updatedAt: ago(10 * HOUR),
        }),
      ],
    });
    expect(reported(key, s)).toEqual(['m-book']);
  });
});

// ── Report formatting ───────────────────────────────────────────────────────

describe('formatInvariantReport', () => {
  it('names every invariant, so a clean run is distinguishable from a dead query', () => {
    const results = evaluateInvariants(emptySnapshot(), NOW);
    const text = formatInvariantReport(results, { scanned: { missions: 0, tasks: 0, workers: 0, releases: 0, notes: 0, remoteRefs: 0 } });
    for (const inv of INVARIANTS) expect(text).toContain(inv.key);
    expect(text).toContain('scanned');
  });

  it('carries the offending ids and the remedy for a breach', () => {
    const s = snapshot({
      missions: [mission({ id: 'm-inert', integrationBranchEnabled: true, workingBranch: null })],
      tasks: [task({ id: 't-a', missionId: 'm-inert', createdAt: ago(4 * HOUR) })],
    });
    const text = formatInvariantReport(evaluateInvariants(s, NOW), {
      scanned: { missions: 1, tasks: 1, workers: 0, releases: 0, notes: 0, remoteRefs: 0 },
    });
    expect(text).toContain('m-inert');
    expect(text).toContain(invariantByKey('inert_integration_branch').remedy);
  });

  it('says so out loud when the scan itself found nothing to look at', () => {
    const text = formatInvariantReport(evaluateInvariants(emptySnapshot(), NOW), {
      scanned: { missions: 0, tasks: 0, workers: 0, releases: 0, notes: 0, remoteRefs: 0 },
    });
    expect(text).toContain('EMPTY SCAN');
  });
});
