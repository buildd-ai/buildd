import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ActionContext, type ApiFn } from '../mcp-tools';

const WORKER_ID = '510a982f-61f6-4fde-b37c-b2bbdc6d1f03';
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workerId: WORKER_ID,
    workspaceId: WORKSPACE_ID,
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('claim_task current assignment recovery', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('returns the calling worker assignment instead of claiming another task', async () => {
    mockApi.mockResolvedValue({
      id: WORKER_ID,
      status: 'running',
      branch: 'buildd/current-task',
      task: {
        id: 'task-current',
        title: 'Current task',
        description: 'Keep working on this task',
        status: 'assigned',
      },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctx(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/${WORKER_ID}`);
    expect(result.content[0].text).toContain('Current assignment');
    expect(result.content[0].text).toContain(WORKER_ID);
    expect(result.content[0].text).toContain('Current task');
    expect(result.content[0].text).toContain('buildd/current-task');
  });

  it('recovers the exact assignment before an ambiguous OAuth workspace guard', async () => {
    mockApi.mockResolvedValue({
      id: WORKER_ID,
      status: 'starting',
      branch: 'buildd/current-task',
      task: {
        id: 'task-current',
        title: 'Current task',
        status: 'assigned',
      },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctx({
        authType: 'oauth',
        workspaceId: undefined,
        getWorkspaceId: async () => null,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/${WORKER_ID}`);
    expect(result.content[0].text).toContain('Current assignment');
  });

  it('continues to the claim endpoint when the contextual worker is terminal', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: WORKER_ID,
        status: 'completed',
        task: { id: 'task-old', title: 'Old task', status: 'completed' },
      })
      .mockResolvedValueOnce({ workers: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctx(),
    );

    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi.mock.calls[1][0]).toBe('/api/workers/claim');
    expect(result.content[0].text).toContain('Nothing claimed');
  });
});

// Friction task 81962c2f: an interactive admin session wanted one specific
// pending mission task. claim_task could not target it, and the empty result
// said "All tasks may be assigned or completed" while tasks were pending and the
// route had computed the real reason in `diagnostics`.
describe('claim_task explicit taskId and empty-claim reasons', () => {
  const TASK_ID = '00000000-0000-4000-8000-000000000123';
  let mockApi: ReturnType<typeof mock>;

  // No worker context: an interactive session, not a hosted worker.
  const interactive = () => ctx({ workerId: undefined, getLevel: async () => 'admin' });

  beforeEach(() => {
    mockApi = mock();
  });

  function claimBody(): any {
    const call = mockApi.mock.calls.find((c: any[]) => c[0] === '/api/workers/claim');
    return JSON.parse(call![1].body);
  }

  it('passes taskId through to the claim route', async () => {
    mockApi.mockResolvedValueOnce({
      workers: [{ id: WORKER_ID, branch: 'buildd/x', task: { id: TASK_ID, title: 'Picked task', description: 'd' } }],
    });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', { taskId: TASK_ID }, interactive());

    expect(claimBody()).toMatchObject({ taskId: TASK_ID, runner: 'mcp', maxTasks: 1, workspaceId: WORKSPACE_ID });
    expect(result.content[0].text).toContain('Picked task');
  });

  it('omits taskId from the body when not given (auto-assign unchanged)', async () => {
    mockApi.mockResolvedValueOnce({ workers: [] });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', {}, interactive());
    expect('taskId' in claimBody()).toBe(false);
  });

  it('rejects a short task id prefix before calling the route', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', { taskId: '81962c2f' }, interactive()),
    ).rejects.toThrow(/full UUID/);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('names the route diagnostics reason instead of "all tasks may be assigned or completed"', async () => {
    mockApi.mockResolvedValueOnce({
      workers: [],
      diagnostics: { reason: 'no_slots', activeWorkers: 3, maxConcurrent: 3 },
    });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', {}, interactive());
    const out = result.content[0].text;
    expect(out).toStartWith('Nothing claimed:');
    expect(out).toContain('no_slots');
    expect(out).toContain('3/3');
    expect(out).not.toMatch(/may be assigned or completed/);
  });

  it('lists per-reason deferrals when every candidate was deferred', async () => {
    mockApi.mockResolvedValueOnce({
      workers: [],
      diagnostics: { reason: 'all_candidates_deferred', pendingTasks: 1, matchedTasks: 1, deferrals: { mission_paced: 1 } },
    });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', { taskId: TASK_ID }, interactive());
    const out = result.content[0].text;
    expect(out).toContain('all_candidates_deferred');
    expect(out).toContain('mission_paced');
  });

  it('surfaces the per-task exclusion when an explicit taskId was filtered out', async () => {
    mockApi.mockResolvedValueOnce({
      workers: [],
      diagnostics: {
        reason: 'no_pending_tasks',
        taskExclusion: { code: 'mission_held', detail: 'Its mission is held. Arm the mission, or force-start this task from the dashboard.' },
      },
    });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', { taskId: TASK_ID }, interactive());
    const out = result.content[0].text;
    expect(out).toContain(TASK_ID);
    expect(out).toContain('mission_held');
    expect(out).toContain('Its mission is held');
  });

  it('says the server gave no reason rather than guessing when diagnostics are absent', async () => {
    mockApi.mockResolvedValueOnce({ workers: [] });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', {}, interactive());
    const out = result.content[0].text;
    expect(out).toStartWith('Nothing claimed');
    expect(out).not.toMatch(/may be assigned or completed/);
  });

  it('an explicit taskId for a different task skips the current-assignment shortcut', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: WORKER_ID,
        status: 'running',
        task: { id: 'task-current', title: 'Current task', status: 'in_progress' },
      })
      .mockResolvedValueOnce({
        workers: [{ id: 'w-new', branch: 'buildd/y', task: { id: TASK_ID, title: 'Other task' } }],
      });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'claim_task', { taskId: TASK_ID }, ctx());
    expect(claimBody().taskId).toBe(TASK_ID);
    expect(result.content[0].text).toContain('Other task');
  });

  it('documents taskId in the params description, and list_tasks no longer says you cannot pick by id', async () => {
    expect(buildParamsDescription(['claim_task'])).toMatch(/taskId\?/);
    mockApi.mockResolvedValueOnce({
      tasks: [{ id: TASK_ID, title: 'T', status: 'pending' }], total: 1, pendingCount: 1, hasMore: false,
    });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_tasks', {}, interactive());
    expect(result.content[0].text).not.toMatch(/don't pick by ID/);
    expect(result.content[0].text).toMatch(/taskId/);
  });
});
