import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const WORKER_ID = 'worker-wait-1';
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const BLOCKER = '22222222-2222-2222-2222-222222222222';

const context: ActionContext = {
  workerId: WORKER_ID,
  workspaceId: 'workspace-1',
  getWorkspaceId: async () => 'workspace-1',
  getLevel: async () => 'worker',
  authType: 'api',
};

type Call = [string, { method?: string; body?: string } | undefined];

function fakeApi(patchTask: () => unknown) {
  return mock(async (path: string, init?: { method?: string }) => {
    if (path === `/api/workers/${WORKER_ID}` && !init?.method) return { id: WORKER_ID, taskId: TASK_ID, status: 'running' };
    if (path === `/api/tasks/${TASK_ID}` && init?.method === 'PATCH') return patchTask();
    throw new Error(`unexpected call ${init?.method ?? 'GET'} ${path}`);
  });
}

describe('MCP complete_task { blockedOnTaskId } — the wait exit', () => {
  it('moves the task to wait on the blocker instead of completing or failing the worker', async () => {
    const api = fakeApi(() => ({ id: TASK_ID, status: 'pending', waitingOn: { id: BLOCKER, title: 'Runner image credentials' } }));
    const result = await handleBuilddAction(api as unknown as ApiFn, 'complete_task',
      { blockedOnTaskId: BLOCKER, summary: 'Needs the registry credentials that task sets up' }, context);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Waiting on "Runner image credentials"');
    const calls = api.mock.calls as unknown as Call[];
    const patch = calls.find(c => c[1]?.method === 'PATCH');
    expect(patch?.[0]).toBe(`/api/tasks/${TASK_ID}`);
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      waitOn: { taskId: BLOCKER, reason: 'Needs the registry credentials that task sets up', workerId: WORKER_ID },
    });
    // Never the worker completion or failure path.
    expect(calls.some(c => c[0] === `/api/workers/${WORKER_ID}` && c[1]?.method === 'PATCH')).toBe(false);
  });

  it('says why the server refused, so the agent can fail or ask instead', async () => {
    const api = fakeApi(() => { throw new Error('API error: 409 - {"error":"\\"Runner image credentials\\" has already merged.","code":"blocker_merged"}'); });
    const result = await handleBuilddAction(api as unknown as ApiFn, 'complete_task',
      { blockedOnTaskId: BLOCKER, summary: 'needs it' }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('has already merged');
  });

  it('needs a summary and refuses error alongside it', async () => {
    const api = fakeApi(() => ({}));
    const noSummary = await handleBuilddAction(api as unknown as ApiFn, 'complete_task', { blockedOnTaskId: BLOCKER }, context);
    expect(noSummary.isError).toBe(true);
    const both = await handleBuilddAction(api as unknown as ApiFn, 'complete_task', { blockedOnTaskId: BLOCKER, summary: 's', error: 'e' }, context);
    expect(both.isError).toBe(true);
    expect((api.mock.calls as unknown as Call[]).some(c => c[1]?.method === 'PATCH')).toBe(false);
  });
});
