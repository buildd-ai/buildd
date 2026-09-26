import { describe, it, expect } from 'bun:test';
import { evaluateGoalCriteria, isNoOpenTasksCandidate, type GoalCriterion } from '../mission-helpers';

// ─── evaluateGoalCriteria ──────────────────────────────────────────────────────

const MISSION = { id: 'mission-1', workingBranch: 'feature/my-branch' };
const NOW = '2026-08-08T12:00:00.000Z';

function makeCtx(overrides: Partial<Parameters<typeof evaluateGoalCriteria>[2]> = {}) {
  return {
    tasks: [],
    workers: [],
    artifacts: [],
    evaluatedBy: 'manual' as const,
    now: NOW,
    ...overrides,
  };
}

describe('evaluateGoalCriteria — no-criteria passthrough', () => {
  it('returns pass overall when criteria array is empty', () => {
    const state = evaluateGoalCriteria(MISSION, [], makeCtx());
    expect(state.overall).toBe('pass');
    expect(state.criteria).toHaveLength(0);
    expect(state.evaluatedBy).toBe('manual');
    expect(state.evaluatedAt).toBe(NOW);
  });
});

describe('evaluateGoalCriteria — no_open_tasks', () => {
  const criterion: GoalCriterion = { type: 'no_open_tasks' };

  it('passes when all deliverable tasks are closed', () => {
    const tasks = [
      { id: 't1', title: 'Do work', status: 'completed' },
      { id: 't2', title: 'Do more', status: 'cancelled' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.overall).toBe('pass');
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('fails when an open task exists', () => {
    const tasks = [
      { id: 't1', title: 'Do work', status: 'completed' },
      { id: 't2', title: 'Still pending', status: 'in_progress' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.overall).toBe('fail');
    expect(state.criteria[0].verdict).toBe('fail');
  });

  // A mission's auto-appended `[surface audit]` task is a check, not a
  // deliverable, and the task-level completion gate (pending_deliverables)
  // already holds the mission open while it runs. Counting it here too pinned
  // the criterion at FAIL for as long as the audit sat pending, and the
  // organizer — which can neither plan it away nor declare completion — was
  // re-dispatched on every heartbeat.
  it('does not count a pending [surface audit] task as open', () => {
    const tasks = [
      { id: 't1', title: 'Build the thing', status: 'completed', taskClass: 'work' },
      { id: 't2', title: '[surface audit] My mission', status: 'pending', taskClass: 'work' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('still fails on a real open deliverable alongside a surface audit', () => {
    const tasks = [
      { id: 't1', title: 'Build the thing', status: 'in_progress', taskClass: 'work' },
      { id: 't2', title: '[surface audit] My mission', status: 'pending', taskClass: 'work' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[0].evidence).toContain('1 task(s) still open');
  });

  // Orchestrator ticks, planning passes and retry/reviewer attempts are
  // bookkeeping: an open one must never hold "no open tasks" at FAIL.
  it('does not count open bookkeeping rows or attempts', () => {
    const tasks = [
      { id: 't1', title: 'Build the thing', status: 'completed', taskClass: 'work' },
      { id: 't2', title: 'Mission: Claim loop', status: 'in_progress', taskClass: 'bookkeeping' },
      { id: 't3', title: 'Evaluate goal criteria: Claim loop', status: 'pending', taskClass: 'bookkeeping' },
      { id: 't4', title: '[reviewer] PR #7: Build the thing', status: 'pending', taskClass: 'attempt' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('names the open deliverables in its evidence (title and status)', () => {
    const tasks = [
      { id: 't1', title: 'Build the thing', status: 'in_progress', taskClass: 'work' },
      { id: 't2', title: 'Write the doc', status: 'pending', taskClass: 'work' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.criteria[0].evidence).toBe('2 task(s) still open: Build the thing (in_progress), Write the doc (pending)');
  });

  it('isNoOpenTasksCandidate is the predicate the evaluator counts with', () => {
    expect(isNoOpenTasksCandidate({ title: 'Build', taskClass: 'work' })).toBe(true);
    expect(isNoOpenTasksCandidate({ title: '[surface audit] M', taskClass: 'work' })).toBe(false);
    expect(isNoOpenTasksCandidate({ title: 'Mission: M', taskClass: 'bookkeeping' })).toBe(false);
    expect(isNoOpenTasksCandidate({ title: 'Retry', taskClass: 'attempt' })).toBe(false);
  });

  it('passes when the only tasks are coordination (non-deliverable) tasks', () => {
    const tasks = [
      { id: 't1', kind: 'coordination', title: 'Coordinate', status: 'in_progress' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.overall).toBe('pass');
  });

  it('stores the criterion label when provided', () => {
    const labelledCriterion: GoalCriterion = { type: 'no_open_tasks', label: 'All tasks done' };
    const state = evaluateGoalCriteria(MISSION, [labelledCriterion], makeCtx());
    expect(state.criteria[0].label).toBe('All tasks done');
  });
});

describe('evaluateGoalCriteria — artifact_exists', () => {
  const criterion: GoalCriterion = { type: 'artifact_exists', artifactType: 'summary' };

  it('passes when a matching artifact is present', () => {
    const artifacts = [{ key: 'final', type: 'summary' }];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.overall).toBe('pass');
  });

  it('fails when no matching artifact exists', () => {
    const artifacts = [{ key: 'other', type: 'report' }];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.overall).toBe('fail');
  });

  it('matches on key when specified', () => {
    const keyCriterion: GoalCriterion = { type: 'artifact_exists', key: 'spec-doc' };
    const artifacts = [{ key: 'spec-doc', type: 'content' }];
    const state = evaluateGoalCriteria(MISSION, [keyCriterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('fails when key matches but type does not', () => {
    const strictCriterion: GoalCriterion = { type: 'artifact_exists', key: 'spec-doc', artifactType: 'report' };
    const artifacts = [{ key: 'spec-doc', type: 'content' }];
    const state = evaluateGoalCriteria(MISSION, [strictCriterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('fail');
  });

  it('passes with no filter (any artifact)', () => {
    const anyCriterion: GoalCriterion = { type: 'artifact_exists' };
    const artifacts = [{ key: null, type: 'data' }];
    const state = evaluateGoalCriteria(MISSION, [anyCriterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('pass');
  });
});

describe('evaluateGoalCriteria — all_prs_merged', () => {
  it('is UNVERIFIED (not fail) when the mission has produced no PRs', () => {
    // "No PRs yet" is an absence of evidence, not a contradiction. A hard fail
    // made this criterion unsatisfiable for missions that legitimately produce
    // no PRs; either way it does not pass, so completion is still gated.
    const workers = [{ taskId: 't1', mergedAt: null, prUrl: null, branchName: 'feature/x' }];
    const criterion: GoalCriterion = { type: 'all_prs_merged' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.overall).not.toBe('pass');
    expect(state.criteria[0].evidence).toContain('No PRs found');
  });

  it('fails when a PR is not merged', () => {
    const workers = [
      { taskId: 't1', mergedAt: null, prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: false };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[0].evidence).toContain('1 PR(s) not yet merged');
  });

  it('passes when all PRs merged and requireBranchDeleted=false', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: false };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('passes when all PRs merged and requireBranchDeleted not set (default false)', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    // branchDeleted is undefined but requireBranchDeleted defaults to false — pass on mergedAt alone
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.overall).toBe('pass');
  });

  // `requireBranchDeleted` is retired, not implemented. Nothing in this
  // codebase has ever written a branch-deletion signal — there is no
  // `workers.branch_deleted` column and no webhook handler for a deleted ref —
  // so the option could only ever resolve to UNVERIFIED, which made a mission
  // that ticked the box permanently uncompletable. A knob that can only block
  // is worse than no knob. Under Option A' the meaningful form of "the mission
  // branch is gone" is "the mission PR merged into trunk", which the criterion
  // now checks for real.
  it('ignores requireBranchDeleted rather than blocking on a signal nothing produces', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: true };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.overall).toBe('pass');
  });

  it('says plainly in its evidence that branch deletion was not verified', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: true };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].evidence).toContain('branch deletion is not verified');
  });
});

// PR supersession was taught to `canCompleteMission` and never to this
// criterion, so a mission whose closed PRs all carried recorded edges to merged
// PRs still read "N PR(s) not yet merged" forever. Both now share
// `@buildd/core/pr-shipped`.
describe('evaluateGoalCriteria — all_prs_merged honours PR supersession', () => {
  const criterion: GoalCriterion = { type: 'all_prs_merged' };
  const pr = (n: number) => `https://github.com/org/repo/pull/${n}`;

  it('passes when a closed PR carries an edge to a merged PR', () => {
    const workers = [
      { taskId: 't1', mergedAt: null, prUrl: pr(10), prNumber: 10, prLifecycleStatus: 'closed', supersededByPrNumber: 12 },
      { taskId: 't2', mergedAt: new Date('2026-01-01'), prUrl: pr(12), prNumber: 12, prLifecycleStatus: 'merged' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[0].evidence).toContain('superseded');
  });

  it('fails a closed PR with no edge, naming it and saying no supersession is recorded', () => {
    const workers = [
      { taskId: 't1', mergedAt: null, prUrl: pr(10), prNumber: 10, prLifecycleStatus: 'closed' },
      { taskId: 't2', mergedAt: new Date('2026-01-01'), prUrl: pr(12), prNumber: 12 },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[0].evidence).toContain('closed, no supersession recorded: #10');
    expect(state.criteria[0].evidence).not.toContain('open:');
  });

  it('regression (M4): an open PR with changes requested still fails, listed as open', () => {
    const workers = [
      { taskId: 't1', mergedAt: null, prUrl: pr(20), prNumber: 20, prLifecycleStatus: 'pr_open' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[0].evidence).toContain('open: #20');
  });

  it('derives supersession from the attempt lineage: closed PR, then a merged retry PR', () => {
    const tasks = [
      { id: 'root', status: 'completed', title: 'Build', taskClass: 'work', parentTaskId: null },
      { id: 'retry', status: 'completed', title: 'Build (after review)', taskClass: 'attempt', parentTaskId: 'root' },
    ];
    const workers = [
      { taskId: 'root', mergedAt: null, prUrl: pr(30), prNumber: 30, prLifecycleStatus: 'closed' },
      { taskId: 'retry', mergedAt: new Date('2026-01-01'), prUrl: pr(31), prNumber: 31 },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks, workers }));
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('counts a PR once when two worker rows carry it and only one saw the merge', () => {
    const workers = [
      { taskId: 't1', mergedAt: null, prUrl: pr(40), prNumber: 40 },
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: pr(40), prNumber: 40 },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[0].evidence).toContain('All 1 PR(s) merged');
  });
});

// ─── Option A': all_prs_merged is base-ref aware ──────────────────────────────
//
// The inherited false green this closes: with task PRs based on the mission's
// integration branch, "every PR under this mission has merged" was true the
// moment the last task PR merged into that branch — with nothing at all on
// trunk. The criterion now also requires the mission's own PR into trunk.

const INTEGRATION_BRANCH = 'mission/illustrative-goal';
const TRUNK = 'dev';

/** A mission that has opted in to the integration branch. */
const OPTED_IN = {
  id: 'mission-1',
  workingBranch: INTEGRATION_BRANCH,
  integrationBranchEnabled: true,
};

/** The same mission before anyone flipped the flag. */
const NOT_OPTED_IN = {
  id: 'mission-1',
  workingBranch: INTEGRATION_BRANCH,
  integrationBranchEnabled: false,
};

const TASK_PR_TASK = { id: 'task-a', status: 'completed', taskClass: 'work', title: 'Do the work' };
const MISSION_PR_TASK = {
  id: 'ship-a',
  status: 'completed',
  taskClass: 'bookkeeping',
  title: 'Ship mission: Illustrative goal',
};

function taskPrWorker(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-a',
    mergedAt: new Date('2026-01-01'),
    prUrl: 'https://github.example/pr/1',
    branchName: 'task/a',
    prBaseRef: INTEGRATION_BRANCH,
    ...overrides,
  };
}

function missionPrWorker(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'ship-a',
    mergedAt: new Date('2026-01-02'),
    prUrl: 'https://github.example/pr/9',
    branchName: INTEGRATION_BRANCH,
    prBaseRef: TRUNK,
    ...overrides,
  };
}

describe("evaluateGoalCriteria — all_prs_merged under Option A'", () => {
  const criterion: GoalCriterion = { type: 'all_prs_merged' };

  it('behaves exactly as before for a mission that has not opted in', () => {
    // The whole safety argument for shipping this: with the flag off, a merged
    // task PR still passes, even when its base ref happens to name a
    // `mission/…` branch. Nothing about an existing mission changes.
    const state = evaluateGoalCriteria(
      NOT_OPTED_IN,
      [criterion],
      makeCtx({ tasks: [TASK_PR_TASK], workers: [taskPrWorker()] }),
    );
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.overall).toBe('pass');
  });

  it('does not pass when every task PR has merged but no mission PR exists yet', () => {
    const state = evaluateGoalCriteria(
      OPTED_IN,
      [criterion],
      makeCtx({ tasks: [TASK_PR_TASK], workers: [taskPrWorker()] }),
    );
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.overall).not.toBe('pass');
    expect(state.criteria[0].evidence).toContain(INTEGRATION_BRANCH);
    expect(state.criteria[0].evidence).toContain('no PR into trunk');
  });

  it('fails while the mission PR is open, and clears when it merges', () => {
    const open = evaluateGoalCriteria(
      OPTED_IN,
      [criterion],
      makeCtx({
        tasks: [TASK_PR_TASK, MISSION_PR_TASK],
        workers: [taskPrWorker(), missionPrWorker({ mergedAt: null })],
      }),
    );
    expect(open.criteria[0].verdict).toBe('fail');

    const merged = evaluateGoalCriteria(
      OPTED_IN,
      [criterion],
      makeCtx({
        tasks: [TASK_PR_TASK, MISSION_PR_TASK],
        workers: [taskPrWorker(), missionPrWorker()],
      }),
    );
    expect(merged.criteria[0].verdict).toBe('pass');
    expect(merged.criteria[0].evidence).toContain(TRUNK);
  });

  it('does not accept a mission PR whose base ref is unknown as a landing on trunk', () => {
    // `workers.prBaseRef` is null for "we do not know". Reading that as trunk is
    // the one direction that invents a green.
    const state = evaluateGoalCriteria(
      OPTED_IN,
      [criterion],
      makeCtx({
        tasks: [TASK_PR_TASK, MISSION_PR_TASK],
        workers: [taskPrWorker(), missionPrWorker({ prBaseRef: null })],
      }),
    );
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.criteria[0].evidence).toContain('base ref');
  });

  it('does not accept a mission PR aimed back at the integration branch', () => {
    const state = evaluateGoalCriteria(
      OPTED_IN,
      [criterion],
      makeCtx({
        tasks: [TASK_PR_TASK, MISSION_PR_TASK],
        workers: [taskPrWorker(), missionPrWorker({ prBaseRef: INTEGRATION_BRANCH })],
      }),
    );
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
  });

  it('still requires a task PR based on trunk to have merged', () => {
    // A task PR opened before the mission opted in targets trunk directly. It
    // is deliverable work either way, so it must still be merged.
    const state = evaluateGoalCriteria(
      OPTED_IN,
      [criterion],
      makeCtx({
        tasks: [TASK_PR_TASK, MISSION_PR_TASK],
        workers: [
          taskPrWorker({ prBaseRef: TRUNK, mergedAt: null }),
          missionPrWorker(),
        ],
      }),
    );
    expect(state.criteria[0].verdict).toBe('fail');
  });

  it('is UNVERIFIED, not pass, for an opted-in mission with no PRs at all', () => {
    const state = evaluateGoalCriteria(OPTED_IN, [criterion], makeCtx({ tasks: [TASK_PR_TASK] }));
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.criteria[0].evidence).toContain('No PRs found');
  });

  // Regression: a CI-retry task pushes to its parent's PR, so two worker rows
  // carry one PR. The evidence counted rows ("All 2 task PR(s)").
  it('counts a task PR a CI retry also pushed to once', () => {
    const RETRY_TASK = { id: 'task-a-ci', status: 'completed', taskClass: 'attempt', parentTaskId: 'task-a', title: '[builder · after CI #1] Do the work' };
    const state = evaluateGoalCriteria(
      OPTED_IN,
      [criterion],
      makeCtx({
        tasks: [TASK_PR_TASK, RETRY_TASK, MISSION_PR_TASK],
        workers: [taskPrWorker(), taskPrWorker({ taskId: 'task-a-ci', mergedAt: null }), missionPrWorker()],
      }),
    );
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[0].evidence).toContain('All 1 task PR(s) merged');
  });
});

describe('evaluateGoalCriteria — all_prs_merged counts PRs, not worker rows', () => {
  it('a parent and its CI retry sharing one PR read as one merged PR', () => {
    const state = evaluateGoalCriteria(
      NOT_OPTED_IN,
      [{ type: 'all_prs_merged' }],
      makeCtx({
        tasks: [TASK_PR_TASK, { id: 'task-a-ci', status: 'completed', taskClass: 'attempt', parentTaskId: 'task-a', title: '[builder · after CI #1] Do the work' }],
        workers: [taskPrWorker(), taskPrWorker({ taskId: 'task-a-ci', mergedAt: null })],
      }),
    );
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[0].evidence).toBe('All 1 PR(s) merged');
  });
});

describe('evaluateGoalCriteria — command criterion', () => {
  it('returns NOT_EVALUATED awaiting a verification run (never graded inline)', () => {
    const criterion: GoalCriterion = { type: 'command', command: 'bun test' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    // NOT_EVALUATED = never checked. The pure evaluator cannot run a command;
    // the DB layer dispatches a verification task and the exit code decides.
    expect(state.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state.overall).toBe('UNVERIFIED');
    expect(state.criteria[0].evidence).toContain('Awaiting verification run');
    expect(state.criteria[0].evidence).toContain('bun test');
  });
});

describe('evaluateGoalCriteria — metric criterion', () => {
  it('always returns UNVERIFIED (metric query not implemented)', () => {
    const criterion: GoalCriterion = { type: 'metric', query: 'error_rate', operator: 'lt', threshold: 0.01 };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.criteria[0].evidence).toContain('not implemented');
  });
});

describe('evaluateGoalCriteria — description criterion', () => {
  it('returns NOT_EVALUATED awaiting LLM evaluation', () => {
    const criterion: GoalCriterion = { type: 'description', description: 'Scorecard artifact produced covering all retrieval layers' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    expect(state.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state.criteria[0].evidence).toContain('Awaiting LLM evaluation');
    // NOT_EVALUATED does not drag overall down — no evaluated criteria → UNVERIFIED
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('records the criterion label when provided', () => {
    const criterion: GoalCriterion = { type: 'description', description: 'All gaps closed', label: 'Gaps resolved' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    expect(state.criteria[0].label).toBe('Gaps resolved');
  });

  it('overall=UNVERIFIED when structural criterion passes but description is NOT_EVALUATED', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'description', description: 'BM25 lexical search is functional' },
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[1].verdict).toBe('NOT_EVALUATED');
    // NOT_EVALUATED blocks 'pass' — overall is UNVERIFIED until LLM evaluates the description
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('overall=fail when structural criterion fails even with description NOT_EVALUATED', () => {
    const criteria: GoalCriterion[] = [
      { type: 'artifact_exists', artifactType: 'report' }, // fails (no artifacts)
      { type: 'description', description: 'BM25 lexical search is functional' },
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[1].verdict).toBe('NOT_EVALUATED');
    expect(state.overall).toBe('fail');
  });
});

describe('evaluateGoalCriteria — overall verdict logic', () => {
  it('overall=pass when all criteria pass', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'artifact_exists' },
    ];
    const artifacts = [{ key: null, type: 'summary' }];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx({ artifacts }));
    expect(state.overall).toBe('pass');
  });

  it('overall=fail when any criterion fails (even with pass criteria)', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'artifact_exists', artifactType: 'report' }, // will fail (no artifacts)
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.overall).toBe('fail');
  });

  it('overall=UNVERIFIED when some pass and some lack a verdict (no fail)', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },   // pass (no tasks)
      { type: 'metric', query: 'error_rate', operator: 'lt', threshold: 1 }, // UNVERIFIED
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[1].verdict).toBe('UNVERIFIED');
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('overall=UNVERIFIED when structural criterion passes but description is NOT_EVALUATED', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },   // pass
      { type: 'description', description: 'some free-form check' }, // NOT_EVALUATED
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[1].verdict).toBe('NOT_EVALUATED');
    // NOT_EVALUATED blocks 'pass' — the LLM layer must upgrade it before the mission can complete
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('overall=UNVERIFIED when all criteria are NOT_EVALUATED', () => {
    const criteria: GoalCriterion[] = [
      { type: 'description', description: 'criterion one' },
      { type: 'description', description: 'criterion two' },
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria.every(c => c.verdict === 'NOT_EVALUATED')).toBe(true);
    // No evaluated criteria → UNVERIFIED (conservative)
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('fail takes precedence over UNVERIFIED in overall verdict', () => {
    const criteria: GoalCriterion[] = [
      { type: 'command', command: 'test' }, // NOT_EVALUATED (awaiting a run)
      { type: 'artifact_exists', artifactType: 'report' }, // fail (no artifact)
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.overall).toBe('fail');
  });

  it('criterion indexes are sequential', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'command', command: 'test' },
      { type: 'artifact_exists' },
    ];
    const artifacts = [{ key: null, type: 'summary' }];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx({ artifacts }));
    expect(state.criteria.map(c => c.index)).toEqual([0, 1, 2]);
  });
});

describe('evaluateGoalCriteria — evaluatedBy attribution', () => {
  it('records the evaluatedBy from context', () => {
    const state = evaluateGoalCriteria(MISSION, [], { tasks: [], workers: [], artifacts: [], evaluatedBy: 'auto', now: NOW });
    expect(state.evaluatedBy).toBe('auto');
  });

  it('records mcp attribution', () => {
    const state = evaluateGoalCriteria(MISSION, [], { tasks: [], workers: [], artifacts: [], evaluatedBy: 'mcp', now: NOW });
    expect(state.evaluatedBy).toBe('mcp');
  });
});

