import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '11111111-1111-1111-1111-111111111111';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('get_task', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('throws when taskId is missing', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', {}, ctx()),
    ).rejects.toThrow('taskId is required');
  });

  it('requests the task with include=workers,artifacts by default', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Fix bug',
      status: 'completed',
      priority: 5,
      workspace: { name: 'buildd', repo: 'buildd-ai/buildd' },
      workers: [],
      artifacts: [],
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [endpoint] = mockApi.mock.calls[0];
    const url = new URL(endpoint, 'http://localhost');
    expect(url.pathname).toBe(`/api/tasks/${TASK_ID}`);
    expect(url.searchParams.get('include')).toBe('workers,artifacts');
  });

  it('honors explicit include array', async () => {
    mockApi.mockResolvedValue({ id: TASK_ID, title: 't', status: 'pending' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID, include: ['workers'] },
      ctx(),
    );

    const [endpoint] = mockApi.mock.calls[0];
    const url = new URL(endpoint, 'http://localhost');
    expect(url.searchParams.get('include')).toBe('workers');
  });

  it('formats result with summary, PR, workers, and artifacts', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Add feature X',
      status: 'completed',
      category: 'feature',
      priority: 7,
      description: 'short desc',
      workspace: { name: 'buildd', repo: 'buildd-ai/buildd' },
      mission: { id: 'm1', title: 'Q2 platform', status: 'active' },
      result: {
        summary: 'Shipped feature X behind flag',
        prUrl: 'https://github.com/buildd-ai/buildd/pull/999',
        prNumber: 999,
        branch: 'feat/x',
        sha: 'abcdef1234567890',
        commits: 3,
        files: 4,
        added: 120,
        removed: 5,
      },
      workers: [
        {
          id: 'w-2',
          status: 'completed',
          branch: 'feat/x',
          prUrl: 'https://github.com/buildd-ai/buildd/pull/999',
          prNumber: 999,
          completedAt: '2026-05-24T12:00:00Z',
          lastCommitSha: 'abcdef1234567890',
        },
        {
          id: 'w-1',
          status: 'failed',
          branch: 'feat/x-attempt-1',
          error: 'test failed',
        },
      ],
      artifacts: [
        { id: 'a-1', title: 'Summary', type: 'summary', shareUrl: 'https://buildd.dev/share/abc' },
      ],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).toContain('Add feature X');
    expect(text).toContain('completed');
    expect(text).toContain('[feature]');
    expect(text).toContain('Q2 platform');
    expect(text).toContain('Shipped feature X behind flag');
    expect(text).toContain('pull/999');
    expect(text).toContain('abcdef1'); // short sha
    expect(text).toContain('3 commits');
    expect(text).toContain('Workers (2)');
    expect(text).toContain('w-2');
    expect(text).toContain('w-1');
    expect(text).toContain('test failed');
    expect(text).toContain('Artifacts (1)');
    expect(text).toContain('https://buildd.dev/share/abc');
  });

  it('handles task with no workers or artifacts', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Pending task',
      status: 'pending',
      priority: 3,
      workspace: { name: 'buildd' },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).toContain('Pending task');
    expect(text).toContain('pending');
    expect(text).not.toContain('Workers (');
    expect(text).not.toContain('Artifacts (');
  });
});
