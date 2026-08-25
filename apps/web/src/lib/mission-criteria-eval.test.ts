import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── DB mocks ──────────────────────────────────────────────────────────────────

// Used by countPendingTasksForMission (imported from ./mission-release) via db.select chain.
// We mock at the DB level rather than mocking @/lib/mission-release with mock.module(),
// because mock.module() is global in bun and would poison mission-release.test.ts.
const mockPendingSelectWhere = mock(() => Promise.resolve([{ count: 0 }]));
const mockMissionFindFirst = mock((): any => null);
const mockTaskFindMany = mock((): any[] => []);
const mockWorkerFindMany = mock((): any[] => []);
const mockArtifactFindMany = mock((): any[] => []);
let updatedMissionData: any = null;
let insertedNoteValues: any = null;
const mockMissionsUpdate = mock(() => ({
  set: mock((data: any) => {
    updatedMissionData = data;
    return { where: mock(() => Promise.resolve()) };
  }),
}));
const mockNotesInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedNoteValues = vals;
    return Promise.resolve();
  }),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionFindFirst },
      tasks: { findMany: mockTaskFindMany },
      workers: { findMany: mockWorkerFindMany },
      artifacts: { findMany: mockArtifactFindMany },
    },
    select: () => ({ from: () => ({ where: mockPendingSelectWhere }) }),
    update: () => mockMissionsUpdate(),
    insert: () => mockNotesInsert(),
  },
}));

const mockEvaluateGoalCriteria = mock((_mission: any, _criteria: any, context: any) => ({
  evaluatedAt: '2026-08-12T00:00:00.000Z',
  evaluatedBy: context.evaluatedBy,
  overall: 'pass',
  criteria: [
    { index: 0, type: 'no_open_tasks', verdict: 'pass', evidence: 'All 3 tasks are done.' },
  ],
}));

mock.module('@buildd/core/mission-helpers', () => ({
  evaluateGoalCriteria: mockEvaluateGoalCriteria,
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: 'missions',
  tasks: 'tasks',
  workers: 'workers',
  artifacts: 'artifacts',
  missionNotes: 'missionNotes',
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  inArray: (a: any, b: any) => ({ a, b }),
  count: () => ({ type: 'count' }),
}));

import { autoEvaluateMissionOnCompletion } from './mission-criteria-eval';

describe('autoEvaluateMissionOnCompletion', () => {
  beforeEach(() => {
    mockPendingSelectWhere.mockReset();
    mockMissionFindFirst.mockReset();
    mockTaskFindMany.mockReset();
    mockWorkerFindMany.mockReset();
    mockArtifactFindMany.mockReset();
    mockMissionsUpdate.mockReset();
    mockNotesInsert.mockReset();
    mockEvaluateGoalCriteria.mockReset();
    updatedMissionData = null;
    insertedNoteValues = null;

    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockTaskFindMany.mockResolvedValue([]);
    mockWorkerFindMany.mockResolvedValue([]);
    mockArtifactFindMany.mockResolvedValue([]);
    mockEvaluateGoalCriteria.mockImplementation((_mission: any, _criteria: any, context: any) => ({
      evaluatedAt: '2026-08-12T00:00:00.000Z',
      evaluatedBy: context.evaluatedBy,
      overall: 'pass',
      criteria: [
        { index: 0, type: 'no_open_tasks', verdict: 'pass', evidence: 'All 3 tasks are done.' },
      ],
    }));
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedMissionData = data;
        return { where: mock(() => Promise.resolve()) };
      }),
    }));
    mockNotesInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedNoteValues = vals;
        return Promise.resolve();
      }),
    }));
  });

  it('skips evaluation when pending tasks remain', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 3 }]);

    await autoEvaluateMissionOnCompletion('mission-1');

    expect(mockMissionFindFirst).not.toHaveBeenCalled();
    expect(updatedMissionData).toBeNull();
  });

  it('skips evaluation when mission has no goalCriteria', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-1',
      title: 'Test',
      description: null,
      goalCriteria: null,
      goalCriteriaState: null,
      autoVerify: null,
      workingBranch: null,
      status: 'completed',
    });

    await autoEvaluateMissionOnCompletion('mission-1');

    expect(updatedMissionData).toBeNull();
  });

  it('skips evaluation when autoVerify=false', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-1',
      title: 'Test',
      description: null,
      goalCriteria: [{ type: 'no_open_tasks' }],
      goalCriteriaState: null,
      autoVerify: false,
      workingBranch: null,
      status: 'active',
    });

    await autoEvaluateMissionOnCompletion('mission-1');

    expect(updatedMissionData).toBeNull();
  });

  it('skips evaluation when goalCriteriaState already exists', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-1',
      title: 'Test',
      description: null,
      goalCriteria: [{ type: 'no_open_tasks' }],
      goalCriteriaState: { evaluatedAt: '2026-08-11T00:00:00.000Z', overall: 'pass', criteria: [] },
      autoVerify: null,
      workingBranch: null,
      status: 'completed',
    });

    await autoEvaluateMissionOnCompletion('mission-1');

    expect(updatedMissionData).toBeNull();
  });

  it('evaluates and persists state when all conditions met', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-1',
      title: 'Test Mission',
      description: 'Some description',
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
      goalCriteriaState: null,
      autoVerify: null,
      workingBranch: null,
      status: 'active',
    });

    await autoEvaluateMissionOnCompletion('mission-1');

    expect(updatedMissionData).not.toBeNull();
    expect(updatedMissionData.goalCriteriaState).toBeDefined();
    expect(updatedMissionData.goalCriteriaState.overall).toBe('pass');
    expect(updatedMissionData.goalCriteriaState.evaluatedBy).toBe('auto');
  });

  it('posts a mission note after evaluation', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-1',
      title: 'Test Mission',
      description: null,
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
      goalCriteriaState: null,
      autoVerify: null,
      workingBranch: null,
      status: 'active',
    });

    await autoEvaluateMissionOnCompletion('mission-1');

    expect(insertedNoteValues).not.toBeNull();
    expect(insertedNoteValues.title).toBe('Goal criteria evaluated (on-completion)');
    expect(insertedNoteValues.missionId).toBe('mission-1');
  });

  it('also evaluates when autoVerify is true', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-1',
      title: 'Test Mission',
      description: null,
      goalCriteria: [{ type: 'all_prs_merged' }],
      goalCriteriaState: null,
      autoVerify: true,
      workingBranch: null,
      status: 'active',
    });

    await autoEvaluateMissionOnCompletion('mission-1');

    expect(updatedMissionData).not.toBeNull();
  });

  // ── DEFECT 2: NOT_EVALUATED criteria must not vacuously pass ───────────────

  it('does NOT auto-complete when all description criteria are NOT_EVALUATED (no LLM key)', async () => {
    // Fixture: 3 description criteria NOT_EVALUATED + 1 all_prs_merged fail — mirrors 6dc41ced
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-6dc41ced',
      title: 'Test Mission',
      description: null,
      goalCriteria: [
        { type: 'description', description: 'All PRs merged', label: 'CI green' },
        { type: 'description', description: 'No open issues', label: 'No issues' },
        { type: 'description', description: 'Docs updated', label: 'Docs' },
        { type: 'all_prs_merged', label: 'PRs merged' },
      ],
      goalCriteriaState: null,
      autoVerify: null,
      workingBranch: null,
      status: 'active',
    });

    // evaluateGoalCriteria returns 3 NOT_EVALUATED + 1 fail (as mission-helpers would)
    mockEvaluateGoalCriteria.mockImplementation((_mission: any, _criteria: any, context: any) => ({
      evaluatedAt: '2026-08-24T00:00:00.000Z',
      evaluatedBy: context.evaluatedBy,
      overall: 'fail',
      criteria: [
        { index: 0, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
        { index: 1, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
        { index: 2, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
        { index: 3, type: 'all_prs_merged', verdict: 'fail', evidence: '4 PR(s) not yet merged', label: 'PRs merged' },
      ],
    }));

    await autoEvaluateMissionOnCompletion('mission-6dc41ced');

    // State should be persisted but status must NOT be set to completed
    expect(updatedMissionData).not.toBeNull();
    expect(updatedMissionData.status).toBeUndefined();
    expect(updatedMissionData.goalCriteriaState.overall).toBe('fail');
  });

  it('does NOT auto-complete when description criteria are NOT_EVALUATED even if mechanical pass', async () => {
    // 3 description criteria NOT_EVALUATED + 1 mechanical criterion passes
    // This tests that NOT_EVALUATED blocks 'pass' — the core of DEFECT 2
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-defect2',
      title: 'Test Mission',
      description: null,
      goalCriteria: [
        { type: 'description', description: 'Quality bar met', label: 'Quality' },
        { type: 'description', description: 'Coverage targets hit', label: 'Coverage' },
        { type: 'description', description: 'Perf benchmarks pass', label: 'Perf' },
        { type: 'no_open_tasks', label: 'No open tasks' },
      ],
      goalCriteriaState: null,
      autoVerify: null,
      workingBranch: null,
      status: 'active',
    });

    // evaluateGoalCriteria returns 3 NOT_EVALUATED + 1 mechanical pass
    // Without the fix this used to yield overall='pass' (NOT_EVALUATED were excluded from calc)
    mockEvaluateGoalCriteria.mockImplementation((_mission: any, _criteria: any, context: any) => ({
      evaluatedAt: '2026-08-24T00:00:00.000Z',
      evaluatedBy: context.evaluatedBy,
      overall: 'UNVERIFIED',
      criteria: [
        { index: 0, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
        { index: 1, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
        { index: 2, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
        { index: 3, type: 'no_open_tasks', verdict: 'pass', evidence: 'All tasks complete' },
      ],
    }));

    await autoEvaluateMissionOnCompletion('mission-defect2');

    expect(updatedMissionData).not.toBeNull();
    // Must NOT complete: NOT_EVALUATED criteria should block the 'pass' verdict
    expect(updatedMissionData.status).toBeUndefined();
    // recalculateOverall should return 'UNVERIFIED' — NOT_EVALUATED is present
    expect(updatedMissionData.goalCriteriaState.overall).toBe('UNVERIFIED');
  });

  it('auto-completes when all criteria pass (including after LLM upgrade)', async () => {
    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue({
      id: 'mission-pass',
      title: 'Test Mission',
      description: null,
      goalCriteria: [{ type: 'no_open_tasks', label: 'All done' }],
      goalCriteriaState: null,
      autoVerify: null,
      workingBranch: null,
      status: 'active',
    });

    // evaluateGoalCriteria returns all pass (no LLM-eligible criteria)
    mockEvaluateGoalCriteria.mockImplementation((_mission: any, _criteria: any, context: any) => ({
      evaluatedAt: '2026-08-24T00:00:00.000Z',
      evaluatedBy: context.evaluatedBy,
      overall: 'pass',
      criteria: [
        { index: 0, type: 'no_open_tasks', verdict: 'pass', evidence: 'All tasks done.' },
      ],
    }));

    await autoEvaluateMissionOnCompletion('mission-pass');

    expect(updatedMissionData).not.toBeNull();
    expect(updatedMissionData.status).toBe('completed');
    expect(updatedMissionData.goalCriteriaState.overall).toBe('pass');
  });
});
