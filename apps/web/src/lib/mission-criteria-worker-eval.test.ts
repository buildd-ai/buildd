import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * Batched worker evaluator for mission criteria.
 *
 * Covers:
 * - In-flight dedup: a second call while a task is pending returns the same taskId
 * - workerTaskId populated on criterion state when a verdict is written back
 * - Failed/reaped evaluator → NOT_EVALUATED with a reason naming the failed task
 * - Overall does not resolve to pass when a criterion is NOT_EVALUATED
 * - Unavailable when mission has no workspace
 */

// ── Mock state ────────────────────────────────────────────────────────────────
let missionRow: any = null;
let missionFindFirstByIdRow: any = null;  // used by handleCriteriaWorkerEvalOutcome
let workspaceRow: any = null;
let taskFindFirstResult: any = null;
let taskFindManyRows: any[] = [];
let insertReturning: any[] = [{ id: 'worker-eval-task-1' }];
const insertedValues: any[] = [];
const updateCalls: any[] = [];

const mockDispatchNewTask = mock(() => Promise.resolve());
const mockCompleteMissionIfVerified = mock((_id: string, _opts: any) =>
  Promise.resolve({ completed: false, decision: { ok: false, code: 'criteria_unverified', reason: 'stub' } }) as any);

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  desc: (col: any) => ({ _op: 'desc', col }),
  sql: (...args: any[]) => ({ _op: 'sql', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: { missionId: 'mission_id', id: 'id', createdAt: 'created_at', context: 'context' },
  workspaces: Symbol('workspaces'),
}));

// The db mock distinguishes between missions.findFirst calls by checking whether
// missionFindFirstByIdRow is set. When set, the second missions.findFirst call
// (from handleCriteriaWorkerEvalOutcome, which queries by task.missionId) returns
// missionFindFirstByIdRow; otherwise falls back to missionRow.
let missionFindFirstCallCount = 0;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: () => {
          const count = missionFindFirstCallCount++;
          // handleCriteriaWorkerEvalOutcome makes two calls: first fetches the task
          // (via tasks.findFirst), then the mission. Here mission is the second call.
          return Promise.resolve(missionFindFirstByIdRow ?? missionRow);
        },
      },
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
      tasks: {
        findFirst: () => Promise.resolve(taskFindFirstResult),
        findMany: () => Promise.resolve(taskFindManyRows),
      },
    },
    insert: () => ({
      values: (v: any) => {
        insertedValues.push(v);
        return { returning: () => Promise.resolve(insertReturning) };
      },
    }),
    update: () => ({
      set: (data: any) => {
        updateCalls.push(data);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

mock.module('@buildd/core/mission-helpers', () => ({
  recalculateOverall: (criteria: any[]) => {
    if (criteria.some((c: any) => c.verdict === 'fail')) return 'fail';
    if (criteria.every((c: any) => c.verdict === 'pass')) return 'pass';
    if (criteria.some((c: any) => c.verdict === 'PENDING')) return 'PENDING';
    return 'NOT_EVALUATED';
  },
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@/lib/mission-completion', () => ({
  completeMissionIfVerified: mockCompleteMissionIfVerified,
}));

const {
  resolveCriteriaWorkerEval,
  handleCriteriaWorkerEvalOutcome,
  isCriteriaWorkerEvalTask,
  WORKER_EVAL_TTL_MS,
} = await import('./mission-criteria-worker-eval');

function resetAll() {
  missionRow = null;
  missionFindFirstByIdRow = null;
  missionFindFirstCallCount = 0;
  workspaceRow = null;
  taskFindFirstResult = null;
  taskFindManyRows = [];
  insertReturning = [{ id: 'worker-eval-task-1' }];
  insertedValues.length = 0;
  updateCalls.length = 0;
  mockDispatchNewTask.mockClear();
  mockCompleteMissionIfVerified.mockClear();
}

// ── isCriteriaWorkerEvalTask ──────────────────────────────────────────────────

describe('isCriteriaWorkerEvalTask', () => {
  it('recognises the criteriaWorkerEval marker', () => {
    expect(isCriteriaWorkerEvalTask({
      criteriaWorkerEval: { missionId: 'm1', criterionIndices: [0], fingerprints: [''] },
    })).toBe(true);
  });

  it('rejects other marker shapes', () => {
    expect(isCriteriaWorkerEvalTask({ criteriaVerification: { missionId: 'm1', criterionIndex: 0 } })).toBe(false);
    expect(isCriteriaWorkerEvalTask({ criteriaProseEval: { missionId: 'm1', criterionIndices: [] } })).toBe(false);
    expect(isCriteriaWorkerEvalTask(null)).toBe(false);
    expect(isCriteriaWorkerEvalTask({})).toBe(false);
  });
});

// ── resolveCriteriaWorkerEval ─────────────────────────────────────────────────

describe('resolveCriteriaWorkerEval', () => {
  beforeEach(resetAll);

  it('returns unavailable when criteria list is empty', async () => {
    missionRow = { id: 'm1', title: 'T', description: null, workspaceId: 'ws1', workingBranch: null };
    const res = await resolveCriteriaWorkerEval({ missionId: 'm1', criteria: [] });
    expect(res.kind).toBe('unavailable');
  });

  it('returns unavailable when mission not found', async () => {
    missionRow = null;
    const res = await resolveCriteriaWorkerEval({
      missionId: 'missing',
      criteria: [{ index: 0, type: 'description', text: 'X' }],
    });
    expect(res.kind).toBe('unavailable');
  });

  it('returns unavailable when mission has no workspace', async () => {
    missionRow = { id: 'm1', title: 'T', description: null, workspaceId: null, workingBranch: null };
    const res = await resolveCriteriaWorkerEval({
      missionId: 'm1',
      criteria: [{ index: 0, type: 'description', text: 'X' }],
    });
    expect(res.kind).toBe('unavailable');
    expect(res.evidence).toMatch(/no workspace/i);
  });

  it('dispatches a new bookkeeping task and returns pending', async () => {
    missionRow = { id: 'm1', title: 'Mission', description: null, workspaceId: 'ws1', workingBranch: 'main' };
    workspaceRow = { id: 'ws1', name: 'WS' };
    taskFindManyRows = [];

    const res = await resolveCriteriaWorkerEval({
      missionId: 'm1',
      criteria: [
        { index: 0, type: 'description', text: 'All tests pass', fingerprint: 'fp1' },
        { index: 1, type: 'command', text: 'bun test', command: 'bun test', fingerprint: 'fp2' },
      ],
    });

    expect(res.kind).toBe('pending');
    expect((res as any).taskId).toBe('worker-eval-task-1');
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);

    // Verify the inserted task carries the correct marker
    expect(insertedValues).toHaveLength(1);
    const inserted = insertedValues[0];
    expect(inserted.taskClass).toBe('bookkeeping');
    expect(inserted.outputRequirement).toBe('none');
    expect(inserted.context.criteriaWorkerEval.missionId).toBe('m1');
    expect(inserted.context.criteriaWorkerEval.criterionIndices).toEqual([0, 1]);
    expect(inserted.context.criteriaWorkerEval.fingerprints).toEqual(['fp1', 'fp2']);
    // Auto-retry opt-out
    expect(inserted.context.retryCount).toBe(1);
  });

  it('deduplicates: in-flight task → pending with same taskId, no new dispatch', async () => {
    missionRow = { id: 'm1', title: 'M', description: null, workspaceId: 'ws1', workingBranch: null };
    workspaceRow = { id: 'ws1', name: 'WS' };
    taskFindManyRows = [
      {
        id: 'in-flight-task',
        status: 'in_progress',
        context: {
          criteriaWorkerEval: { missionId: 'm1', criterionIndices: [0], fingerprints: ['fp1'] },
        },
        result: null,
        updatedAt: new Date(),
      },
    ];

    const res = await resolveCriteriaWorkerEval({
      missionId: 'm1',
      criteria: [{ index: 0, type: 'description', text: 'All tests pass', fingerprint: 'fp1' }],
    });

    expect(res.kind).toBe('pending');
    expect((res as any).taskId).toBe('in-flight-task');
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('shows stall message when pending task has been waiting > 2× TTL', async () => {
    missionRow = { id: 'm1', title: 'M', description: null, workspaceId: 'ws1', workingBranch: null };
    workspaceRow = { id: 'ws1', name: 'WS' };
    const staleDate = new Date(Date.now() - 3 * WORKER_EVAL_TTL_MS);
    taskFindManyRows = [
      {
        id: 'stalled-eval',
        status: 'pending',
        context: { criteriaWorkerEval: { missionId: 'm1', criterionIndices: [0], fingerprints: ['fp1'] } },
        result: null,
        updatedAt: staleDate,
      },
    ];

    const res = await resolveCriteriaWorkerEval({
      missionId: 'm1',
      criteria: [{ index: 0, type: 'description', text: 'X', fingerprint: 'fp1' }],
    });

    expect(res.kind).toBe('pending');
    expect(res.evidence).toMatch(/stalled-/);
    expect(res.evidence).toMatch(/no runner has claimed it/);
  });

  it('returns unavailable (with reason) when prior task finished without verdicts within TTL', async () => {
    missionRow = { id: 'm1', title: 'M', description: null, workspaceId: 'ws1', workingBranch: null };
    workspaceRow = { id: 'ws1', name: 'WS' };
    const recentDate = new Date(Date.now() - 1000); // 1s ago — within TTL
    taskFindManyRows = [
      {
        id: 'empty-task',
        status: 'completed',
        context: { criteriaWorkerEval: { missionId: 'm1', criterionIndices: [0], fingerprints: ['fp1'] } },
        result: { structuredOutput: null }, // no usable verdicts
        updatedAt: recentDate,
      },
    ];

    const res = await resolveCriteriaWorkerEval({
      missionId: 'm1',
      criteria: [{ index: 0, type: 'description', text: 'X', fingerprint: 'fp1' }],
    });

    expect(res.kind).toBe('unavailable');
    expect(res.evidence).toMatch(/finished without returning verdicts/);
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('re-dispatches when prior task is stale (past TTL)', async () => {
    missionRow = { id: 'm1', title: 'M', description: null, workspaceId: 'ws1', workingBranch: null };
    workspaceRow = { id: 'ws1', name: 'WS' };
    const staleDate = new Date(Date.now() - 2 * WORKER_EVAL_TTL_MS);
    taskFindManyRows = [
      {
        id: 'old-task',
        status: 'completed',
        context: { criteriaWorkerEval: { missionId: 'm1', criterionIndices: [0], fingerprints: ['fp1'] } },
        result: { structuredOutput: null },
        updatedAt: staleDate,
      },
    ];

    const res = await resolveCriteriaWorkerEval({
      missionId: 'm1',
      criteria: [{ index: 0, type: 'description', text: 'X', fingerprint: 'fp1' }],
    });

    expect(res.kind).toBe('pending');
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });
});

// ── handleCriteriaWorkerEvalOutcome ──────────────────────────────────────────

describe('handleCriteriaWorkerEvalOutcome', () => {
  beforeEach(resetAll);

  const workerEvalContext = {
    criteriaWorkerEval: { missionId: 'm1', criterionIndices: [0, 1], fingerprints: ['fp1', 'fp2'] },
  };

  const baseMissionGoalCriteria = [
    { type: 'description', description: 'All tests pass', label: 'tests', notMechanizableReason: 'r' },
    { type: 'command', command: 'bun test', label: 'unit tests' },
  ];

  const baseCriteriaState = {
    evaluatedAt: '2026-01-01T00:00:00Z',
    evaluatedBy: 'auto' as const,
    overall: 'PENDING' as const,
    criteria: [
      { index: 0, type: 'description', verdict: 'PENDING' as const, fingerprint: 'fp1' },
      { index: 1, type: 'command', verdict: 'PENDING' as const, fingerprint: 'fp2' },
    ],
  };

  it('returns applied=false when task not found', async () => {
    taskFindFirstResult = null;
    const res = await handleCriteriaWorkerEvalOutcome('no-such-task');
    expect(res.applied).toBe(false);
  });

  it('returns applied=false when task has no criteriaWorkerEval marker', async () => {
    taskFindFirstResult = {
      id: 't1', status: 'completed', context: {}, result: null, missionId: 'm1',
    };
    const res = await handleCriteriaWorkerEvalOutcome('t1');
    expect(res.applied).toBe(false);
  });

  it('returns applied=false when task is not yet terminal', async () => {
    taskFindFirstResult = {
      id: 't1', status: 'in_progress', context: workerEvalContext, result: null, missionId: 'm1',
    };
    const res = await handleCriteriaWorkerEvalOutcome('t1');
    expect(res.applied).toBe(false);
  });

  it('returns applied=false when mission has no criteria state', async () => {
    taskFindFirstResult = {
      id: 't1', status: 'completed', context: workerEvalContext, result: null, missionId: 'm1',
    };
    missionFindFirstByIdRow = { id: 'm1', goalCriteria: baseMissionGoalCriteria, goalCriteriaState: null };
    const res = await handleCriteriaWorkerEvalOutcome('t1');
    expect(res.applied).toBe(false);
  });

  it('applies verdicts and sets workerTaskId on each criterion', async () => {
    taskFindFirstResult = {
      id: 'eval-task-1',
      status: 'completed',
      context: workerEvalContext,
      result: null,
      missionId: 'm1',
    };
    missionFindFirstByIdRow = {
      id: 'm1',
      goalCriteria: baseMissionGoalCriteria,
      goalCriteriaState: JSON.parse(JSON.stringify(baseCriteriaState)),
    };

    const structuredOutput = {
      criteriaVerdicts: [
        { index: 0, verdict: 'pass', evidence: 'Tests all pass' },
        { index: 1, verdict: 'fail', evidence: 'Exit code 1' },
      ],
    };

    const res = await handleCriteriaWorkerEvalOutcome('eval-task-1', structuredOutput);
    expect(res.applied).toBe(true);

    // Verify the mission state was updated with verdicts
    expect(updateCalls).toHaveLength(1);
    const saved = updateCalls[0].goalCriteriaState;
    const c0 = saved.criteria.find((c: any) => c.index === 0);
    const c1 = saved.criteria.find((c: any) => c.index === 1);
    expect(c0.verdict).toBe('pass');
    expect(c0.workerTaskId).toBe('eval-task-1');
    expect(c1.verdict).toBe('fail');
    expect(c1.workerTaskId).toBe('eval-task-1');
    expect(saved.overall).toBe('fail');

    // Completion was attempted
    expect(mockCompleteMissionIfVerified).toHaveBeenCalledTimes(1);
  });

  it('sets NOT_EVALUATED (not pass) when evaluator task failed without verdicts', async () => {
    taskFindFirstResult = {
      id: 'failed-task',
      status: 'failed',
      context: workerEvalContext,
      result: null,
      missionId: 'm1',
    };
    missionFindFirstByIdRow = {
      id: 'm1',
      goalCriteria: baseMissionGoalCriteria,
      goalCriteriaState: JSON.parse(JSON.stringify(baseCriteriaState)),
    };

    // No structuredOutput — evaluator task failed with nothing
    const res = await handleCriteriaWorkerEvalOutcome('failed-task', undefined);
    expect(res.applied).toBe(true);  // marker processed, even if no verdicts returned

    const saved = updateCalls[0].goalCriteriaState;
    for (const cs of saved.criteria) {
      expect(cs.verdict).toBe('NOT_EVALUATED');
      expect(cs.evidence).toMatch(/failed-task|failed/i);
    }
    // overall must NOT be pass
    expect(saved.overall).not.toBe('pass');
  });

  it('sets NOT_EVALUATED when structuredOutput is empty array', async () => {
    taskFindFirstResult = {
      id: 'empty-task',
      status: 'completed',
      context: workerEvalContext,
      result: { structuredOutput: { criteriaVerdicts: [] } },
      missionId: 'm1',
    };
    missionFindFirstByIdRow = {
      id: 'm1',
      goalCriteria: baseMissionGoalCriteria,
      goalCriteriaState: JSON.parse(JSON.stringify(baseCriteriaState)),
    };

    await handleCriteriaWorkerEvalOutcome('empty-task');

    const saved = updateCalls[0].goalCriteriaState;
    for (const cs of saved.criteria) {
      expect(cs.verdict).toBe('NOT_EVALUATED');
    }
    expect(saved.overall).not.toBe('pass');
  });

  it('discards verdict when criterion was edited (fingerprint mismatch)', async () => {
    const staleContext = {
      criteriaWorkerEval: {
        missionId: 'm1',
        criterionIndices: [0],
        fingerprints: ['old-fp'],  // old fingerprint
      },
    };
    taskFindFirstResult = {
      id: 'stale-task',
      status: 'completed',
      context: staleContext,
      result: null,
      missionId: 'm1',
    };
    const stateWithNewFp = {
      ...baseCriteriaState,
      criteria: [{ index: 0, type: 'description', verdict: 'PENDING' as const, fingerprint: 'new-fp' }],
    };
    missionFindFirstByIdRow = {
      id: 'm1',
      goalCriteria: baseMissionGoalCriteria,
      goalCriteriaState: JSON.parse(JSON.stringify(stateWithNewFp)),
    };

    await handleCriteriaWorkerEvalOutcome('stale-task', {
      criteriaVerdicts: [{ index: 0, verdict: 'pass', evidence: 'ok' }],
    });

    const saved = updateCalls[0].goalCriteriaState;
    const c0 = saved.criteria.find((c: any) => c.index === 0);
    // Fingerprint mismatch — verdict discarded, set to NOT_EVALUATED
    expect(c0.verdict).toBe('NOT_EVALUATED');
    expect(c0.verdict).not.toBe('pass');
  });
});
