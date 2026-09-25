import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * `description` criteria under the `runner` grader: one read-only verification
 * task per criterion, claimed by a runner on the team's own agent credential
 * (an OAuth seat included), with the verdict returned as structured output.
 *
 * Mirrors `mission-criteria-verify.ts` (command criteria): one task per
 * (mission, criterion) round, reused while open, its terminal result reused as
 * the verdict until it ages out, and never read as a pass unless the runner
 * said `pass`.
 */

// ── Mock state ────────────────────────────────────────────────────────────────
let missionRow: any = null;
let workspaceRow: any = null;
let secretRow: any = null;
let taskFindFirstRow: any = null;
let taskFindManyRows: any[] = [];
let insertReturning: any[] = [{ id: 'prose-task-1' }];
const insertedValues: any[] = [];
const updateCalls: any[] = [];

const mockDispatchNewTask = mock(() => Promise.resolve());
const mockCompleteMissionIfVerified = mock((_id: string, _opts: any) =>
  Promise.resolve({ completed: false, decision: { ok: false, code: 'criteria_unverified', reason: 'stub' } }) as any);

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  or: (...args: any[]) => ({ _op: 'or', args }),
  desc: (col: any) => ({ _op: 'desc', col }),
  sql: (...args: any[]) => ({ _op: 'sql', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: { missionId: 'mission_id', taskClass: 'task_class', id: 'id', createdAt: 'created_at', context: 'context' },
  workspaces: Symbol('workspaces'),
  secrets: { teamId: 'team_id', purpose: 'purpose', workspaceId: 'workspace_id' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve(missionRow) },
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
      secrets: { findFirst: () => Promise.resolve(secretRow) },
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

const {
  resolveProseCriterion,
  handleProseEvalOutcome,
  isProseEvalTask,
  mapProseOutcome,
  PROSE_VERDICT_TTL_MS,
  RUNNER_WAIT_BOUND_MS,
} = await import('./mission-criteria-prose');
const { criterionFingerprint } = await import('@buildd/core/mission-helpers');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MISSION_ID = 'mission-1';

const CRITERIA = [
  { type: 'description', description: 'Contract exists', notMechanizableReason: 'stated reason', label: 'Contract' },
  { type: 'all_prs_merged' },
  { type: 'command', command: 'bun test' },
  { type: 'description', description: 'Regression guard', notMechanizableReason: 'stated reason', label: 'Guard' },
] as const;

const FP0 = criterionFingerprint(CRITERIA[0] as any);
const FP3 = criterionFingerprint(CRITERIA[3] as any);

const EVIDENCE = {
  deliverables: [
    { id: 'task-abcdef12', title: 'Ship the thing', status: 'completed', prUrl: 'https://github.com/o/r/pull/12', prNumber: 12, merged: true },
    { id: 'task-bbbbbbbb', title: 'Follow-up', status: 'in_progress', prUrl: null, prNumber: null, merged: false },
  ],
  artifacts: [{ id: 'art-abcdef12', title: 'Summary', type: 'summary', key: 'summary' }],
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    missionId: MISSION_ID,
    criterionIndex: 0,
    text: 'Contract exists',
    fingerprint: FP0,
    evidence: EVIDENCE,
    ...overrides,
  } as any;
}

function goodMission(overrides: Record<string, unknown> = {}) {
  return {
    id: MISSION_ID,
    title: 'Test Mission',
    description: 'Do the thing',
    teamId: 'team-1',
    workspaceId: 'ws-1',
    goalCriteria: CRITERIA,
    goalCriteriaState: null,
    ...overrides,
  };
}

function marker(criterionIndex = 0, fingerprint = FP0) {
  return { criteriaProseEval: { missionId: MISSION_ID, criterionIndex, fingerprint } };
}

beforeEach(() => {
  missionRow = goodMission();
  workspaceRow = { id: 'ws-1', name: 'ws' };
  secretRow = { id: 'secret-1' };
  taskFindFirstRow = null;
  taskFindManyRows = [];
  insertReturning = [{ id: 'prose-task-1' }];
  insertedValues.length = 0;
  updateCalls.length = 0;
  mockDispatchNewTask.mockClear();
  mockCompleteMissionIfVerified.mockClear();
});

// ── Dispatch ──────────────────────────────────────────────────────────────────

describe('resolveProseCriterion — dispatch', () => {
  it('dispatches one read-only analysis task for the criterion and returns pending', async () => {
    const res = await resolveProseCriterion(input());

    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') return;
    expect(res.taskId).toBe('prose-task-1');
    expect(res.evidence).toContain('Verifying on runner');
    expect(res.awaitingRunner).toBe(false);
    expect(insertedValues).toHaveLength(1);

    const v = insertedValues[0];
    expect(v.kind).toBe('analysis');
    expect(['simple', 'normal']).toContain(v.complexity);
    // Bookkeeping, or the verification task would keep pendingDeliverables > 0
    // and block the very completion its verdict gates.
    expect(v.taskClass).toBe('bookkeeping');
    expect(v.missionId).toBe(MISSION_ID);
    expect(v.workspaceId).toBe('ws-1');
    expect(v.status).toBe('pending');
    // Same contract as a command verification task: a judgment, not a PR.
    expect(v.outputRequirement).toBe('none');
    // One task per criterion — the marker names exactly one.
    expect(v.context.criteriaProseEval).toEqual({ missionId: MISSION_ID, criterionIndex: 0, fingerprint: FP0 });
    expect(v.context.retryCount).toBe(1);
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  it('asks for { verdict, reason, evidence? } as structured output', async () => {
    await resolveProseCriterion(input());
    const schema = insertedValues[0].outputSchema;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['verdict', 'reason']);
    expect(schema.properties.verdict.enum).toEqual(['pass', 'fail', 'unsure']);
    expect(schema.properties.reason.type).toBe('string');
    expect(schema.properties.reason.maxLength).toBe(400);
    expect(schema.properties.evidence.type).toBe('array');
    expect(schema.properties.evidence.items.type).toBe('string');
  });

  it('carries the criterion, the mission, the deliverables and pointers — ids and titles only', async () => {
    await resolveProseCriterion(input());
    const d = insertedValues[0].description as string;
    expect(d).toContain('Contract exists');
    expect(d).toContain('Test Mission');
    expect(d).toContain('Do the thing');
    // Deliverables with status, PR link and merged state.
    expect(d).toContain('Ship the thing');
    expect(d).toContain('completed');
    expect(d).toContain('https://github.com/o/r/pull/12');
    expect(d).toMatch(/merged/i);
    expect(d).toContain('Follow-up');
    expect(d).toContain('in_progress');
    expect(d).toContain('task-abcdef12');
    // Artifacts by id and title.
    expect(d).toContain('art-abcdef12');
    expect(d).toContain('Summary');
    // Read, never modify.
    expect(d).toMatch(/do NOT (change|modify)/i);
    expect(d).toMatch(/read-only/i);
  });

  it('does not embed artifact content — pointers only', async () => {
    await resolveProseCriterion(input({
      evidence: { deliverables: [], artifacts: [{ id: 'art-1', title: 'T', type: 'doc', key: null, content: 'SECRET BODY' }] },
    }));
    expect(insertedValues[0].description).not.toContain('SECRET BODY');
  });
});

// ── Unavailable ───────────────────────────────────────────────────────────────

describe('resolveProseCriterion — unavailable', () => {
  it('is unavailable when the mission has no workspace', async () => {
    missionRow = goodMission({ workspaceId: null });
    const res = await resolveProseCriterion(input());
    expect(res.kind).toBe('unavailable');
    if (res.kind !== 'unavailable') return;
    expect(res.evidence).toContain('no workspace');
    expect(insertedValues).toHaveLength(0);
  });

  it('is unavailable — naming the fix — when no agent backend credential is connected', async () => {
    secretRow = null;
    const res = await resolveProseCriterion(input());
    expect(res.kind).toBe('unavailable');
    if (res.kind !== 'unavailable') return;
    expect(res.evidence).toContain('Agent Backends');
    expect(insertedValues).toHaveLength(0);
  });

  it('is unavailable when the mission is gone', async () => {
    missionRow = null;
    const res = await resolveProseCriterion(input());
    expect(res.kind).toBe('unavailable');
    expect(insertedValues).toHaveLength(0);
  });
});

// ── Dedupe and reuse ──────────────────────────────────────────────────────────

describe('resolveProseCriterion — dedupe', () => {
  it('reuses an open verification task instead of dispatching a second', async () => {
    taskFindManyRows = [{
      id: 'prose-task-open', status: 'in_progress', context: marker(), result: null,
      createdAt: new Date(), updatedAt: new Date(),
    }];

    const res = await resolveProseCriterion(input());

    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') return;
    expect(res.taskId).toBe('prose-task-open');
    expect(res.evidence).toContain('Verifying on runner');
    expect(insertedValues).toHaveLength(0);
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('flags a task unclaimed past the wait bound as waiting for a runner', async () => {
    const old = new Date(Date.now() - RUNNER_WAIT_BOUND_MS - 60_000);
    taskFindManyRows = [{
      id: 'prose-task-queued', status: 'pending', context: marker(), result: null,
      createdAt: old, updatedAt: old,
    }];

    const res = await resolveProseCriterion(input());
    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') return;
    expect(res.awaitingRunner).toBe(true);
    expect(res.evidence).toContain('Waiting for a runner to verify');
    expect(insertedValues).toHaveLength(0);
  });

  it('does not flag a claimed task as waiting for a runner, however long it runs', async () => {
    const old = new Date(Date.now() - 10 * RUNNER_WAIT_BOUND_MS);
    taskFindManyRows = [{
      id: 'prose-task-slow', status: 'in_progress', context: marker(), result: null,
      createdAt: old, updatedAt: old,
    }];
    const res = await resolveProseCriterion(input());
    expect(res.kind === 'pending' && res.awaitingRunner).toBe(false);
  });

  it('reuses a fresh terminal verdict as the answer instead of re-grading', async () => {
    taskFindManyRows = [{
      id: 'prose-task-done', status: 'completed', context: marker(),
      result: { structuredOutput: { verdict: 'pass', reason: 'Contract doc merged in PR 12' } },
      createdAt: new Date(Date.now() - 120_000), updatedAt: new Date(Date.now() - 60_000),
    }];

    const res = await resolveProseCriterion(input());
    expect(res.kind).toBe('verdict');
    if (res.kind !== 'verdict') return;
    expect(res.verdict).toBe('pass');
    expect(res.evidence).toContain('Contract doc merged');
    expect(res.taskId).toBe('prose-task-done');
    expect(insertedValues).toHaveLength(0);
  });

  it('does not re-dispatch straight after a fresh run that produced no verdict (loop guard)', async () => {
    taskFindManyRows = [{
      id: 'prose-task-empty', status: 'completed', context: marker(), result: {},
      createdAt: new Date(Date.now() - 120_000), updatedAt: new Date(Date.now() - 60_000),
    }];

    const res = await resolveProseCriterion(input());
    expect(res.kind).toBe('verdict');
    if (res.kind !== 'verdict') return;
    expect(res.verdict).toBe('NOT_EVALUATED');
    expect(insertedValues).toHaveLength(0);
  });

  it('re-dispatches once the last run has aged past the TTL (next evaluation round)', async () => {
    const old = new Date(Date.now() - 2 * PROSE_VERDICT_TTL_MS);
    taskFindManyRows = [{
      id: 'prose-task-old', status: 'completed', context: marker(),
      result: { structuredOutput: { verdict: 'pass', reason: 'ok' } },
      createdAt: old, updatedAt: old,
    }];

    const res = await resolveProseCriterion(input());
    expect(res.kind).toBe('pending');
    expect(insertedValues).toHaveLength(1);
  });

  it('re-dispatches when the criterion text changed under the last run', async () => {
    taskFindManyRows = [{
      id: 'prose-task-other', status: 'in_progress', context: marker(0, 'description:OLD'), result: null,
      createdAt: new Date(), updatedAt: new Date(),
    }];

    const res = await resolveProseCriterion(input());
    // A different fingerprint is a different question; the open task's answer
    // would be discarded on write-back anyway.
    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') return;
    expect(res.taskId).toBe('prose-task-1');
    expect(insertedValues).toHaveLength(1);
  });

  it('ignores a task for a different criterion index', async () => {
    taskFindManyRows = [{
      id: 'prose-task-3', status: 'in_progress', context: marker(3, FP3), result: null,
      createdAt: new Date(), updatedAt: new Date(),
    }];
    const res = await resolveProseCriterion(input());
    expect(res.kind === 'pending' && res.taskId).toBe('prose-task-1');
    expect(insertedValues).toHaveLength(1);
  });
});

// ── Verdict mapping ───────────────────────────────────────────────────────────

describe('mapProseOutcome', () => {
  it('pass → pass, with the reason as evidence', () => {
    const m = mapProseOutcome('completed', { verdict: 'pass', reason: 'Shipped and merged', evidence: ['PR 12'] }, 'task-12345678');
    expect(m.verdict).toBe('pass');
    expect(m.evidence).toContain('Shipped and merged');
    expect(m.evidence).toContain('PR 12');
  });

  it('fail → fail', () => {
    const m = mapProseOutcome('completed', { verdict: 'fail', reason: 'No contract doc exists' }, 'task-12345678');
    expect(m.verdict).toBe('fail');
    expect(m.evidence).toContain('No contract doc exists');
  });

  it('unsure → NOT_EVALUATED, showing the reason', () => {
    const m = mapProseOutcome('completed', { verdict: 'unsure', reason: 'Cannot see the deploy logs' }, 'task-12345678');
    expect(m.verdict).toBe('NOT_EVALUATED');
    expect(m.evidence).toContain('Cannot see the deploy logs');
    expect(m.evidence).toMatch(/unsure/i);
  });

  it('a failed task → NOT_EVALUATED with an infra reason, even if it carried output', () => {
    for (const status of ['failed', 'cancelled']) {
      const m = mapProseOutcome(status, { verdict: 'pass', reason: 'x' }, 'task-12345678');
      expect(m.verdict).toBe('NOT_EVALUATED');
      expect(m.evidence).toMatch(/task-123/);
      expect(m.evidence).toMatch(/infra|runner/i);
    }
  });

  it('missing or malformed structured output → NOT_EVALUATED, never a silent pass or fail', () => {
    for (const out of [undefined, null, {}, { verdict: 'yes' }, { verdict: 'pass' }, { reason: 'r' }, 'pass']) {
      const m = mapProseOutcome('completed', out, 'task-12345678');
      expect(m.verdict).toBe('NOT_EVALUATED');
      expect(m.evidence).toMatch(/no (usable )?structured verdict/i);
    }
  });

  it('truncates an over-long reason to 400 chars', () => {
    const m = mapProseOutcome('completed', { verdict: 'fail', reason: 'x'.repeat(1000) }, 'task-12345678');
    expect(m.evidence.length).toBeLessThanOrEqual(460);
  });
});

// ── Write-back ────────────────────────────────────────────────────────────────

function stateWithPending() {
  return {
    evaluatedAt: new Date(Date.now() - 60_000).toISOString(),
    evaluatedBy: 'auto',
    overall: 'UNVERIFIED',
    criteria: [
      { index: 0, type: 'description', verdict: 'PENDING', evidence: 'Verifying on runner…', fingerprint: FP0, label: 'Contract', workerTaskId: 'prose-task-1', awaitingRunner: true },
      { index: 1, type: 'all_prs_merged', verdict: 'pass', evidence: 'all merged' },
      { index: 2, type: 'command', verdict: 'pass', evidence: 'exited 0' },
      { index: 3, type: 'description', verdict: 'pass', evidence: 'graded earlier', fingerprint: FP3, label: 'Guard' },
    ],
  };
}

describe('handleProseEvalOutcome', () => {
  beforeEach(() => {
    taskFindFirstRow = {
      id: 'prose-task-1', status: 'completed', missionId: MISSION_ID, context: marker(), result: {},
    };
    missionRow = goodMission({ goalCriteriaState: stateWithPending() });
  });

  it('writes a pass onto its criterion, stamps evaluatedAt + the task link, and re-folds overall', async () => {
    const res = await handleProseEvalOutcome('prose-task-1', { verdict: 'pass', reason: 'Contract shipped' });

    expect(res.applied).toBe(true);
    expect(updateCalls).toHaveLength(1);
    const written = updateCalls[0].goalCriteriaState;
    const c0 = written.criteria[0];
    expect(c0.verdict).toBe('pass');
    expect(c0.evidence).toContain('Contract shipped');
    expect(c0.workerTaskId).toBe('prose-task-1');
    expect(typeof c0.evaluatedAt).toBe('string');
    expect(Date.parse(c0.evaluatedAt)).toBeGreaterThan(Date.now() - 5_000);
    expect(c0.awaitingRunner).toBeUndefined();
    expect(written.overall).toBe('pass');
  });

  it('fail folds to overall fail', async () => {
    await handleProseEvalOutcome('prose-task-1', { verdict: 'fail', reason: 'No contract' });
    expect(updateCalls[0].goalCriteriaState.overall).toBe('fail');
  });

  it('unsure lands NOT_EVALUATED with the reason, and does not pass the mission', async () => {
    await handleProseEvalOutcome('prose-task-1', { verdict: 'unsure', reason: 'Logs not visible' });
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(written.criteria[0].evidence).toContain('Logs not visible');
    expect(written.overall).toBe('UNVERIFIED');
  });

  it('a failed task lands NOT_EVALUATED with an infra reason — never PENDING forever', async () => {
    taskFindFirstRow.status = 'failed';
    const res = await handleProseEvalOutcome('prose-task-1', undefined);
    expect(res.applied).toBe(true);
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(written.criteria[0].evidence).toMatch(/infra|runner/i);
    expect(written.overall).toBe('UNVERIFIED');
  });

  it('a completed task with no structured output lands NOT_EVALUATED', async () => {
    await handleProseEvalOutcome('prose-task-1', undefined);
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(written.overall).toBe('UNVERIFIED');
  });

  it('falls back to the structuredOutput persisted on the task result', async () => {
    taskFindFirstRow.result = { structuredOutput: { verdict: 'pass', reason: 'from result' } };
    await handleProseEvalOutcome('prose-task-1', undefined);
    expect(updateCalls[0].goalCriteriaState.criteria[0].evidence).toContain('from result');
  });

  it('touches only its own criterion', async () => {
    await handleProseEvalOutcome('prose-task-1', { verdict: 'fail', reason: 'nope' });
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[1].verdict).toBe('pass');
    expect(written.criteria[3].verdict).toBe('pass');
    expect(written.criteria[3].evidence).toBe('graded earlier');
  });

  it('re-attempts completion with the verdict it just wrote', async () => {
    await handleProseEvalOutcome('prose-task-1', { verdict: 'pass', reason: 'yes' });
    expect(mockCompleteMissionIfVerified).toHaveBeenCalledTimes(1);
    const [id, opts] = mockCompleteMissionIfVerified.mock.calls[0] as any[];
    expect(id).toBe(MISSION_ID);
    expect(opts.evaluateCriteria).toBe(false);
  });

  it('discards the verdict when the criterion was edited while the task ran', async () => {
    missionRow = goodMission({
      goalCriteria: [{ ...CRITERIA[0], description: 'A different claim now' }, ...CRITERIA.slice(1)],
      goalCriteriaState: stateWithPending(),
    });
    await handleProseEvalOutcome('prose-task-1', { verdict: 'pass', reason: 'yes' });
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[0].verdict).not.toBe('pass');
    expect(written.overall).not.toBe('pass');
  });

  it('ignores a task with no prose-eval marker, or one not terminal yet', async () => {
    taskFindFirstRow.context = { somethingElse: true };
    expect((await handleProseEvalOutcome('prose-task-1', { verdict: 'pass', reason: 'x' })).applied).toBe(false);
    taskFindFirstRow.context = marker();
    taskFindFirstRow.status = 'in_progress';
    expect((await handleProseEvalOutcome('prose-task-1', { verdict: 'pass', reason: 'x' })).applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });
});

describe('isProseEvalTask', () => {
  it('recognises the per-criterion marker', () => {
    expect(isProseEvalTask(marker())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isProseEvalTask(null)).toBe(false);
    expect(isProseEvalTask({})).toBe(false);
    expect(isProseEvalTask({ criteriaVerification: { missionId: 'm', criterionIndex: 0 } })).toBe(false);
    expect(isProseEvalTask({ criteriaProseEval: { missionId: 'm' } })).toBe(false);
  });
});
