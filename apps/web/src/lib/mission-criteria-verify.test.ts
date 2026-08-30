import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * `command` criteria: the mechanizable form.
 *
 * A prose criterion's verdict depends on a model being reachable at the moment
 * it is needed. A command's verdict depends on an exit code. This module turns
 * the second into the default by reusing the loop-until-verified machinery: the
 * runner executes the command and returns evidence bound to (workerId,
 * iteration), and that evidence — not an agent's summary — is the verdict.
 */

// ── Mock state ────────────────────────────────────────────────────────────────
let missionRow: any = null;
let workspaceRow: any = null;
let taskFindFirstRow: any = null;
let taskFindManyRows: any[] = [];
let insertReturning: any[] = [{ id: 'verify-task-1' }];
const insertedValues: any[] = [];
const updateCalls: any[] = [];

const mockDispatchNewTask = mock(() => Promise.resolve());
const mockCompleteMissionIfVerified = mock((_id: string, _opts: any) => Promise.resolve({ completed: false, decision: { ok: false, code: 'criteria_unverified', reason: 'stub' } }) as any);

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  desc: (col: any) => ({ _op: 'desc', col }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: { missionId: 'mission_id', taskClass: 'task_class', id: 'id', createdAt: 'created_at' },
  workspaces: Symbol('workspaces'),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve(missionRow) },
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
      tasks: {
        findFirst: () => Promise.resolve(taskFindFirstRow),
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

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@/lib/mission-completion', () => ({
  completeMissionIfVerified: mockCompleteMissionIfVerified,
}));

// Real recalculateOverall from core — the folding rule is not stubbed.
import {
  resolveCommandCriterion,
  handleCriteriaVerificationOutcome,
  isCriteriaVerificationTask,
  COMMAND_VERDICT_TTL_MS,
} from './mission-criteria-verify';

const COMMAND = 'bun run scripts/run-unit-tests.ts apps/web/src/lib/foo.test.ts';

function marker(command = COMMAND, criterionIndex = 0, missionId = 'm1') {
  return { criteriaVerification: { missionId, criterionIndex, command } };
}

function reset() {
  missionRow = { id: 'm1', title: 'Empty-source rendering', workspaceId: 'ws-1', workingBranch: 'mission/m1' };
  workspaceRow = { id: 'ws-1', name: 'buildd', repo: 'https://github.com/buildd-ai/buildd' };
  taskFindFirstRow = null;
  taskFindManyRows = [];
  insertReturning = [{ id: 'verify-task-1' }];
  insertedValues.length = 0;
  updateCalls.length = 0;
  mockDispatchNewTask.mockReset();
  mockDispatchNewTask.mockImplementation(() => Promise.resolve());
  mockCompleteMissionIfVerified.mockReset();
  mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({ completed: false, decision: { ok: false, code: 'criteria_unverified', reason: 'stub' } }) as any);
}

// ── resolveCommandCriterion ───────────────────────────────────────────────────

describe('resolveCommandCriterion — dispatch', () => {
  beforeEach(reset);

  it('dispatches a verification task and reports the criterion PENDING', async () => {
    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('pending');
    if (res.kind === 'pending') expect(res.taskId).toBe('verify-task-1');
    expect(mockDispatchNewTask).toHaveBeenCalled();

    const row = insertedValues[0];
    expect(row.missionId).toBe('m1');
    // Bookkeeping is load-bearing: a verification task counted as a deliverable
    // would keep pendingDeliverables above zero and block the completion it gates.
    expect(row.taskClass).toBe('bookkeeping');
    expect(row.loopConfig).toEqual({ exitCondition: { type: 'command', command: COMMAND }, maxLoops: 1 });
    expect(row.context.criteriaVerification).toEqual({ missionId: 'm1', criterionIndex: 0, command: COMMAND });
    expect(row.context.verificationCommand).toBe(COMMAND);
    expect(row.outputRequirement).toBe('none');
    expect(row.description).toContain(COMMAND);
    expect(row.description).toContain('do NOT open a PR');
  });

  it('reports unavailable — not a pass — when the mission has no workspace to run in', async () => {
    missionRow = { id: 'm1', title: 'Coordination mission', workspaceId: null, workingBranch: null };

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('unavailable');
    if (res.kind === 'unavailable') expect(res.evidence).toContain('no workspace');
    expect(insertedValues).toHaveLength(0);
  });

  it('reports unavailable when the mission does not exist', async () => {
    missionRow = null;
    const res = await resolveCommandCriterion({ missionId: 'gone', criterionIndex: 0, command: COMMAND });
    expect(res.kind).toBe('unavailable');
  });
});

describe('resolveCommandCriterion — reuse', () => {
  beforeEach(reset);

  it('reuses an in-flight verification task instead of dispatching another', async () => {
    taskFindManyRows = [{
      id: 'verify-existing',
      status: 'in_progress',
      context: marker(),
      result: null,
      updatedAt: new Date(),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('pending');
    if (res.kind === 'pending') expect(res.taskId).toBe('verify-existing');
    expect(insertedValues).toHaveLength(0);
  });

  it('returns a fresh pass from a completed run without re-running the command', async () => {
    taskFindManyRows = [{
      id: 'verify-done',
      status: 'completed',
      context: marker(),
      result: { loopHistory: [{ iteration: 0, satisfied: true, summary: 'Command exited 0' }] },
      updatedAt: new Date(Date.now() - 60_000),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('verdict');
    if (res.kind === 'verdict') {
      expect(res.verdict).toBe('pass');
      expect(res.evidence).toContain('exited 0');
    }
    expect(insertedValues).toHaveLength(0);
  });

  it('reads a failed verification task as a failed criterion', async () => {
    taskFindManyRows = [{
      id: 'verify-failed',
      status: 'failed',
      context: marker(),
      result: { loopHistory: [{ iteration: 0, satisfied: false, summary: 'Command failed (exit code 1, outcome: failed)' }] },
      updatedAt: new Date(Date.now() - 60_000),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('verdict');
    if (res.kind === 'verdict') {
      expect(res.verdict).toBe('fail');
      expect(res.evidence).toContain('exit code 1');
    }
  });

  it('re-runs the command once the last verdict ages past the TTL', async () => {
    taskFindManyRows = [{
      id: 'verify-stale',
      status: 'completed',
      context: marker(),
      result: { loopHistory: [{ iteration: 0, satisfied: true, summary: 'Command exited 0' }] },
      updatedAt: new Date(Date.now() - COMMAND_VERDICT_TTL_MS - 60_000),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    // A pass from an hour ago is not a statement about the code now.
    expect(res.kind).toBe('pending');
    expect(insertedValues).toHaveLength(1);
  });

  it('re-runs when the criterion command has changed since the last run', async () => {
    taskFindManyRows = [{
      id: 'verify-old-command',
      status: 'completed',
      context: marker('bun test old/path.test.ts'),
      result: { loopHistory: [{ iteration: 0, satisfied: true }] },
      updatedAt: new Date(),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('pending');
    expect(insertedValues).toHaveLength(1);
  });

  it('ignores verification tasks belonging to a different criterion index', async () => {
    taskFindManyRows = [{
      id: 'verify-other',
      status: 'in_progress',
      context: marker(COMMAND, 3),
      result: null,
      updatedAt: new Date(),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(insertedValues).toHaveLength(1);
    if (res.kind === 'pending') expect(res.taskId).toBe('verify-task-1');
  });
});

describe('resolveCommandCriterion — a task status is not a verdict', () => {
  beforeEach(reset);

  it('re-runs rather than passing a completed task that never ran the command', async () => {
    // The stale-worker reaper re-creates a task from its context but drops
    // `loopConfig`, so the clone completes with no verification step. Reading its
    // status as a pass would hand the criterion an agent's self-report — the exact
    // substitution this module exists to prevent.
    taskFindManyRows = [{
      id: 'verify-reaped-clone',
      status: 'completed',
      context: marker(),
      result: {},          // no loopHistory → the command never demonstrably ran
      updatedAt: new Date(Date.now() - 60_000),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('pending');
    expect(insertedValues).toHaveLength(1);
  });

  it('reports unavailable for a legacy criterion with no command instead of throwing', async () => {
    // Old validation only checked `type`, so this shape is writable history. It
    // used to throw a TypeError and 500 the operator's "Run verification" button.
    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: undefined as any });

    expect(res.kind).toBe('unavailable');
    if (res.kind === 'unavailable') expect(res.evidence).toContain('no command to run');
    expect(insertedValues).toHaveLength(0);
  });

  it('flags a verification task no runner has claimed instead of reading as normal', async () => {
    taskFindManyRows = [{
      id: 'verify-unclaimed',
      status: 'pending',
      context: marker(),
      result: null,
      updatedAt: new Date(Date.now() - 3 * COMMAND_VERDICT_TTL_MS),
    }];

    const res = await resolveCommandCriterion({ missionId: 'm1', criterionIndex: 0, command: COMMAND });

    expect(res.kind).toBe('pending');
    if (res.kind === 'pending') expect(res.evidence).toContain('no runner has claimed it');
  });
});

// ── handleCriteriaVerificationOutcome ─────────────────────────────────────────

const CURRENT_CRITERIA = [
  { type: 'command', command: COMMAND },
  { type: 'no_open_tasks' },
];

const STORED_STATE = {
  evaluatedAt: '2026-08-29T10:00:00.000Z',
  evaluatedBy: 'auto',
  overall: 'UNVERIFIED',
  criteria: [
    { index: 0, type: 'command', verdict: 'PENDING', evidence: 'Verification task verify-t dispatched', workerTaskId: 'verify-task-1' },
    { index: 1, type: 'no_open_tasks', verdict: 'pass', evidence: 'All deliverables closed' },
  ],
};

describe('handleCriteriaVerificationOutcome', () => {
  beforeEach(reset);

  it('turns runner evidence into a pass, re-folds the verdict, and re-attempts completion', async () => {
    taskFindFirstRow = { id: 'verify-task-1', status: 'completed', context: marker(), result: {}, missionId: 'm1' };
    missionRow = { id: 'm1', goalCriteria: structuredClone(CURRENT_CRITERIA), goalCriteriaState: structuredClone(STORED_STATE) };

    const res = await handleCriteriaVerificationOutcome('verify-task-1', {
      workerId: 'w1', iteration: 0, conditionType: 'command', command: COMMAND, exitCode: 0, outcome: 'ok',
    });

    expect(res).toEqual({ applied: true, verdict: 'pass' });
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[0].verdict).toBe('pass');
    expect(written.criteria[0].workerTaskId).toBe('verify-task-1');
    expect(written.criteria[0].evidence).toContain('exited 0');
    // Both criteria now pass, so the mission-level verdict passes.
    expect(written.overall).toBe('pass');
    // A criterion turning green is itself a completion trigger — no waiting for
    // the next heartbeat — and it reuses the verdict just written.
    expect(mockCompleteMissionIfVerified).toHaveBeenCalledWith('m1', {
      path: 'criteria_eval',
      predicate: 'verification task verify-task-1',
      evaluateCriteria: false,
    });
  });

  it('turns a non-ok outcome into a fail with the exit code in the evidence', async () => {
    taskFindFirstRow = { id: 'verify-task-1', status: 'failed', context: marker(), result: {}, missionId: 'm1' };
    missionRow = { id: 'm1', goalCriteria: structuredClone(CURRENT_CRITERIA), goalCriteriaState: structuredClone(STORED_STATE) };

    const res = await handleCriteriaVerificationOutcome('verify-task-1', {
      workerId: 'w1', iteration: 0, conditionType: 'command', command: COMMAND, exitCode: 1, outcome: 'failed',
    });

    expect(res.verdict).toBe('fail');
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[0].evidence).toContain('exit 1');
    expect(written.overall).toBe('fail');
  });

  it('falls back to the recorded loop history when the runner sent no evidence', async () => {
    // e.g. the loop exhausted server-side and the route wrote loopHistory.
    taskFindFirstRow = {
      id: 'verify-task-1',
      status: 'failed',
      context: marker(),
      result: { loopHistory: [{ summary: 'Command failed (exit code 2, outcome: failed)' }] },
      missionId: 'm1',
    };
    missionRow = { id: 'm1', goalCriteria: structuredClone(CURRENT_CRITERIA), goalCriteriaState: structuredClone(STORED_STATE) };

    const res = await handleCriteriaVerificationOutcome('verify-task-1');

    expect(res.verdict).toBe('fail');
    expect(updateCalls[0].goalCriteriaState.criteria[0].evidence).toContain('exit code 2');
  });

  it('refuses to write a verdict when the criterion changed while the task ran', async () => {
    // Index is not identity: if the array was edited, this exit code would land
    // on an unrelated criterion — as a pass, if the command succeeded.
    taskFindFirstRow = { id: 'verify-task-1', status: 'completed', context: marker(), result: {}, missionId: 'm1' };
    missionRow = {
      id: 'm1',
      goalCriteria: [{ type: 'command', command: 'bun test some/other/path.test.ts' }],
      goalCriteriaState: structuredClone(STORED_STATE),
    };

    const res = await handleCriteriaVerificationOutcome('verify-task-1', {
      workerId: 'w1', iteration: 0, conditionType: 'command', command: COMMAND, exitCode: 0, outcome: 'ok',
    });

    expect(res.applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it('leaves the criterion unresolved when a completed task carries no proof the command ran', async () => {
    taskFindFirstRow = { id: 'verify-task-1', status: 'completed', context: marker(), result: {}, missionId: 'm1' };
    missionRow = { id: 'm1', goalCriteria: structuredClone(CURRENT_CRITERIA), goalCriteriaState: structuredClone(STORED_STATE) };

    const res = await handleCriteriaVerificationOutcome('verify-task-1');

    expect(res.applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it('does nothing for a task that is not a criteria verification task', async () => {
    taskFindFirstRow = { id: 't-other', status: 'completed', context: { foo: 1 }, result: {}, missionId: 'm1' };

    const res = await handleCriteriaVerificationOutcome('t-other');

    expect(res.applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
    expect(mockCompleteMissionIfVerified).not.toHaveBeenCalled();
  });

  it('does nothing while the verification task is still running', async () => {
    taskFindFirstRow = { id: 'verify-task-1', status: 'in_progress', context: marker(), result: {}, missionId: 'm1' };

    const res = await handleCriteriaVerificationOutcome('verify-task-1');

    expect(res.applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it('does nothing when the mission has no stored criteria state to update', async () => {
    taskFindFirstRow = { id: 'verify-task-1', status: 'completed', context: marker(), result: {}, missionId: 'm1' };
    missionRow = { id: 'm1', goalCriteria: structuredClone(CURRENT_CRITERIA), goalCriteriaState: null };

    const res = await handleCriteriaVerificationOutcome('verify-task-1');

    expect(res.applied).toBe(false);
  });

  it('does nothing when the stored state has no criterion at that index', async () => {
    taskFindFirstRow = { id: 'verify-task-1', status: 'completed', context: marker(COMMAND, 9), result: {}, missionId: 'm1' };
    missionRow = { id: 'm1', goalCriteria: structuredClone(CURRENT_CRITERIA), goalCriteriaState: structuredClone(STORED_STATE) };

    const res = await handleCriteriaVerificationOutcome('verify-task-1');

    expect(res.applied).toBe(false);
  });
});

describe('isCriteriaVerificationTask', () => {
  it('recognises a verification task by its context marker', () => {
    expect(isCriteriaVerificationTask(marker())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isCriteriaVerificationTask(null)).toBe(false);
    expect(isCriteriaVerificationTask({})).toBe(false);
    expect(isCriteriaVerificationTask({ criteriaVerification: { missionId: 'm1' } })).toBe(false);
  });
});
