/**
 * Tests for the check_path_claim tool in the MCP route handler.
 *
 * Mirrors the coverage in apps/web/src/app/api/tasks/[id]/path-claim/route.test.ts
 * — the two implementations share the same sibling-overlap logic and must not
 * drift. The note in the PR description flags the duplication for a future
 * extraction into a shared helper (spec task).
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
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const mockPathClaimsFindMany = mock(() => Promise.resolve([] as any[]));
const mockReturning = mock(() => Promise.resolve([{ id: TASK_ID }]));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mockReturning,
    })),
  })),
}));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));

const mockInsert = mock(() => ({
  values: mock(() => ({
    onConflictDoNothing: mock(() => Promise.resolve()),
  })),
}));

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
        findMany: mockTasksFindMany,
      },
      pathClaims: { findMany: mockPathClaimsFindMany },
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
      // MCP Streamable HTTP transport requires both accept types
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
    mockTasksFindMany.mockReset();
    mockPathClaimsFindMany.mockReset();
    mockReturning.mockReset();
    mockTasksUpdate.mockReset();
    mockInsert.mockReset();
    mockWorkspacesFindFirst.mockReset();

    // Default: authenticated, worker resolves to task, CAS succeeds
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1', authType: 'api' });
    mockWorkersFindFirst.mockResolvedValue({ taskId: TASK_ID });
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockTasksFindMany.mockResolvedValue([]);
    mockPathClaimsFindMany.mockResolvedValue([]);
    mockReturning.mockResolvedValue([{ id: TASK_ID }]);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mockReturning,
        })),
      })),
    });
    mockInsert.mockReturnValue({
      values: mock(() => ({
        onConflictDoNothing: mock(() => Promise.resolve()),
      })),
    });
    mockWorkspacesFindFirst.mockResolvedValue(null);
  });

  it('returns isError when no worker context', async () => {
    // Call without ?worker= param — the handler requires a worker context
    const body: any = await callTool({ paths: ['src/foo.ts'] }, '');
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('worker');
  });

  it('claims unclaimed paths and extends pathManifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/existing.ts'] }));
    mockPathClaimsFindMany.mockResolvedValue([]);

    const body: any = await callTool({ paths: ['src/new.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(true);
    expect(result.pathManifest).toContain('src/existing.ts');
    expect(result.pathManifest).toContain('src/new.ts');
  });

  it('blocks on a same-mission sibling with overlapping manifest', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Sibling', missionId: MISSION_ID });
    mockPathClaimsFindMany.mockResolvedValue([
      { taskId: SIBLING_ID, path: 'src/shared.ts' },
    ]);

    const body: any = await callTool({ paths: ['src/shared.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(false);
    expect(result.blockingTaskId).toBe(SIBLING_ID);
    expect(result.blockingMissionId).toBe(MISSION_ID);
    expect(result.message).toContain('dependsOn');
    expect(result.message).not.toContain('different mission');
  });

  it('blocks on a cross-mission sibling — workspace scope catches it', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Cross-mission task', missionId: OTHER_MISSION_ID });
    mockPathClaimsFindMany.mockResolvedValue([
      { taskId: SIBLING_ID, path: 'src/shared.ts' },
    ]);

    const body: any = await callTool({ paths: ['src/shared.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(false);
    expect(result.blockingTaskId).toBe(SIBLING_ID);
    expect(result.blockingMissionId).toBe(OTHER_MISSION_ID);
    expect(result.message).toContain('different mission');
  });

  it('response carries blockingMissionId for cross-mission blocker', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Other mission task', missionId: OTHER_MISSION_ID });
    mockPathClaimsFindMany.mockResolvedValue([
      { taskId: SIBLING_ID, path: 'pkg/core/schema.ts' },
    ]);

    const body: any = await callTool({ paths: ['pkg/core/schema.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.blockingMissionId).toBe(OTHER_MISSION_ID);
  });

  it('orphan task (null missionId) blocks against mission-owned sibling', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: null }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Mission-owned sibling', missionId: MISSION_ID });
    mockPathClaimsFindMany.mockResolvedValue([
      { taskId: SIBLING_ID, path: 'src/shared.ts' },
    ]);

    const body: any = await callTool({ paths: ['src/shared.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(false);
    expect(result.blockingTaskId).toBe(SIBLING_ID);
    expect(result.blockingMissionId).toBe(MISSION_ID);
  });

  it('mission-owned task blocks against orphan sibling (null missionId)', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Orphan sibling', missionId: null });
    mockPathClaimsFindMany.mockResolvedValue([
      { taskId: SIBLING_ID, path: 'src/shared.ts' },
    ]);

    const body: any = await callTool({ paths: ['src/shared.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(false);
    expect(result.blockingTaskId).toBe(SIBLING_ID);
    expect(result.blockingMissionId).toBeNull();
  });

  it('does not add duplicate paths already in manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/foo.ts'] }));
    mockPathClaimsFindMany.mockResolvedValue([]);

    const body: any = await callTool({ paths: ['src/foo.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(true);
    expect(result.pathManifest).toEqual(['src/foo.ts']);
  });

  it('skips sibling with null pathManifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    // A task with null pathManifest has no path_claims rows — empty result means no block
    mockPathClaimsFindMany.mockResolvedValue([]);

    const body: any = await callTool({ paths: ['src/foo.ts'] });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.claimed).toBe(true);
  });
});
