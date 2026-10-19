import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const HOME = '00000000-0000-0000-0000-000000000001';
const SCHEDULE = '00000000-0000-0000-0000-000000000002';

const context = (): ActionContext => ({
  workerId: 'worker-1',
  workspaceId: HOME,
  getWorkspaceId: async () => HOME,
  getLevel: async () => 'worker',
});

describe('propose_schedule_move', () => {
  it('posts the proposal to the schedule the task came from and says nothing changed', async () => {
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/worker-1') return { workspaceId: HOME, task: { context: { scheduleId: SCHEDULE } } };
      return { proposal: { id: 'p1' } };
    });
    const res = await handleBuilddAction(api as unknown as ApiFn, 'propose_schedule_move', { workspace: 'acme/data', reason: 'reads come back FORBIDDEN' }, context());
    const post = (api.mock.calls as unknown as Array<[string, { method?: string; body?: string }]>).find(([e]) => e.endsWith('/move-proposal'))!;
    expect(post[0]).toBe(`/api/workspaces/${HOME}/schedules/${SCHEDULE}/move-proposal`);
    expect(post[1].method).toBe('POST');
    expect(JSON.parse(post[1].body!)).toEqual({ workspace: 'acme/data', reason: 'reads come back FORBIDDEN' });
    expect(JSON.stringify(res)).toContain('Nothing has changed');
  });

  it('refuses a task no schedule spawned before calling the server', async () => {
    const api = mock(async () => ({ workspaceId: HOME, task: { context: {} } }));
    await expect(handleBuilddAction(api as unknown as ApiFn, 'propose_schedule_move', { workspace: 'x', reason: 'y' }, context()))
      .rejects.toThrow(/not spawned by a schedule/);
  });

  it('requires workspace and reason', async () => {
    const api = mock(async () => ({}));
    await expect(handleBuilddAction(api as unknown as ApiFn, 'propose_schedule_move', { reason: 'y' }, context())).rejects.toThrow();
    await expect(handleBuilddAction(api as unknown as ApiFn, 'propose_schedule_move', { workspace: 'x' }, context())).rejects.toThrow();
  });
});
