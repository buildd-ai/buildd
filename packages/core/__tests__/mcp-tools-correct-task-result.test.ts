import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('correct_task_result', () => {
  it('requires taskId', async () => {
    const mockApi = mock() as unknown as ApiFn;
    await expect(
      handleBuilddAction(mockApi, 'correct_task_result', { summary: 'fixed' }, ctx()),
    ).rejects.toThrow(/taskId/);
  });

  it('requires a non-empty summary', async () => {
    const mockApi = mock() as unknown as ApiFn;
    await expect(
      handleBuilddAction(mockApi, 'correct_task_result', { taskId: TASK_ID, summary: '   ' }, ctx()),
    ).rejects.toThrow(/summary/);
  });

  it('PATCHes the task with resultSummary and a correctedBy stamp', async () => {
    const mockApi = mock(async () => ({
      id: TASK_ID,
      title: 'Fix the thing',
      result: {
        summary: 'Corrected summary',
        previousSummary: 'stray aside',
        summaryCorrectedAt: '2026-09-10T00:00:00.000Z',
      },
    })) as unknown as ApiFn;

    const result = await handleBuilddAction(
      mockApi,
      'correct_task_result',
      { taskId: TASK_ID, summary: 'Corrected summary' },
      ctx(),
    );

    const [endpoint, opts] = (mockApi as ReturnType<typeof mock>).mock.calls[0];
    expect(endpoint).toBe(`/api/tasks/${TASK_ID}`);
    expect(opts.method).toBe('PATCH');
    const body = JSON.parse(opts.body);
    expect(body.resultSummary).toBe('Corrected summary');
    expect(body.correctedBy).toBe('admin_token');

    expect(result.content[0].text).toContain('Corrected summary');
    expect(result.content[0].text).toContain('stray aside');
  });

  it('stamps correctedBy with the caller worker id when present', async () => {
    const mockApi = mock(async () => ({
      id: TASK_ID,
      title: 'Fix the thing',
      result: { summary: 'Corrected summary' },
    })) as unknown as ApiFn;

    await handleBuilddAction(
      mockApi,
      'correct_task_result',
      { taskId: TASK_ID, summary: 'Corrected summary' },
      ctx({ workerId: WORKER_ID }),
    );

    const [, opts] = (mockApi as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.correctedBy).toBe(`worker:${WORKER_ID}`);
  });
});
