import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockMissionNotesFindFirst = mock(() => null as any);

// Track DB mutation calls for assertions
const mockWorkersUpdate = mock();
const mockMissionNotesUpdate = mock();
const mockMissionNotesInsert = mock();

function makeChainedUpdate(updateMock: ReturnType<typeof mock>) {
  return () => {
    const setFn = mock(() => ({
      where: mock(() => Promise.resolve()),
    }));
    updateMock(setFn);
    return { set: setFn };
  };
}

const dbWorkersUpdateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const dbMissionNotesUpdateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const dbMissionNotesInsertValues = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      workers: {
        findFirst: mockWorkersFindFirst,
        findMany: mockWorkersFindMany,
      },
      tasks: {
        findFirst: mockTasksFindFirst,
        findMany: mockTasksFindMany,
      },
      missionNotes: { findFirst: mockMissionNotesFindFirst },
    },
    update: (table: any) => {
      if (table === 'workers_table') {
        return { set: dbWorkersUpdateSet };
      }
      if (table === 'mission_notes_table') {
        return { set: dbMissionNotesUpdateSet };
      }
      // Default — return a chainable mock
      return {
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      };
    },
    insert: (table: any) => ({
      values: dbMissionNotesInsertValues,
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  or: (...args: any[]) => ({ args, op: 'or' }),
  ne: (a: any, b: any) => ({ a, b, op: 'ne' }),
  not: (a: any) => ({ a, op: 'not' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: 'workspaces_table',
  workers: 'workers_table',
  tasks: 'tasks_table',
  missionNotes: 'mission_notes_table',
  githubInstallations: 'github_installations_table',
}));

// Track GitHub API calls
const mockGithubApi = mock((_installationId: number, path: string, _opts?: any) => {
  // Default: success
  return Promise.resolve({ id: 1 });
});

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

mock.module('@buildd/core/subject-anchor-observe', () => ({
  resolveSubjectPolicy: (policy: any) => ({
    mode: 'observe',
    dedupe: 'attach-system',
    proposalGraceHours: 24,
    conflictDeadDays: 7,
    autoCloseBuilddSupersededPrs: policy?.autoCloseBuilddSupersededPrs ?? false,
    priorWorkInjection: true,
    ...policy,
  }),
}));

mock.module('./subject-sweep', () => ({
  sweepSubjectAnchoredTasks: mock(() => Promise.resolve({ anchored: 0, reconciled: 0 })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { shutdownDeadBuilddPrs } from './dead-pr-shutdown';

// ── Test helpers ──────────────────────────────────────────────────────────────

const WS_ID = 'ws-1';
const WINNER_PR = 11;
const LOSER_PR = 10;
const INSTALLATION_ID = 99;
const REPO = 'acme/myrepo';
const SUBJECT_PR = 5;

function makeWorkspace(overrides: Record<string, any> = {}) {
  return {
    gitConfig: {
      subjectPolicy: {
        autoCloseBuilddSupersededPrs: true,
        conflictDeadDays: 7,
        ...overrides.subjectPolicy,
      },
      ...overrides.gitConfig,
    },
    ...overrides,
  };
}

function makeEventWorker() {
  return { id: 'w-winner', taskId: 't-winner' };
}

function makeEventTask() {
  return { subjectPrNumber: SUBJECT_PR };
}

function makeLoserTask() {
  return { id: 't-loser', missionId: 'mission-1' };
}

function makeLoserWorker(overrides: Partial<{
  prLifecycleStatus: string | null;
  conflictDetectedAt: Date | null;
}> = {}) {
  return {
    id: 'w-loser',
    taskId: 't-loser',
    prNumber: LOSER_PR,
    branch: 'buildd/loser-branch',
    prLifecycleStatus: 'pr_open',
    conflictDetectedAt: null,
    workspaceId: WS_ID,
    ...overrides,
  };
}

// Reset all mocks between tests
function resetMocks() {
  mockWorkspacesFindFirst.mockImplementation(() => null);
  mockWorkersFindFirst.mockImplementation(() => null);
  mockWorkersFindMany.mockImplementation(() => []);
  mockTasksFindFirst.mockImplementation(() => null);
  mockTasksFindMany.mockImplementation(() => []);
  mockMissionNotesFindFirst.mockImplementation(() => null);
  mockGithubApi.mockReset();
  mockGithubApi.mockImplementation(() => Promise.resolve({ id: 1 }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('shutdownDeadBuilddPrs', () => {

  beforeEach(() => {
    resetMocks();
  });

  afterAll(() => {
    mock.restore();
  });

  // ── Feature flag OFF ────────────────────────────────────────────────────────

  it('returns empty result when autoCloseBuilddSupersededPrs is false (feature flag OFF)', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => ({
      gitConfig: { subjectPolicy: { autoCloseBuilddSupersededPrs: false } },
    }));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toHaveLength(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  // ── Human-owned PR safety ───────────────────────────────────────────────────

  it('never auto-closes a PR when no buildd worker record exists (human-authored)', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());

    // No event worker → no closure
    mockWorkersFindFirst.mockImplementation(() => null);
    mockTasksFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  // ── Tier 1: closed/superseded → immediate closure ───────────────────────────

  it('Tier 1: closes a buildd-authored loser PR when the winner merges', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [makeLoserWorker()]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toContain(LOSER_PR);
    expect(result.closedPrNumbers).toHaveLength(1);

    // Comment posted
    const commentCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/issues/${LOSER_PR}/comments`),
    );
    expect(commentCall).toBeDefined();

    // PR closed via PATCH
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeDefined();
  });

  // ── Tier 2: conflict-dead + green successor ─────────────────────────────────

  it('Tier 2: closes a conflict-dead loser PR after conflictDeadDays when winner merges', async () => {
    // conflictDetectedAt = 8 days ago (> 7 day threshold)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace({ subjectPolicy: { conflictDeadDays: 7, autoCloseBuilddSupersededPrs: true } }));
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: eightDaysAgo }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toContain(LOSER_PR);

    // PR close called
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeDefined();
  });

  it('Tier 2: does NOT close a conflict-dead loser PR before conflictDeadDays', async () => {
    // conflictDetectedAt = 3 days ago (< 7 day threshold)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace({ subjectPolicy: { conflictDeadDays: 7, autoCloseBuilddSupersededPrs: true } }));
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: threeDaysAgo }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    // Conflict-dead but not old enough AND winner merged → Tier 2 does not apply; Tier 3 applies (escalate)
    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toContain(LOSER_PR);
  });

  // ── Tier 3: conflict-dead, no successor ────────────────────────────────────

  it('Tier 3: creates escalation note for conflict-dead PR with no green successor', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: new Date() }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    // Winner PR was CLOSED without merge (no successor)
    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, false, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toContain(LOSER_PR);

    // No GitHub API close call for the loser
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeUndefined();
  });

  // ── GitHub closure failure ──────────────────────────────────────────────────

  it('does not stamp worker closed when GitHub close call fails', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [makeLoserWorker()]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    // Make GitHub close throw
    mockGithubApi.mockImplementation((_installationId: number, path: string) => {
      if (path.includes(`/pulls/${LOSER_PR}`)) {
        throw new Error('GitHub API 422 Unprocessable Entity');
      }
      return Promise.resolve({ id: 1 });
    });

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    // PR NOT in closed list (failure → skipped)
    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.skippedPrNumbers).toContain(LOSER_PR);
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it('is idempotent: re-running when loser is already closed returns empty result', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);

    // Loser worker already has prLifecycleStatus=closed — filtered out by query
    mockWorkersFindMany.mockImplementation(() => [
      // The real DB query filters out closed/merged, so findMany returns empty
    ]);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

});
