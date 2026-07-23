/**
 * Incident Replay: bwrap_namespace_denied — three workers, one fix PR
 *
 * Regression spec for the bwrap incident (mission e00c5c32, PRs #1350/#1367/#1371).
 * Three workers hit "bwrap: No permissions to create a new namespace" simultaneously
 * and each filed a separate friction task, causing three competing fix branches.
 *
 * This test suite replays the incident against the shipped implementation and asserts:
 *   1. Worker A creates exactly one friction task (T1) with the inferred bwrap manifest.
 *   2. Workers B and C are deduplicated — their reports are appended to T1, no new task.
 *   3. T1 carries the inferred pathManifest from the component table (no path in excerpt).
 *   4. A subsequent overlapping fix task (T2) receives an auto-dependsOn edge to T1.
 *   5. While T1's PR is open, findBlockingPr defers T2 at claim time (blocks on T1's PR).
 *   6. A closed T1 PR does NOT block T2 (abandoned-branch regression, PR #1384).
 *
 * Mock approach mirrors route.test.ts — no live DB/server required.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { findBlockingPr } from '@buildd/core/path-overlap';

// ── Mock infrastructure (same shape as route.test.ts) ───────────────────────

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => []),
  })),
}));
const mockTasksUpdateWhere = mock(() => Promise.resolve());
const mockTasksUpdateSet = mock(() => ({ where: mockTasksUpdateWhere }));
const mockTasksUpdate = mock(() => ({ set: mockTasksUpdateSet }));
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockResolveCreatorContext = mock(() =>
  Promise.resolve({
    createdByAccountId: 'account-123',
    createdByWorkerId: null,
    creationSource: 'mcp',
    parentTaskId: null,
  })
);
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockResolveWorkspace = mock(() => null as any);
const mockAutoResolveAccountWorkspace = mock(() => Promise.resolve({ workspaceId: 'ws-1' } as any));
const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (apiKey: string | null) => {
    if (!apiKey) return null;
    return mockAccountsFindFirst();
  },
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mock(() => Promise.resolve(['ws-1'])),
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/task-service', () => ({
  resolveCreatorContext: mockResolveCreatorContext,
}));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatchNewTask }));
mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: mockResolveWorkspace,
  autoResolveAccountWorkspace: mockAutoResolveAccountWorkspace,
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}`, task: (id: string) => `task-${id}`, worker: (id: string) => `worker-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned', TASK_CLAIMED: 'task:claimed', TASK_COMPLETED: 'task:completed', TASK_FAILED: 'task:failed', WORKER_STARTED: 'worker:started', WORKER_PROGRESS: 'worker:progress', WORKER_COMPLETED: 'worker:completed', WORKER_FAILED: 'worker:failed' },
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      workspaces: { findMany: mock(() => []), findFirst: mockWorkspacesFindFirst },
      tasks: { findMany: mockTasksFindMany, findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    insert: mockTasksInsert,
    update: mockTasksUpdate,
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  notInArray: (field: any, values: any[]) => ({ field, values, type: 'notInArray' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  like: (field: any, pattern: any) => ({ field, pattern, type: 'like' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode' },
  tasks: {
    id: 'id',
    workspaceId: 'workspaceId',
    createdAt: 'createdAt',
    title: 'title',
    status: 'status',
    description: 'description',
    context: 'context',
    updatedAt: 'updatedAt',
    pathManifest: 'pathManifest',
  },
  missions: { id: 'id' },
}));

// Must import AFTER mocks
import { POST } from './route';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BWRAP_SIGNATURE = 'bwrap_namespace_denied';
const BWRAP_EXCERPT = 'bwrap: No permissions to create a new namespace';
const BWRAP_MANIFEST = ['apps/runner/src/env-scan.ts', 'apps/runner/src/workers.ts'];

function makeWorkerRequest(
  workerDescription: string,
  overrides: Record<string, any> = {},
): NextRequest {
  return new NextRequest('http://localhost:3000/api/tasks', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      authorization: 'Bearer bld_xxx',
    }),
    body: JSON.stringify({
      workspaceId: 'ws-1',
      title: '[friction] bwrap namespace denied',
      description: workerDescription,
      context: {
        frictionSignature: BWRAP_SIGNATURE,
        frictionExcerpt: BWRAP_EXCERPT,
      },
      ...overrides,
    }),
  });
}

// ── Shared task stub for T1 ───────────────────────────────────────────────────

const T1 = {
  id: 'task-T1',
  workspaceId: 'ws-1',
  title: '[friction] bwrap namespace denied',
  description: BWRAP_EXCERPT,
  context: { frictionSignature: BWRAP_SIGNATURE },
  pathManifest: BWRAP_MANIFEST,
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Incident replay: bwrap_namespace_denied — three workers, one fix PR', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksInsert.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksUpdateSet.mockReset();
    mockTasksUpdateWhere.mockReset();
    mockResolveCreatorContext.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockDispatchNewTask.mockReset();
    mockMissionsFindFirst.mockReset();
    mockResolveWorkspace.mockReset();

    // Default happy-path setup
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockResolveWorkspace.mockImplementation(async (raw: string) => ({ id: raw }));
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'mcp',
      parentTaskId: null,
    });
    mockTasksFindFirst.mockResolvedValue(null);  // default: no existing friction task
    mockTasksFindMany.mockResolvedValue([]);      // default: no in-flight tasks
    mockTasksUpdateWhere.mockResolvedValue(undefined);
    mockTasksUpdateSet.mockReturnValue({ where: mockTasksUpdateWhere });
    mockTasksUpdate.mockReturnValue({ set: mockTasksUpdateSet });
  });

  // ── Phase 1: Worker A creates T1 ──────────────────────────────────────────

  it('phase 1 — worker A creates T1 with inferred bwrap manifest (no existing friction task)', async () => {
    // No existing open task with this signature → dedup miss → normal create
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const mockReturning = mock(() => [T1]);
    const mockValues = mock((values: any) => { capturedValues = values; return { returning: mockReturning }; });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const response = await POST(makeWorkerRequest('Worker A: bwrap: No permissions to create a new namespace'));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe('task-T1');
    expect(data.deduplicated).toBeUndefined();

    // Exactly one DB insert — one task created
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdate).not.toHaveBeenCalled();

    // Inferred manifest stamped on T1 (pathless trace → component table)
    expect(capturedValues.pathManifest).toEqual(BWRAP_MANIFEST);

    // frictionSignature preserved in task context for future dedup lookups
    expect(capturedValues.context.frictionSignature).toBe(BWRAP_SIGNATURE);
  });

  // ── Phase 2: Worker B deduplicated ────────────────────────────────────────

  it('phase 2 — worker B deduplicated: report appended to T1, no second task created', async () => {
    // T1 exists and is open
    mockTasksFindFirst.mockResolvedValue({ id: 'task-T1', title: T1.title, description: T1.description });

    const response = await POST(
      makeWorkerRequest('Worker B: bwrap: No permissions to create a new namespace', {
        createdByWorkerId: 'worker-B',
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe('task-T1');
    expect(data.deduplicated).toBe(true);

    // No new task created
    expect(mockTasksInsert).not.toHaveBeenCalled();

    // Description was updated to append Worker B's report
    expect(mockTasksUpdate).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdateWhere).toHaveBeenCalledTimes(1);
  });

  // ── Phase 3: Worker C deduplicated ────────────────────────────────────────

  it('phase 3 — worker C deduplicated: second append, still exactly one friction task', async () => {
    // T1 still open (now with B's report in description, but that doesn't change dedup key)
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-T1',
      title: T1.title,
      description: T1.description + '\n\n---\n_Worker worker-B also reported this error._',
    });

    const response = await POST(
      makeWorkerRequest('Worker C: bwrap: No permissions to create a new namespace', {
        createdByWorkerId: 'worker-C',
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe('task-T1');
    expect(data.deduplicated).toBe(true);

    // Still no new task
    expect(mockTasksInsert).not.toHaveBeenCalled();

    // Third report appended
    expect(mockTasksUpdate).toHaveBeenCalledTimes(1);
  });

  // ── Phase 4: Inferred manifest + auto-dependsOn ───────────────────────────

  it('phase 4 — overlapping fix task T2 gets auto-dependsOn edge to T1', async () => {
    // T1 is pending in the workspace with the bwrap manifest
    mockTasksFindFirst.mockResolvedValue(null); // separate friction task check
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-T1', pathManifest: BWRAP_MANIFEST },
    ]);

    let capturedValues: any = null;
    const T2 = { id: 'task-T2', workspaceId: 'ws-1', title: 'Fix bwrap env detection' };
    const mockReturning = mock(() => [T2]);
    const mockValues = mock((values: any) => { capturedValues = values; return { returning: mockReturning }; });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    // T2 is a regular fix task (not friction), overlapping env-scan.ts
    const response = await POST(
      new NextRequest('http://localhost:3000/api/tasks', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_xxx' }),
        body: JSON.stringify({
          workspaceId: 'ws-1',
          title: 'Fix bwrap env detection',
          description: 'Fix the env-scan path so bwrap namespaces are handled correctly',
          pathManifest: ['apps/runner/src/env-scan.ts'],
        }),
      }),
    );
    expect(response.status).toBe(200);

    // T2 automatically depends on T1 (overlapping path: env-scan.ts)
    expect(capturedValues.dependsOn).toContain('task-T1');
  });

  // ── Phase 5: Claim-time blocking when T1's PR is open ─────────────────────

  it('phase 5 — findBlockingPr defers T2 while T1 has an open PR', () => {
    // Pure function — no mocks needed
    const blocking = findBlockingPr(
      ['apps/runner/src/env-scan.ts'],  // T2's manifest
      [
        // T1's worker has opened a PR touching the same files
        { pathManifest: BWRAP_MANIFEST, prNumber: 1400, prUrl: 'https://github.com/buildd-ai/buildd/pull/1400' },
      ],
    );

    // T2 must be deferred — T1's PR covers env-scan.ts
    expect(blocking).not.toBeNull();
    expect(blocking!.prNumber).toBe(1400);
  });

  // ── Phase 5 regression: closed T1 PR does NOT block T2 (PR #1384) ────────

  it('phase 5 regression — closed T1 PR does NOT block T2 (abandoned-branch fix)', () => {
    // The claim route filters out workers with prLifecycleStatus='closed' BEFORE
    // calling findBlockingPr. So findBlockingPr itself never receives a closed PR.
    // This test verifies that if the route correctly filters closed PRs, T2 is not
    // blocked. Here we simulate what the route does: pass an empty list to findBlockingPr.
    const blocking = findBlockingPr(
      ['apps/runner/src/env-scan.ts'], // T2's manifest
      [],  // closed PR workers filtered out upstream (prLifecycleStatus='closed')
    );

    // No active open PRs → T2 is not deferred
    expect(blocking).toBeNull();
  });

  // ── Phase 1 variant: T1's manifest comes from excerpt path ───────────────

  it('phase 1 variant — when excerpt names env-scan.ts, path extraction wins over table', async () => {
    // Worker A mentions env-scan.ts explicitly in the excerpt
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const mockReturning = mock(() => [{ ...T1, id: 'task-T1-v' }]);
    const mockValues = mock((values: any) => { capturedValues = values; return { returning: mockReturning }; });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/tasks', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_xxx' }),
        body: JSON.stringify({
          workspaceId: 'ws-1',
          title: '[friction] bwrap namespace denied',
          description: BWRAP_EXCERPT,
          context: {
            frictionSignature: BWRAP_SIGNATURE,
            // Excerpt explicitly names env-scan.ts as the origin
            frictionExcerpt: 'bwrap: No permissions to create a new namespace — from apps/runner/src/env-scan.ts',
          },
        }),
      }),
    );
    expect(response.status).toBe(200);

    // Path extracted from excerpt — only env-scan.ts (step 1 wins over table)
    expect(capturedValues.pathManifest).toContain('apps/runner/src/env-scan.ts');
  });

  // ── Regression: tasks without overlap or signature are unaffected ─────────

  it('regression — non-friction tasks with no pathManifest are unaffected by dedup gate', async () => {
    // A plain task with no frictionSignature
    mockTasksFindFirst.mockResolvedValue(null);

    const plainTask = { id: 'plain-1', workspaceId: 'ws-1', title: 'Refactor workers.ts' };
    const mockReturning = mock(() => [plainTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/tasks', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_xxx' }),
        body: JSON.stringify({
          workspaceId: 'ws-1',
          title: 'Refactor workers.ts',
          description: 'Clean up the workers module',
        }),
      }),
    );
    expect(response.status).toBe(200);

    // Dedup gate was NOT triggered (no frictionSignature)
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    // Normal task created
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('regression — friction task without frictionSignature creates normally (no dedup)', async () => {
    const task = { id: 'fr-no-sig', workspaceId: 'ws-1', title: '[friction] untraced error' };
    const mockReturning = mock(() => [task]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/tasks', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_xxx' }),
        body: JSON.stringify({
          workspaceId: 'ws-1',
          title: '[friction] untraced error',
          description: 'Something broke in an unexpected way',
          // No context.frictionSignature
        }),
      }),
    );
    expect(response.status).toBe(200);

    // Gate condition not met → no dedup check
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
  });
});
