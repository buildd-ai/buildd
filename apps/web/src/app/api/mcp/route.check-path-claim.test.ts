/**
 * Tests for the check_path_claim tool in the MCP route handler.
 *
 * The MCP handler now delegates conflict detection and claim insertion to
 * @buildd/core/path-claim, matching the REST endpoint at
 * apps/web/src/app/api/tasks/[id]/path-claim/route.ts.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WORKER_ID = 'a1a1a1a1-0000-4000-8000-000000000111';
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const SIBLING_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MISSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER_MISSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ── Mocks must be declared before import ────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve([])),
}));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));

// path-claim module mocks
const mockAppendPathManifest = mock(async (_taskId: string, paths: string[]) => paths);
const mockCheckPathClaimConflict = mock(async () => null as any);
const mockInsertClaims = mock(async () => [] as string[]);
const mockRegisterWaiter = mock(async () => ({ registered: true }));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      teams: { findFirst: mock(() => Promise.resolve(null)) },
      workers: { findFirst: mockWorkersFindFirst },
      tasks: {
        findFirst: mockTasksFindFirst,
      },
    },
    insert: mockInsert,
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

// The real acquisition is one locked statement (packages/core, covered by
// path-claim-ownership.test.ts). This fake composes it from per-step mocks so
// the cases below can script a conflict, the leases and the manifest.
const mockAcquirePathClaims = mock(async ({ workspaceId, taskId, paths }: any) => {
  const conflict = await mockCheckPathClaimConflict(workspaceId, taskId, paths);
  if (conflict) return { kind: 'conflict', conflict, blocked: [] };
  const inserted = await mockInsertClaims(workspaceId, taskId, paths);
  const pathManifest = await mockAppendPathManifest(taskId, paths);
  return { kind: 'acquired', inserted, blocked: [], pathManifest, revision: 1 };
});
const mockNarrowPathClaims = mock(async (_input: any) => ({ kind: 'not_found' }) as any);
mock.module('@buildd/core/path-claim', () => ({
  acquirePathClaims: mockAcquirePathClaims,
  narrowPathClaims: mockNarrowPathClaims,
  registerWaiter: mockRegisterWaiter,
}));
const mockDeliverPathReleased = mock(async (..._args: any[]) => {});
mock.module('@/lib/path-claim-release', () => ({
  deliverPathReleased: mockDeliverPathReleased,
  releaseAndNotify: mock(async () => {}),
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {
    upsert() { return Promise.resolve([]); }
    search() { return Promise.resolve([]); }
  },
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

mock.module('@buildd/core/memory-store', () => ({
  MemoryStore: class {
    search() { return Promise.resolve({ results: [], total: 0 }); }
    batch() { return Promise.resolve({ memories: [] }); }
  },
}));

mock.module('@buildd/core/mcp-tools', () => ({
  handleBuilddAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleMemoryAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleRecallAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleLearnAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  triggerActions: [],
  workerActions: [],
  adminActions: [],
  allActions: [],
  memoryActions: [],
  buildToolDescription: () => 'description',
  buildParamsDescription: () => 'params',
  buildMemoryDescription: () => 'memory',
}));

const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_input: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: REAL_GATE_SLUGS,
  fireGateEvent: mockFireGateEvent,
  gateCallerOrigin: (i: { apiAccount?: unknown; user?: unknown; workerId?: string | null }) =>
    i.workerId ? 'worker' : i.apiAccount ? 'api' : i.user ? 'dashboard' : 'system',
}));

import { POST } from './route';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolCallRequest(toolArgs: unknown, workerId = WORKER_ID) {
  const workerParam = workerId ? `?worker=${workerId}` : '';
  return new Request(`http://localhost/api/mcp${workerParam}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      Authorization: 'Bearer bld_test',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'check_path_claim',
        arguments: toolArgs,
      },
    }),
  });
}

async function callTool(toolArgs: unknown, workerId = WORKER_ID): Promise<any> {
  const req = makeToolCallRequest(toolArgs, workerId);
  const res = await POST(req);
  return res.json();
}

function makeActiveTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    workspaceId: WORKSPACE_ID,
    missionId: null,
    status: 'in_progress',
    pathManifest: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('check_path_claim MCP handler', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockAppendPathManifest.mockReset();
    mockInsert.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockCheckPathClaimConflict.mockReset();
    mockInsertClaims.mockReset();
    mockAcquirePathClaims.mockClear();
    mockNarrowPathClaims.mockReset();
    mockNarrowPathClaims.mockResolvedValue({ kind: 'not_found' });
    mockDeliverPathReleased.mockReset();
    mockRegisterWaiter.mockReset();
    mockFireGateEvent.mockReset();

    // Default: authenticated, worker resolves to task, no conflict, append succeeds
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1', authType: 'api' });
    mockWorkersFindFirst.mockResolvedValue({ taskId: TASK_ID, accountId: 'acc-1', workspace: { teamId: 'team-1' } });
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockCheckPathClaimConflict.mockResolvedValue(null);
    mockAppendPathManifest.mockImplementation(async (_taskId: string, paths: string[]) => paths);
    mockInsertClaims.mockResolvedValue(['src/new.ts']);
    mockRegisterWaiter.mockResolvedValue({ registered: true });
    mockInsert.mockReturnValue({
      values: mock(() => Promise.resolve([])),
    });
    mockWorkspacesFindFirst.mockResolvedValue(null);
  });

  it('returns isError when no worker context', async () => {
    const body: any = await callTool({ paths: ['src/foo.ts'] }, '');
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('worker');
  });

  it('refuses a ?worker= id that belongs to another account and team', async () => {
    mockWorkersFindFirst.mockResolvedValue({ taskId: TASK_ID, accountId: 'acc-other', workspace: { teamId: 'team-other' } });
    const res = await POST(makeToolCallRequest({ paths: ['src/foo.ts'] }));
    expect(res.status).toBe(403);
    expect(mockInsertClaims).not.toHaveBeenCalled();
    expect(mockAppendPathManifest).not.toHaveBeenCalled();
  });

  it('accepts a ?worker= id in a workspace of the caller team', async () => {
    mockWorkersFindFirst.mockResolvedValue({ taskId: TASK_ID, accountId: 'acc-other', workspace: { teamId: 'team-1' } });
    const res = await POST(makeToolCallRequest({ paths: ['src/foo.ts'] }));
    expect(res.status).toBe(200);
  });

  it('returns isError when paths is empty', async () => {
    const body: any = await callTool({ paths: [] });
    const result = body.result;
    expect(result.isError).toBe(true);
  });

  // ── Wildcard guard ──────────────────────────────────────────────────────────

  it('returns isError for wildcard "**" paths', async () => {
    const body: any = await callTool({ paths: ['**'] });
    const result = body.result;
    expect(result.isError).toBe(true);
    const text = JSON.parse(result.content[0].text);
    expect(text.error).toContain('Wildcard');
  });

  it('returns isError when "**" mixed with specific paths', async () => {
    const body: any = await callTool({ paths: ['src/foo.ts', '**'] });
    const result = body.result;
    expect(result.isError).toBe(true);
  });

  // ── Claim success ───────────────────────────────────────────────────────────

  it('claims unclaimed paths and extends pathManifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/existing.ts'] }));
    mockAppendPathManifest.mockResolvedValue(['src/existing.ts', 'src/new.ts']);

    const body: any = await callTool({ paths: ['src/new.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(true);
    expect(result.pathManifest).toContain('src/existing.ts');
    expect(result.pathManifest).toContain('src/new.ts');
  });

  // Regression: check_path_claim used to CAS tasks.pathManifest with a fixed
  // 3-attempt retry loop. Under bursty concurrent calls for the same task it
  // could exhaust those retries and return `{claimed: false, error:
  // "Concurrent update conflict. Please retry."}` — indistinguishable from a
  // real blocker, with no blockingTaskId to act on. appendPathManifest
  // replaced the CAS with a single atomic statement, so there is no retry
  // loop left: this asserts the handler calls it exactly once.
  it('acquires via a single call with no CAS retry loop', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));
    mockAppendPathManifest.mockResolvedValue(['src/new.ts']);

    const body: any = await callTool({ paths: ['src/new.ts'] });
    const result = JSON.parse(body.result.content[0].text);

    expect(result.claimed).toBe(true);
    expect(result.pathManifest).toEqual(['src/new.ts']);
    expect(mockAcquirePathClaims).toHaveBeenCalledTimes(1);
    expect(mockTasksFindFirst).toHaveBeenCalledTimes(1);
  });

  it('inserts path_claims rows on successful claim', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));

    await callTool({ paths: ['src/new.ts'] });
    expect(mockInsertClaims).toHaveBeenCalledTimes(1);
    expect(mockInsertClaims).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, ['src/new.ts']);
  });

  // Regression: a path already in the manifest used to short-circuit to
  // claimed:true without a lease, so the claim-route backstop never saw it.
  it('still leases a path already in the manifest, without duplicating it', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/foo.ts'] }));
    mockAppendPathManifest.mockResolvedValue(['src/foo.ts']);

    const body: any = await callTool({ paths: ['src/foo.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(true);
    expect(result.pathManifest).toEqual(['src/foo.ts']);
    expect(result.revision).toBe(1);
    expect(mockInsertClaims).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, ['src/foo.ts']);
  });

  // ── Conflict / waiter registration ─────────────────────────────────────────

  it('returns claimed=false when paths conflict with an active claim', async () => {
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/shared.ts',
    });
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID })) // worker task
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Sibling', missionId: MISSION_ID }); // blocker

    const body: any = await callTool({ paths: ['src/shared.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(false);
    expect(result.blockingTaskId).toBe(SIBLING_ID);
  });

  it('registers requester as waiter on conflict', async () => {
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/shared.ts',
    });
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask())
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Sibling', missionId: null });

    await callTool({ paths: ['src/shared.ts'] });
    expect(mockRegisterWaiter).toHaveBeenCalledWith(
      SIBLING_ID, TASK_ID, 'src/shared.ts', WORKSPACE_ID,
    );
  });

  it('cross-mission conflict includes blockingMissionId and mentions different mission', async () => {
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/shared.ts',
    });
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Cross', missionId: OTHER_MISSION_ID });

    const body: any = await callTool({ paths: ['src/shared.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.blockingMissionId).toBe(OTHER_MISSION_ID);
    expect(result.message).toContain('different mission');
  });

  it('deadlock flag propagates in conflict response', async () => {
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/x.ts',
    });
    const cycle = [TASK_ID, SIBLING_ID, TASK_ID];
    mockRegisterWaiter.mockResolvedValue({ deadlock: true, cycle });
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: null }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'B', missionId: null });

    const body: any = await callTool({ paths: ['src/x.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.deadlock).toBe(true);
    expect(result.cycle).toEqual(cycle);
    expect(result.message).toContain('DEADLOCK DETECTED');
    expect(result.message).toContain('circular wait cycle');
    expect(result.message).toContain('cancel this task');
  });

  it('posts mission note on deadlock with missionId', async () => {
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/x.ts',
    });
    const cycle = [TASK_ID, SIBLING_ID, TASK_ID];
    mockRegisterWaiter.mockResolvedValue({ deadlock: true, cycle });
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'B', missionId: MISSION_ID });

    const body: any = await callTool({ paths: ['src/x.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.deadlock).toBe(true);
    expect(mockInsert).toHaveBeenCalled();
  });

  // ── Shared implementation (lib/path-claim-check.ts) ─────────────────────────
  // This entry point used to carry its own copy. The MCP copy never recorded a
  // gate event and told waiters to watch a Pusher event no agent subscribes to.

  it('records a deferred path_claim gate event on conflict, tagged with this surface', async () => {
    const PATHS = ['src/shared.ts'];
    mockCheckPathClaimConflict.mockResolvedValue({ blockingTaskId: SIBLING_ID, blockingPath: 'src/shared.ts' });
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Sibling', missionId: MISSION_ID });

    const result: any = JSON.parse((await callTool({ paths: PATHS })).result.content[0].text);
    expect(result.claimed).toBe(false);
    expect(result.message).toContain('path_released message');
    expect(result.message).not.toContain('Pusher');

    expect(mockFireGateEvent).toHaveBeenCalledTimes(1);
    const ev: any = mockFireGateEvent.mock.calls[0][0];
    expect(ev.gate).toBe(REAL_GATE_SLUGS.PATH_CLAIM);
    expect(ev.outcome).toBe('deferred');
    expect(ev.surface).toBe('mcp:check_path_claim');
    expect(ev.callerOrigin).toBe('worker');
    expect(ev.taskId).toBe(TASK_ID);
    expect(ev.detail.blockingTaskId).toBe(SIBLING_ID);
  });

  it('records a rejected path_claim gate event for a wildcard', async () => {
    const PATHS = ['**'];
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    await callTool({ paths: PATHS });
    expect(mockFireGateEvent).toHaveBeenCalledTimes(1);
    const ev: any = mockFireGateEvent.mock.calls[0][0];
    expect(ev.outcome).toBe('rejected');
    expect(ev.surface).toBe('mcp:check_path_claim');
  });

  // ── release=true: selective narrowing ──────────────────────────────────────

  it('release=true narrows this worker\'s own task and reports the new revision', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockNarrowPathClaims.mockResolvedValue({
      kind: 'narrowed', workspaceId: WORKSPACE_ID, pathManifest: ['src/keep.ts'], revision: 4,
      releasedPaths: ['src/drop.ts'], notifiedWaiters: [SIBLING_ID],
      waiters: [{ waitingTaskId: SIBLING_ID, blockedPath: 'src/drop.ts' }],
    });

    const body: any = await callTool({ paths: ['src/drop.ts'], release: true, expectedRevision: 3, reason: 'stale' });
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toEqual({ released: true, releasedPaths: ['src/drop.ts'], pathManifest: ['src/keep.ts'], notifiedWaiters: [SIBLING_ID], revision: 4 });
    expect(mockNarrowPathClaims).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID, taskId: TASK_ID, paths: ['src/drop.ts'], expectedRevision: 3, reason: 'stale', surface: 'mcp:check_path_claim',
    }));
    expect(mockAcquirePathClaims).not.toHaveBeenCalled();
    expect(mockDeliverPathReleased).toHaveBeenCalledTimes(1);
  });

  it('release=true with a stale revision is a retryable error', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockNarrowPathClaims.mockResolvedValue({ kind: 'revision_conflict', currentRevision: 9 });
    const body: any = await callTool({ paths: ['src/drop.ts'], release: true, expectedRevision: 3 });
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ released: false, retryable: true, currentRevision: 9 });
  });
});
