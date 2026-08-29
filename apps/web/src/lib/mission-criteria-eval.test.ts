import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

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

// ── Model tier registry mock ──────────────────────────────────────────────────

const mockResolveTierEntry = mock((): any => Promise.resolve({
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  source: 'default',
}));

mock.module('@buildd/core/model-tier-registry', () => ({
  resolveTierEntry: mockResolveTierEntry,
}));

// ── Fetch mock (replaces globalThis.fetch for provider dispatch tests) ─────────

const mockFetch = mock(async (_url: string, _opts: any): Promise<any> => {
  throw new Error('fetch called but not configured in this test');
});
globalThis.fetch = mockFetch as any;

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
    mockResolveTierEntry.mockReset();
    mockFetch.mockReset();
    updatedMissionData = null;
    insertedNoteValues = null;

    mockResolveTierEntry.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      source: 'default',
    });

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

// ── Provider dispatch tests ────────────────────────────────────────────────────

const DESCRIPTION_MISSION = {
  id: 'mission-llm',
  title: 'LLM Mission',
  description: null,
  goalCriteria: [{ type: 'description', description: 'All tasks shipped', label: 'Shipped' }],
  goalCriteriaState: null,
  autoVerify: null,
  workingBranch: null,
  status: 'active',
  teamId: 'team-abc',
  workspaceId: 'ws-xyz',
};

const DESCRIPTION_UNEVAL_STATE = {
  evaluatedAt: '2026-08-29T00:00:00.000Z',
  evaluatedBy: 'auto' as const,
  overall: 'UNVERIFIED',
  criteria: [
    { index: 0, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
  ],
};

function makeSuccessfulLLMResponse(verdict: string) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ verdicts: [{ index: 0, verdict, evidence: 'Confirmed.' }] }) }],
    }),
  };
}

function makeSuccessfulOpenRouterResponse(verdict: string) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ verdicts: [{ index: 0, verdict, evidence: 'Confirmed.' }] }) } }],
    }),
  };
}

describe('autoEvaluateMissionOnCompletion — provider dispatch', () => {
  let savedAnthropicKey: string | undefined;
  let savedOpenRouterKey: string | undefined;

  beforeEach(() => {
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    mockPendingSelectWhere.mockReset();
    mockMissionFindFirst.mockReset();
    mockTaskFindMany.mockReset();
    mockWorkerFindMany.mockReset();
    mockArtifactFindMany.mockReset();
    mockMissionsUpdate.mockReset();
    mockNotesInsert.mockReset();
    mockEvaluateGoalCriteria.mockReset();
    mockResolveTierEntry.mockReset();
    mockFetch.mockReset();
    updatedMissionData = null;
    insertedNoteValues = null;

    mockPendingSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockMissionFindFirst.mockResolvedValue(DESCRIPTION_MISSION);
    mockTaskFindMany.mockResolvedValue([]);
    mockWorkerFindMany.mockResolvedValue([]);
    mockArtifactFindMany.mockResolvedValue([]);
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
    mockResolveTierEntry.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      source: 'default',
    });
    mockEvaluateGoalCriteria.mockImplementation((_mission: any, _criteria: any, context: any) => ({
      evaluatedAt: '2026-08-29T00:00:00.000Z',
      evaluatedBy: context.evaluatedBy,
      overall: 'UNVERIFIED',
      // Fresh objects each call — avoids mutation bleed between tests
      criteria: [
        { index: 0, type: 'description', verdict: 'NOT_EVALUATED', evidence: '' },
      ],
    }));
  });

  afterEach(() => {
    if (savedAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (savedOpenRouterKey !== undefined) {
      process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('calls resolveTierEntry with mission teamId and workspaceId (registry override honored)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockFetch.mockImplementation(async () => makeSuccessfulLLMResponse('pass'));

    await autoEvaluateMissionOnCompletion('mission-llm');

    expect(mockResolveTierEntry).toHaveBeenCalledWith('budget', 'team-abc', 'ws-xyz');
  });

  it('openrouter: hits openrouter endpoint with Bearer header', async () => {
    mockResolveTierEntry.mockResolvedValue({
      provider: 'openrouter',
      model: 'qwen/qwen-2.5-72b-instruct',
      source: 'team',
    });
    process.env.OPENROUTER_API_KEY = 'or-test-key';

    let capturedUrl: string | null = null;
    let capturedHeaders: Record<string, string> | null = null;
    mockFetch.mockImplementation(async (url: string, opts: any) => {
      capturedUrl = url;
      capturedHeaders = opts?.headers ?? {};
      return makeSuccessfulOpenRouterResponse('pass');
    });

    await autoEvaluateMissionOnCompletion('mission-llm');

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capturedHeaders?.['Authorization']).toBe('Bearer or-test-key');
    expect(updatedMissionData?.goalCriteriaState?.criteria?.[0]?.verdict).toBe('pass');
  });

  it('openai-codex: returns explicit unsupported reason without calling fetch', async () => {
    mockResolveTierEntry.mockResolvedValue({
      provider: 'openai-codex',
      model: 'codex-mini',
      source: 'team',
    });

    await autoEvaluateMissionOnCompletion('mission-llm');

    expect(mockFetch).not.toHaveBeenCalled();
    const criterionState = updatedMissionData?.goalCriteriaState?.criteria?.[0];
    expect(criterionState?.verdict).toBe('NOT_EVALUATED');
    expect(criterionState?.evidence).toBe('provider not supported for inline evaluation');
  });

  it('missing anthropic key: evidence names ANTHROPIC_API_KEY', async () => {
    // ANTHROPIC_API_KEY is deleted in beforeEach

    await autoEvaluateMissionOnCompletion('mission-llm');

    expect(mockFetch).not.toHaveBeenCalled();
    const criterionState = updatedMissionData?.goalCriteriaState?.criteria?.[0];
    expect(criterionState?.verdict).toBe('NOT_EVALUATED');
    expect(criterionState?.evidence).toBe('ANTHROPIC_API_KEY not configured');
  });

  it('missing openrouter key: evidence names OPENROUTER_API_KEY', async () => {
    mockResolveTierEntry.mockResolvedValue({
      provider: 'openrouter',
      model: 'qwen/qwen-2.5-72b-instruct',
      source: 'team',
    });
    // OPENROUTER_API_KEY is deleted in beforeEach

    await autoEvaluateMissionOnCompletion('mission-llm');

    expect(mockFetch).not.toHaveBeenCalled();
    const criterionState = updatedMissionData?.goalCriteriaState?.criteria?.[0];
    expect(criterionState?.verdict).toBe('NOT_EVALUATED');
    expect(criterionState?.evidence).toBe('OPENROUTER_API_KEY not configured');
  });

  it('fetch network failure: evidence is distinguishable from ambiguous evidence', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });

    await autoEvaluateMissionOnCompletion('mission-llm');

    const criterionState = updatedMissionData?.goalCriteriaState?.criteria?.[0];
    expect(criterionState?.verdict).toBe('NOT_EVALUATED');
    expect(criterionState?.evidence).toBe('LLM call failed: network error');
    // Must NOT look like ambiguous evidence
    expect(criterionState?.evidence).not.toBe('No relevant evidence found');
  });
});
