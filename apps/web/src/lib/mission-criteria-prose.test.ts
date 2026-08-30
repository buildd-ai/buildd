import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * `description` criteria: graded by a dispatched agent, not by an inline API call.
 *
 * The inline path needs `ANTHROPIC_API_KEY` in the web app's environment — a
 * thing that is absent in production and cannot be supplied by a team that pays
 * for Claude with an OAuth subscription. Every prose criterion therefore read
 * NOT_EVALUATED forever. This module routes prose grading through the same
 * machinery `command` criteria already use: dispatch a bookkeeping task, let a
 * runner claim it with whatever backend credential the team has connected, and
 * write the returned verdicts back onto the criteria.
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
  resolveProseCriteria,
  handleProseEvalOutcome,
  isProseEvalTask,
  PROSE_VERDICT_TTL_MS,
} = await import('./mission-criteria-prose');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MISSION_ID = 'mission-1';

const PROSE_INPUTS = [
  { index: 0, text: 'Contract exists', fingerprint: 'description:aaa' },
  { index: 3, text: 'Regression guard', fingerprint: 'description:bbb' },
];

const EVIDENCE = {
  tasks: [{ id: 'task-abcdef12', title: 'Ship the thing', summary: 'Shipped it' }],
  artifacts: [{ id: 'art-abcdef12', title: 'Summary', type: 'summary', contentSnippet: 'all good' }],
};

function goodMission(overrides: Record<string, unknown> = {}) {
  return {
    id: MISSION_ID,
    title: 'Test Mission',
    description: 'Do the thing',
    teamId: 'team-1',
    workspaceId: 'ws-1',
    workingBranch: null,
    goalCriteria: [
      { type: 'description', description: 'Contract exists', label: 'Contract' },
      { type: 'all_prs_merged' },
      { type: 'command', command: 'bun test' },
      { type: 'description', description: 'Regression guard', label: 'Guard' },
    ],
    goalCriteriaState: null,
    ...overrides,
  };
}

function marker(indices = [0, 3], fingerprints = ['description:aaa', 'description:bbb']) {
  return { criteriaProseEval: { missionId: MISSION_ID, criterionIndices: indices, fingerprints } };
}

beforeEach(() => {
  missionRow = goodMission();
  workspaceRow = { id: 'ws-1', name: 'ws', githubRepo: 'org/repo' };
  secretRow = { id: 'secret-1' };
  taskFindFirstRow = null;
  taskFindManyRows = [];
  insertReturning = [{ id: 'prose-task-1' }];
  insertedValues.length = 0;
  updateCalls.length = 0;
  mockDispatchNewTask.mockClear();
  mockCompleteMissionIfVerified.mockClear();
});

// ── resolveProseCriteria: dispatch ────────────────────────────────────────────

describe('resolveProseCriteria — dispatch', () => {
  it('dispatches a bookkeeping task and returns pending', async () => {
    const res = await resolveProseCriteria({
      missionId: MISSION_ID,
      criteria: PROSE_INPUTS,
      evidence: EVIDENCE,
    });

    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') return;
    expect(res.taskId).toBe('prose-task-1');
    expect(insertedValues).toHaveLength(1);

    const v = insertedValues[0];
    // Bookkeeping, or the evaluator task would keep pendingDeliverables > 0 and
    // block the very completion its verdict gates.
    expect(v.taskClass).toBe('bookkeeping');
    expect(v.missionId).toBe(MISSION_ID);
    expect(v.workspaceId).toBe('ws-1');
    expect(v.status).toBe('pending');
    expect(v.tier).toBe('budget');
    expect(v.outputRequirement).toBe('none');
    // The marker is what lets the completion hook find its way back.
    expect(v.context.criteriaProseEval.missionId).toBe(MISSION_ID);
    expect(v.context.criteriaProseEval.criterionIndices).toEqual([0, 3]);
    expect(v.context.criteriaProseEval.fingerprints).toEqual(['description:aaa', 'description:bbb']);
    // No silent second attempt: one honest grading run per dispatch.
    expect(v.context.retryCount).toBe(1);
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  it('requests structured output so the verdicts come back machine-readable', async () => {
    await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    const schema = insertedValues[0].outputSchema;
    expect(schema.required).toContain('criteriaVerdicts');
    expect(schema.properties.criteriaVerdicts.type).toBe('array');
    const item = schema.properties.criteriaVerdicts.items;
    expect(item.required).toEqual(expect.arrayContaining(['index', 'verdict', 'evidence']));
    expect(item.properties.verdict.enum).toEqual(['pass', 'fail', 'UNVERIFIED']);
  });

  it('embeds the criteria and the evidence in the prompt', async () => {
    await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    const d = insertedValues[0].description as string;
    expect(d).toContain('Contract exists');
    expect(d).toContain('Regression guard');
    expect(d).toContain('index=0');
    expect(d).toContain('index=3');
    expect(d).toContain('Ship the thing');
    expect(d).toContain('Shipped it');
    expect(d).toContain('all good');
    // Grading only — an evaluator that starts fixing things is no longer a judge.
    expect(d).toMatch(/do NOT/i);
  });
});

// ── resolveProseCriteria: unavailable ─────────────────────────────────────────

describe('resolveProseCriteria — unavailable', () => {
  it('is unavailable when the mission has no workspace', async () => {
    missionRow = goodMission({ workspaceId: null });
    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    expect(res.kind).toBe('unavailable');
    if (res.kind !== 'unavailable') return;
    expect(res.evidence).toContain('no workspace');
    expect(insertedValues).toHaveLength(0);
  });

  it('is unavailable — naming the fix — when no agent backend credential is connected', async () => {
    secretRow = null;
    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    expect(res.kind).toBe('unavailable');
    if (res.kind !== 'unavailable') return;
    // The old message named an env var no operator could set. This one names the
    // screen where the problem is actually fixable.
    expect(res.evidence).toContain('Agent Backends');
    expect(res.evidence).not.toContain('ANTHROPIC_API_KEY');
    expect(insertedValues).toHaveLength(0);
  });

  it('is unavailable when the mission is gone', async () => {
    missionRow = null;
    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    expect(res.kind).toBe('unavailable');
    expect(insertedValues).toHaveLength(0);
  });
});

// ── resolveProseCriteria: dedupe ──────────────────────────────────────────────

describe('resolveProseCriteria — dedupe', () => {
  it('reuses an in-flight evaluator task instead of dispatching a second', async () => {
    taskFindManyRows = [{
      id: 'prose-task-existing',
      status: 'in_progress',
      context: marker(),
      result: null,
      updatedAt: new Date(),
    }];

    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });

    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') return;
    expect(res.taskId).toBe('prose-task-existing');
    // Mechanical re-evaluation runs on every completion; without this the mission
    // would dispatch a fresh evaluator on each round.
    expect(insertedValues).toHaveLength(0);
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('says so when an in-flight evaluator task has gone unclaimed', async () => {
    taskFindManyRows = [{
      id: 'prose-task-stalled',
      status: 'pending',
      context: marker(),
      result: null,
      updatedAt: new Date(Date.now() - 5 * PROSE_VERDICT_TTL_MS),
    }];

    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') return;
    // A task nothing ever claims otherwise reads as normal "in flight" forever.
    expect(res.evidence).toContain('no runner has claimed it');
    expect(insertedValues).toHaveLength(0);
  });

  it('does not re-dispatch after a fresh evaluator returned no verdicts', async () => {
    taskFindManyRows = [{
      id: 'prose-task-empty',
      status: 'completed',
      context: marker(),
      result: {},
      updatedAt: new Date(Date.now() - 60_000),
    }];

    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    // Re-dispatching immediately would spend a real agent run every evaluation
    // round on a grading attempt that just demonstrably produced nothing.
    expect(res.kind).toBe('unavailable');
    if (res.kind !== 'unavailable') return;
    expect(res.evidence).toContain('without returning verdicts');
    expect(insertedValues).toHaveLength(0);
  });

  it('re-dispatches once the last evaluator run has aged past the TTL', async () => {
    taskFindManyRows = [{
      id: 'prose-task-old',
      status: 'completed',
      context: marker(),
      result: {},
      updatedAt: new Date(Date.now() - 2 * PROSE_VERDICT_TTL_MS),
    }];

    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    expect(res.kind).toBe('pending');
    expect(insertedValues).toHaveLength(1);
  });

  it('re-dispatches when the criteria changed under a finished run', async () => {
    taskFindManyRows = [{
      id: 'prose-task-other',
      status: 'completed',
      context: marker([0, 3], ['description:OLD', 'description:bbb']),
      result: {},
      updatedAt: new Date(Date.now() - 60_000),
    }];

    const res = await resolveProseCriteria({ missionId: MISSION_ID, criteria: PROSE_INPUTS, evidence: EVIDENCE });
    // Different criteria means the finished run answered a different question.
    expect(res.kind).toBe('pending');
    expect(insertedValues).toHaveLength(1);
  });
});

// ── handleProseEvalOutcome ────────────────────────────────────────────────────

function stateWithPending() {
  return {
    evaluatedAt: new Date().toISOString(),
    evaluatedBy: 'auto',
    overall: 'UNVERIFIED',
    criteria: [
      { index: 0, type: 'description', verdict: 'PENDING', evidence: 'dispatched', fingerprint: 'description:aaa', label: 'Contract' },
      { index: 1, type: 'all_prs_merged', verdict: 'pass', evidence: 'all merged' },
      { index: 2, type: 'command', verdict: 'pass', evidence: 'exited 0' },
      { index: 3, type: 'description', verdict: 'PENDING', evidence: 'dispatched', fingerprint: 'description:bbb', label: 'Guard' },
    ],
  };
}

describe('handleProseEvalOutcome', () => {
  beforeEach(() => {
    taskFindFirstRow = {
      id: 'prose-task-1',
      status: 'completed',
      missionId: MISSION_ID,
      context: marker(),
      result: {},
    };
    missionRow = goodMission({ goalCriteriaState: stateWithPending() });
  });

  it('writes the returned verdicts onto the criteria and re-folds overall', async () => {
    const res = await handleProseEvalOutcome('prose-task-1', {
      criteriaVerdicts: [
        { index: 0, verdict: 'pass', evidence: 'Contract shipped in [task:task-abc]' },
        { index: 3, verdict: 'pass', evidence: 'Guard test added' },
      ],
    });

    expect(res.applied).toBe(true);
    expect(updateCalls).toHaveLength(1);
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[0].verdict).toBe('pass');
    expect(written.criteria[0].evidence).toContain('Contract shipped');
    expect(written.criteria[3].verdict).toBe('pass');
    // Every criterion passing is the only route to an overall pass.
    expect(written.overall).toBe('pass');
    expect(written.criteria[0].workerTaskId).toBe('prose-task-1');
  });

  it('folds a fail to overall fail', async () => {
    await handleProseEvalOutcome('prose-task-1', {
      criteriaVerdicts: [
        { index: 0, verdict: 'fail', evidence: 'No contract found' },
        { index: 3, verdict: 'pass', evidence: 'Guard test added' },
      ],
    });
    expect(updateCalls[0].goalCriteriaState.overall).toBe('fail');
  });

  it('re-attempts mission completion with the verdict it just wrote', async () => {
    await handleProseEvalOutcome('prose-task-1', {
      criteriaVerdicts: [
        { index: 0, verdict: 'pass', evidence: 'yes' },
        { index: 3, verdict: 'pass', evidence: 'yes' },
      ],
    });
    expect(mockCompleteMissionIfVerified).toHaveBeenCalledTimes(1);
    const [id, opts] = mockCompleteMissionIfVerified.mock.calls[0] as any[];
    expect(id).toBe(MISSION_ID);
    // Don't re-evaluate: that would re-dispatch the evaluator we just heard from.
    expect(opts.evaluateCriteria).toBe(false);
  });

  it('leaves a criterion the evaluator skipped as NOT_EVALUATED, never PENDING', async () => {
    await handleProseEvalOutcome('prose-task-1', {
      criteriaVerdicts: [{ index: 0, verdict: 'pass', evidence: 'yes' }],
    });
    const written = updateCalls[0].goalCriteriaState;
    expect(written.criteria[3].verdict).toBe('NOT_EVALUATED');
    // A criterion stuck at PENDING with no task in flight holds the mission open
    // with nothing left to resolve it.
    expect(written.criteria[3].evidence).toContain('did not return a verdict');
    expect(written.overall).toBe('UNVERIFIED');
  });

  it('discards a verdict whose criterion changed while the evaluator ran', async () => {
    taskFindFirstRow.context = marker([0, 3], ['description:STALE', 'description:bbb']);

    await handleProseEvalOutcome('prose-task-1', {
      criteriaVerdicts: [
        { index: 0, verdict: 'pass', evidence: 'yes' },
        { index: 3, verdict: 'pass', evidence: 'yes' },
      ],
    });

    const written = updateCalls[0].goalCriteriaState;
    // Criterion 0 was edited under the running evaluator; writing this pass onto
    // it would be a verdict transplant onto a claim nobody graded.
    expect(written.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(written.criteria[3].verdict).toBe('pass');
    expect(written.overall).toBe('UNVERIFIED');
  });

  it('ignores a task with no prose-eval marker', async () => {
    taskFindFirstRow.context = { somethingElse: true };
    const res = await handleProseEvalOutcome('prose-task-1', { criteriaVerdicts: [{ index: 0, verdict: 'pass', evidence: 'x' }] });
    expect(res.applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it('ignores a task that is not terminal yet', async () => {
    taskFindFirstRow.status = 'in_progress';
    const res = await handleProseEvalOutcome('prose-task-1', { criteriaVerdicts: [{ index: 0, verdict: 'pass', evidence: 'x' }] });
    expect(res.applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it('falls back to the structuredOutput stored on the task result', async () => {
    taskFindFirstRow.result = {
      structuredOutput: {
        criteriaVerdicts: [
          { index: 0, verdict: 'pass', evidence: 'from result' },
          { index: 3, verdict: 'pass', evidence: 'from result' },
        ],
      },
    };
    const res = await handleProseEvalOutcome('prose-task-1', undefined);
    expect(res.applied).toBe(true);
    expect(updateCalls[0].goalCriteriaState.criteria[0].evidence).toContain('from result');
  });

  it('marks the criteria NOT_EVALUATED when a failed evaluator returned nothing', async () => {
    taskFindFirstRow.status = 'failed';
    const res = await handleProseEvalOutcome('prose-task-1', undefined);
    expect(res.applied).toBe(true);
    const written = updateCalls[0].goalCriteriaState;
    // Nothing was proven — but leaving PENDING would hold the mission open forever.
    expect(written.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(written.criteria[3].verdict).toBe('NOT_EVALUATED');
    expect(written.overall).toBe('UNVERIFIED');
  });

  it('coerces an unrecognised verdict string to UNVERIFIED', async () => {
    await handleProseEvalOutcome('prose-task-1', {
      criteriaVerdicts: [
        { index: 0, verdict: 'definitely-yes', evidence: 'x' },
        { index: 3, verdict: 'pass', evidence: 'y' },
      ],
    });
    expect(updateCalls[0].goalCriteriaState.criteria[0].verdict).toBe('UNVERIFIED');
  });

  it('ignores a verdict for an index the evaluator was never asked about', async () => {
    await handleProseEvalOutcome('prose-task-1', {
      criteriaVerdicts: [
        { index: 0, verdict: 'pass', evidence: 'x' },
        { index: 1, verdict: 'fail', evidence: 'not yours to grade' },
        { index: 3, verdict: 'pass', evidence: 'y' },
      ],
    });
    const written = updateCalls[0].goalCriteriaState;
    // Criterion 1 is mechanical and was not in the marker — an agent must not be
    // able to overwrite a mechanically-derived pass with prose.
    expect(written.criteria[1].verdict).toBe('pass');
    expect(written.overall).toBe('pass');
  });
});

describe('isProseEvalTask', () => {
  it('recognises the marker', () => {
    expect(isProseEvalTask(marker())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isProseEvalTask(null)).toBe(false);
    expect(isProseEvalTask({})).toBe(false);
    expect(isProseEvalTask({ criteriaVerification: { missionId: 'm', criterionIndex: 0 } })).toBe(false);
    expect(isProseEvalTask({ criteriaProseEval: { missionId: 'm' } })).toBe(false);
  });
});
