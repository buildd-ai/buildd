import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

// Regression for dispatch-family mission 0934666a (Jul 2026): an organizer task
// was cancelled via update_task status:cancelled while its worker was mid-evaluation
// (~6 min of reads, no update_progress syncs). The worker never saw the abort —
// termination is only propagated via the response.abort flag on updateWorker sync —
// finished evaluating, and successfully called create_task twice, spawning duplicate
// tasks from a cancelled parent.
//
// Fix: checkWriteFence blocks mutating actions when the calling worker's task is in
// a terminal state (cancelled/failed). complete_task is allowed through when the
// worker already shows completed or has deliverables (complete-vs-abort race carve-out).

const WORKER_ID = 'worker-abc123';
const TASK_ID = 'task-xyz789';
const WS_ID = '00000000-0000-0000-0000-000000000001';

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workerId: WORKER_ID,
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'worker',
    authType: 'api',
    ...overrides,
  };
}

function workerPayload(
  taskStatus: string,
  workerStatus = 'running',
  extra: Record<string, unknown> = {},
) {
  return {
    id: WORKER_ID,
    status: workerStatus,
    taskId: TASK_ID,
    prUrl: null,
    prNumber: null,
    task: { id: TASK_ID, status: taskStatus },
    ...extra,
  };
}

describe('write fence — checkWriteFence', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  // ── Fence activates ──────────────────────────────────────────────────────────

  it('blocks create_task when calling worker task is cancelled', async () => {
    mockApi.mockResolvedValueOnce(workerPayload('cancelled'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Orphan task', description: 'Should be blocked' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/CANCELLED/);
    expect(result.content[0].text).toMatch(/create_task/);
    expect(result.content[0].text).toMatch(TASK_ID);
    // Must not have called /api/tasks
    const taskCall = mockApi.mock.calls.find((c) => c[0] === '/api/tasks');
    expect(taskCall).toBeUndefined();
  });

  it('blocks create_task when calling worker task is failed', async () => {
    mockApi.mockResolvedValueOnce(workerPayload('failed'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Orphan task', description: 'Should be blocked' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/FAILED/);
  });

  it('blocks create_pr when task is cancelled', async () => {
    mockApi.mockResolvedValueOnce(workerPayload('cancelled'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_pr',
      { title: 'My PR', head: 'my-branch' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/create_pr/);
  });

  it('blocks create_artifact when task is cancelled', async () => {
    mockApi.mockResolvedValueOnce(workerPayload('cancelled'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_artifact',
      { type: 'summary', title: 'Summary' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/create_artifact/);
  });

  it('blocks emit_event when task is cancelled', async () => {
    mockApi.mockResolvedValueOnce(workerPayload('cancelled'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'emit_event',
      { type: 'status', label: 'done' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/emit_event/);
  });

  it('blocks complete_task when task is cancelled and worker has no deliverables', async () => {
    mockApi.mockResolvedValueOnce(workerPayload('cancelled', 'running'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'complete_task',
      { summary: 'Done' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/complete_task/);
  });

  // ── complete_task carve-out (complete-vs-abort race) ────────────────────────

  it('allows complete_task when worker is already completed (race carve-out)', async () => {
    // Worker completed before the cancel was set on the task — let it through
    mockApi.mockResolvedValueOnce(workerPayload('cancelled', 'completed'));
    // complete_task will fetch the worker again for effort/release info
    mockApi.mockResolvedValue({ taskId: TASK_ID, completedAt: null });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'complete_task',
      { summary: 'Done' },
      makeCtx(),
    );

    // Should NOT be a fence error (may be another error from underlying API, that's fine)
    expect(result.content[0].text).not.toMatch(/CANCELLED.*blocked/);
    expect(result.content[0].text).not.toMatch(/terminated externally/);
  });

  it('allows complete_task when worker has a PR (hasDeliverables carve-out)', async () => {
    mockApi.mockResolvedValueOnce(
      workerPayload('cancelled', 'running', { prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 }),
    );
    mockApi.mockResolvedValue({ taskId: TASK_ID, completedAt: null });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'complete_task',
      { summary: 'Done' },
      makeCtx(),
    );

    expect(result.content[0].text).not.toMatch(/CANCELLED.*blocked/);
    expect(result.content[0].text).not.toMatch(/terminated externally/);
  });

  // ── Fence does NOT activate ──────────────────────────────────────────────────

  it('does not fence when task is running (pending/assigned/in_progress)', async () => {
    mockApi
      .mockResolvedValueOnce(workerPayload('in_progress'))          // fence check
      .mockResolvedValueOnce(workerPayload('in_progress'))          // create_task missionId lookup
      .mockResolvedValueOnce({ id: 'new-task', title: 'New', priority: 5 }); // create_task POST

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'New', description: 'Normal task' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
  });

  it('does not fence when there is no workerId in context', async () => {
    mockApi.mockResolvedValue({ id: 'new-task', title: 'New', priority: 5 });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'New', description: 'Normal task' },
      makeCtx({ workerId: undefined }),
    );

    expect(result.isError).toBeFalsy();
    // No /api/workers call should have been made for the fence
    const workerCall = mockApi.mock.calls.find((c) => String(c[0]).includes('/api/workers/'));
    expect(workerCall).toBeUndefined();
  });

  it('does not fence non-mutating actions like get_task', async () => {
    // No worker lookup should happen for get_task
    mockApi.mockResolvedValueOnce({ id: TASK_ID, title: 'T', status: 'cancelled' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const workerCall = mockApi.mock.calls.find((c) => String(c[0]).includes('/api/workers/'));
    expect(workerCall).toBeUndefined();
  });

  it('does not fence update_progress (handled by PATCH 409)', async () => {
    // The PATCH route returns 409 for terminated workers — fence should not intercept this
    mockApi.mockResolvedValue({
      status: 'running',
      progress: 50,
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      { progress: 50, message: 'still going' },
      makeCtx(),
    );

    // update_progress result — whatever it is, no fence error
    expect(result.content[0].text).not.toMatch(/terminated externally/);
    // No /api/workers GET call for fence (PATCH is used by update_progress itself)
    const workerGetCalls = mockApi.mock.calls.filter(
      (c) => String(c[0]).includes('/api/workers/') && !c[1],
    );
    expect(workerGetCalls).toHaveLength(0);
  });

  it('fails open when worker lookup throws (allows the action through)', async () => {
    // Fence check throws → fail open; create_task then does its own worker lookup + POST
    mockApi
      .mockRejectedValueOnce(new Error('Network error'))            // fence worker lookup
      .mockResolvedValueOnce(workerPayload('in_progress'))          // create_task missionId lookup
      .mockResolvedValueOnce({ id: 'new-task', title: 'New', priority: 5 }); // create_task POST

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'New', description: 'Fallback allowed' },
      makeCtx(),
    );

    // Should not be a fence error — fail open
    expect(result.content[0].text).not.toMatch(/terminated externally/);
  });
});
