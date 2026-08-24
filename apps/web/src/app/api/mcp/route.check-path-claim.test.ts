/**
 * Tests for the check_path_claim tool in the MCP route handler.
 *
 * The MCP handler now delegates conflict detection and claim insertion to
 * @buildd/core/path-claim, matching the REST endpoint at
 * apps/web/src/app/api/tasks/[id]/path-claim/route.ts.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WORKER_ID = 'worker-aaa-111';
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const SIBLING_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MISSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER_MISSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ── Mocks must be declared before import ────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockReturning = mock(() => Promise.resolve([{ id: TASK_ID }]));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mockReturning,
    })),
  })),
}));
const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve([])),
}));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));

// path-claim module mocks
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
    update: mockTasksUpdate,
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

mock.module('@buildd/core/path-claim', () => ({
  checkPathClaimConflict: mockCheckPathClaimConflict,
  insertClaims: mockInsertClaims,
  registerWaiter: mockRegisterWaiter,
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {
    upsert() { return Promise.resolve([]); }
    search() { return Promise.resolve([]); }
  },
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

mock.module('@buildd/core/memory-client', () => ({
  MemoryClient: class {
    getContext() { return Promise.resolve({ markdown: '' }); }
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
    mockReturning.mockReset();
    mockTasksUpdate.mockReset();
    mockInsert.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockCheckPathClaimConflict.mockReset();
    mockInsertClaims.mockReset();
    mockRegisterWaiter.mockReset();

    // Default: authenticated, worker resolves to task, no conflict, CAS succeeds
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1', authType: 'api' });
    mockWorkersFindFirst.mockResolvedValue({ taskId: TASK_ID });
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockCheckPathClaimConflict.mockResolvedValue(null);
    mockInsertClaims.mockResolvedValue(['src/new.ts']);
    mockRegisterWaiter.mockResolvedValue({ registered: true });
    mockReturning.mockResolvedValue([{ id: TASK_ID }]);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mockReturning,
        })),
      })),
    });
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

    const body: any = await callTool({ paths: ['src/new.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(true);
    expect(result.pathManifest).toContain('src/existing.ts');
    expect(result.pathManifest).toContain('src/new.ts');
  });

  it('inserts path_claims rows on successful claim', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));

    await callTool({ paths: ['src/new.ts'] });
    expect(mockInsertClaims).toHaveBeenCalledTimes(1);
    expect(mockInsertClaims).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, ['src/new.ts']);
  });

  it('does not add duplicate paths already in manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/foo.ts'] }));

    const body: any = await callTool({ paths: ['src/foo.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(true);
    expect(result.pathManifest).toEqual(['src/foo.ts']);
    expect(mockInsertClaims).not.toHaveBeenCalled();
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
  });
});
