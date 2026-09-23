import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const MOCK_WORKER_ID = '00000000-0000-0000-0000-000000000002';
const MOCK_TASK_ID = '00000000-0000-0000-0000-000000000003';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    workerId: MOCK_WORKER_ID,
    authType: 'oauth',
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('get_error_traces', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('fetches by explicit workerId when provided', async () => {
    mockApi.mockResolvedValueOnce({
      traces: [
        { pattern: 'cd_no_such_file', excerpt: 'cd: /home/coder/missing: No such file or directory', source: 'bash', ts: '2026-05-26T01:00:00Z' },
      ],
      count: 1,
    });

    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { workerId: 'worker-xyz' },
      ctx(),
    );

    expect(res.isError).toBeFalsy();
    expect(mockApi).toHaveBeenCalledTimes(1);
    const endpoint = mockApi.mock.calls[0][0];
    expect(endpoint).toMatch(/^\/api\/workers\/worker-xyz\/error-traces/);
    expect(res.content[0].text).toMatch(/cd_no_such_file/);
    expect(res.content[0].text).toMatch(/No such file/);
  });

  it('fetches by explicit taskId when provided (returns cumulative)', async () => {
    mockApi.mockResolvedValueOnce({
      traces: [
        { pattern: 'git_fatal', excerpt: 'fatal: bad revision', source: 'bash', ts: '2026-05-26T01:00:00Z' },
        { pattern: 'permission_denied', excerpt: 'Permission denied', source: 'bash', ts: '2026-05-26T00:59:00Z' },
      ],
      count: 2,
    });

    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { taskId: 'task-abc' },
      ctx(),
    );

    expect(res.isError).toBeFalsy();
    const endpoint = mockApi.mock.calls[0][0];
    expect(endpoint).toMatch(/^\/api\/tasks\/task-abc\/error-traces/);
    expect(res.content[0].text).toMatch(/2 error trace/);
  });

  it('defaults to current worker\'s task when nothing is passed', async () => {
    // First call: fetch worker → returns taskId
    mockApi.mockResolvedValueOnce({ id: MOCK_WORKER_ID, taskId: MOCK_TASK_ID });
    // Second call: fetch error traces by task
    mockApi.mockResolvedValueOnce({ traces: [], count: 0 });

    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      {},
      ctx(),
    );

    expect(res.isError).toBeFalsy();
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/${MOCK_WORKER_ID}`);
    expect(mockApi.mock.calls[1][0]).toMatch(new RegExp(`^/api/tasks/${MOCK_TASK_ID}/error-traces`));
    expect(res.content[0].text).toMatch(/No error traces/);
  });

  it('returns helpful message when there are no traces', async () => {
    mockApi.mockResolvedValueOnce({ traces: [], count: 0 });

    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { workerId: 'w1' },
      ctx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/No error traces/);
  });

  it('errors naming every scope when no worker, task, or workspace can be resolved', async () => {
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      {},
      ctx({ workerId: undefined, workspaceId: undefined, getWorkspaceId: async () => null }),
    );

    expect(res.isError).toBe(true);
    expect(mockApi).toHaveBeenCalledTimes(0);
    expect(res.content[0].text).toMatch(/taskId/);
    expect(res.content[0].text).toMatch(/workerId/);
    expect(res.content[0].text).toMatch(/workspaceId/);
  });

  it('rolls up by explicit workspaceId, passing since and limit, and renders per-pattern counts', async () => {
    mockApi.mockResolvedValueOnce({
      workspaceId: MOCK_WORKSPACE_ID,
      since: '2026-05-19T00:00:00.000Z',
      limit: 10,
      patterns: [
        { pattern: 'git_fatal', count: 7, taskCount: 3, firstSeen: '2026-05-20T00:00:00.000Z', lastSeen: '2026-05-26T00:00:00.000Z', exampleExcerpt: 'fatal: bad revision', exampleSource: 'bash', exampleTaskIds: ['t-1', 't-2'] },
        { pattern: 'oom', count: 1, taskCount: 1, firstSeen: '2026-05-25T00:00:00.000Z', lastSeen: '2026-05-25T00:00:00.000Z', exampleExcerpt: 'Killed', exampleSource: null, exampleTaskIds: ['t-9'] },
      ],
    });

    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { workspaceId: MOCK_WORKSPACE_ID, since: '2026-05-19T00:00:00Z', limit: 10 },
      ctx(),
    );

    expect(res.isError).toBeFalsy();
    expect(mockApi).toHaveBeenCalledTimes(1);
    const endpoint = mockApi.mock.calls[0][0];
    expect(endpoint).toMatch(new RegExp(`^/api/workspaces/${MOCK_WORKSPACE_ID}/error-traces\\?`));
    expect(endpoint).toMatch(/limit=10/);
    expect(endpoint).toMatch(/since=2026-05-19T00%3A00%3A00Z/);
    const out = res.content[0].text;
    expect(out).toMatch(/git_fatal/);
    expect(out).toMatch(/7×/);
    expect(out).toMatch(/3 task/);
    expect(out).toMatch(/t-1/);
    expect(out.indexOf('git_fatal')).toBeLessThan(out.indexOf('oom'));
  });

  it('workspaceId wins over the worker-context default', async () => {
    mockApi.mockResolvedValueOnce({ patterns: [] });
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { workspaceId: MOCK_WORKSPACE_ID },
      ctx(),
    );
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toMatch(/^\/api\/workspaces\//);
  });

  it('an explicit taskId wins over a habitual workspaceId', async () => {
    mockApi.mockResolvedValueOnce({ traces: [], count: 0 });
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { taskId: 'task-explicit', workspaceId: MOCK_WORKSPACE_ID },
      ctx(),
    );
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toMatch(/^\/api\/tasks\/task-explicit\/error-traces/);
  });

  it('an explicit workerId wins over a habitual workspaceId', async () => {
    mockApi.mockResolvedValueOnce({ traces: [], count: 0 });
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { workerId: 'worker-explicit', workspaceId: MOCK_WORKSPACE_ID },
      ctx(),
    );
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toMatch(/^\/api\/workers\/worker-explicit\/error-traces/);
  });

  it('without a worker context, defaults to the session workspace rollup', async () => {
    mockApi.mockResolvedValueOnce({ patterns: [] });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      {},
      ctx({ workerId: undefined }),
    );
    expect(res.isError).toBeFalsy();
    expect(mockApi.mock.calls[0][0]).toMatch(new RegExp(`^/api/workspaces/${MOCK_WORKSPACE_ID}/error-traces`));
    expect(res.content[0].text).toMatch(/No error traces/);
  });

  it('errors when a workspaceId cannot be resolved', async () => {
    mockApi.mockResolvedValueOnce({ workspaces: [] });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { workspaceId: 'no-such-workspace' },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no-such-workspace/);
  });

  it('passes an 8-char task prefix through to the task route (the server resolves it)', async () => {
    mockApi.mockResolvedValueOnce({ traces: [], count: 0 });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { taskId: 'abcdef12' },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(mockApi.mock.calls[0][0]).toMatch(/^\/api\/tasks\/abcdef12\/error-traces/);
  });

  it('passes through since and limit query params', async () => {
    mockApi.mockResolvedValueOnce({ traces: [], count: 0 });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_error_traces',
      { workerId: 'w1', since: '2026-05-26T00:00:00Z', limit: 25 },
      ctx(),
    );

    const endpoint = mockApi.mock.calls[0][0];
    expect(endpoint).toMatch(/limit=25/);
    expect(endpoint).toMatch(/since=2026-05-26T00%3A00%3A00Z/);
  });
});
