import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ActionContext, type ApiFn } from '../mcp-tools';

/**
 * A session reserves a dependency-blocked task so runners skip it, and
 * claim_task waitSeconds holds the call until the last dependency clears.
 * create_task claim:true files the task already reserved and claims it in the
 * same call.
 */

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const WS_ID = '00000000-0000-0000-0000-000000000001';
const sleeps: number[] = [];
const ctx: ActionContext = {
  workspaceId: WS_ID,
  getWorkspaceId: async () => WS_ID,
  getLevel: async () => 'worker',
  sleep: async (ms: number) => { sleeps.push(ms); },
};
const run = (api: unknown, action: string, params: Record<string, unknown>) =>
  handleBuilddAction(api as ApiFn, action, params, ctx);
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

const blocked = { workers: [], diagnostics: { reason: 'task_excluded', taskExclusion: { code: 'deps_blocked', detail: 'Waiting on another task.' } } };
const claimed = { workers: [{ id: 'w-1', branch: 'buildd/x', task: { id: TASK_ID, title: 'T', description: 'd', status: 'assigned', workspaceId: WS_ID } }] };

describe('update_task reserve', () => {
  it('sends reserved on its own: true reserves, false releases', async () => {
    const api = mock(() => Promise.resolve({ id: TASK_ID }));
    const out = await run(api, 'update_task', { taskId: TASK_ID, reserve: true });
    expect((api.mock.calls[0] as unknown[])[0]).toBe(`/api/tasks/${TASK_ID}`);
    expect(bodyOf(api.mock.calls[0] as unknown[])).toEqual({ reserved: true });
    expect(JSON.stringify(out)).toMatch(/runners will skip/);
    await run(api, 'update_task', { taskId: TASK_ID, reserve: false });
    expect(bodyOf(api.mock.calls[1] as unknown[])).toEqual({ reserved: false });
  });

  it('refuses reserve mixed with other edits, or a non-boolean', async () => {
    const api = mock(() => Promise.resolve({}));
    await expect(run(api, 'update_task', { taskId: TASK_ID, reserve: true, status: 'cancelled' })).rejects.toThrow(/on its own/);
    await expect(run(api, 'update_task', { taskId: TASK_ID, reserve: 'yes' })).rejects.toThrow(/reserve must be true or false/);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('claim_task waitSeconds', () => {
  it('reserves, then keeps trying while the only blocker is a dependency, renewing the reservation each poll', async () => {
    sleeps.length = 0;
    const calls: string[] = [];
    let claims = 0;
    const api = mock((path: string, init?: { body: string }) => {
      calls.push(`${path}${init?.body && path.startsWith('/api/tasks') ? ` ${init.body}` : ''}`);
      if (path === '/api/workers/claim') return Promise.resolve(++claims < 3 ? blocked : claimed);
      return Promise.resolve({ id: TASK_ID });
    });
    const out = await run(api, 'claim_task', { taskId: TASK_ID, waitSeconds: 30 });
    expect(JSON.stringify(out)).toMatch(/Claimed 1 task/);
    expect(calls[0]).toBe(`/api/tasks/${TASK_ID} {"reserved":true}`);
    expect(claims).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(calls.filter(c => c.includes('"reserved":true')).length).toBe(3);
  });

  it('gives up with the server reason once the wait is spent, leaving the reservation to lapse or be renewed', async () => {
    sleeps.length = 0;
    const api = mock((path: string) => Promise.resolve(path === '/api/workers/claim' ? blocked : { id: TASK_ID }));
    const out = await run(api, 'claim_task', { taskId: TASK_ID, waitSeconds: 6 });
    expect(JSON.stringify(out)).toMatch(/Nothing claimed/);
    expect(JSON.stringify(out)).toMatch(/still reserved/);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6000);
  });

  it('stops at once on a blocker that waiting will not clear, and without waitSeconds behaves as before', async () => {
    sleeps.length = 0;
    const held = { workers: [], diagnostics: { reason: 'task_excluded', taskExclusion: { code: 'task_held', detail: 'held' } } };
    const api = mock((path: string) => Promise.resolve(path === '/api/workers/claim' ? held : { id: TASK_ID }));
    const out = await run(api, 'claim_task', { taskId: TASK_ID, waitSeconds: 30 });
    expect(JSON.stringify(out)).toMatch(/Nothing claimed/);
    expect(sleeps.length).toBe(0);

    const plain = mock(() => Promise.resolve(blocked));
    await run(plain, 'claim_task', { taskId: TASK_ID });
    expect(plain.mock.calls.length).toBe(1);
  });

  it('needs a taskId, and clamps to 45 seconds', async () => {
    const api = mock(() => Promise.resolve(blocked));
    await expect(run(api, 'claim_task', { waitSeconds: 10 })).rejects.toThrow(/waitSeconds needs a taskId/);
    expect(buildParamsDescription(['claim_task', 'update_task', 'create_task'])).toMatch(/waitSeconds[\s\S]*reserve\?[\s\S]*claim\?/);
  });
});

describe('create_task claim', () => {
  it('files the task already reserved, then claims it by id in the same call', async () => {
    const calls: Array<{ path: string; body?: any }> = [];
    const api = mock((path: string, init?: { body: string }) => {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
      if (path === '/api/tasks') return Promise.resolve({ id: TASK_ID, title: 'T', priority: 5, status: 'pending', workspaceId: WS_ID });
      if (path === '/api/workers/claim') return Promise.resolve(claimed);
      return Promise.resolve({});
    });
    const out = await run(api, 'create_task', { title: 'T', description: 'd', kind: 'engineering', claim: true });
    const create = calls.find(c => c.path === '/api/tasks' && c.body);
    expect(create?.body.reserve).toBe(true);
    expect(create?.body.claim).toBeUndefined();
    const claim = calls.find(c => c.path === '/api/workers/claim');
    expect(claim?.body.taskId).toBe(TASK_ID);
    expect(JSON.stringify(out)).toMatch(/Task created/);
    expect(JSON.stringify(out)).toMatch(/Claimed 1 task/);
  });

  it('does not reserve or claim without claim: true', async () => {
    const calls: string[] = [];
    const api = mock((path: string, init?: { body: string }) => {
      calls.push(path);
      if (path === '/api/tasks' && init?.body) { expect(JSON.parse(init.body).reserve).toBeUndefined(); return Promise.resolve({ id: TASK_ID, title: 'T', priority: 5, status: 'pending', workspaceId: WS_ID }); }
      return Promise.resolve({});
    });
    await run(api, 'create_task', { title: 'T', description: 'd', kind: 'engineering' });
    expect(calls).not.toContain('/api/workers/claim');
  });
});
