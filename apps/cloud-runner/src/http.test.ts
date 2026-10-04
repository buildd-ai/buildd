import { describe, expect, test } from 'bun:test';
import { handleRequest, timingSafeEqualString, type AgentHandle, type DispatcherEnv } from './http';
import { INITIAL_STATE, type RunState } from './lifecycle';
import type { DispatchResult } from './supervisor';

const TOKEN = 'dispatch-token-for-tests';
const ENV: DispatcherEnv = { DISPATCH_TOKEN: TOKEN, BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_API_KEY: 'bld_test' };
const TASK_ID = '0f1e2d3c-aaaa-bbbb-cccc-000011112222';

/** A stub namespace: one fake agent per name, recording calls. */
function stubAgents() {
  const byName = new Map<string, { dispatches: number; state: RunState; requests: unknown[]; kills?: number }>();
  const lookups: string[] = [];
  const get = async (name: string): Promise<AgentHandle> => {
    lookups.push(name);
    let a = byName.get(name);
    if (!a) { a = { dispatches: 0, state: { ...INITIAL_STATE }, requests: [] }; byName.set(name, a); }
    const agent = a;
    return {
      async dispatch(request?: unknown): Promise<DispatchResult> {
        agent.dispatches++;
        agent.requests.push(request);
        if (agent.state.status === 'running') return { accepted: false, reason: 'already_live', attempt: agent.state.attempt, status: 'running' };
        agent.state = { ...agent.state, taskId: name, status: 'running', attempt: agent.state.attempt + 1 };
        return { accepted: true, attempt: agent.state.attempt };
      },
      async getRunState() { return agent.state; },
      async killContainer() { agent.kills = (agent.kills ?? 0) + 1; return { killed: agent.state.status === 'running' }; },
    };
  };
  return { get, byName, lookups };
}

function post(body: unknown, auth: string | null = `Bearer ${TOKEN}`, raw?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== null) headers.Authorization = auth;
  return new Request('https://dispatcher.example/dispatch', { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
}

const payload = {
  message: 'Work on Buildd task: x', sessionKey: `buildd-${TASK_ID}`, name: 'buildd',
  event: 'task_created', taskId: TASK_ID, workspaceId: 'ws-1', missionId: null, backend: null, roleSlug: null,
};

describe('auth', () => {
  test.each([
    ['no header', null],
    ['wrong token', 'Bearer not-the-token'],
    ['prefix of the token', `Bearer ${TOKEN.slice(0, -1)}`],
    ['token plus suffix', `Bearer ${TOKEN}x`],
    ['not bearer', `Basic ${TOKEN}`],
  ])('%s -> 401 and no agent is touched', async (_label, auth) => {
    const agents = stubAgents();
    const res = await handleRequest(post(payload, auth), ENV, agents.get);
    expect(res.status).toBe(401);
    expect(agents.lookups).toHaveLength(0);
  });

  test('GET /tasks/:id needs the token too', async () => {
    const agents = stubAgents();
    const res = await handleRequest(new Request(`https://d.example/tasks/${TASK_ID}`), ENV, agents.get);
    expect(res.status).toBe(401);
    expect(agents.lookups).toHaveLength(0);
  });

  test('an unconfigured dispatcher fails closed', async () => {
    for (const missing of ['DISPATCH_TOKEN', 'BUILDD_SERVER', 'BUILDD_API_KEY'] as const) {
      const agents = stubAgents();
      const env = { ...ENV, [missing]: undefined };
      const res = await handleRequest(post(payload), env, agents.get);
      expect(res.status).toBe(500);
      expect(agents.lookups).toHaveLength(0);
    }
  });

  test('timingSafeEqualString', async () => {
    expect(await timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(await timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(await timingSafeEqualString('abc', 'abcd')).toBe(false);
    expect(await timingSafeEqualString('', '')).toBe(true);
  });
});

describe('POST /dispatch', () => {
  test('routes to the agent named by taskId and returns 202', async () => {
    const agents = stubAgents();
    const res = await handleRequest(post(payload), ENV, agents.get);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ taskId: TASK_ID, accepted: true, attempt: 1 });
    expect(agents.lookups).toEqual([TASK_ID]);
  });

  test('a duplicate webhook reaches the same agent, is a no-op, and still gets 202', async () => {
    const agents = stubAgents();
    await handleRequest(post(payload), ENV, agents.get);
    const res = await handleRequest(post(payload), ENV, agents.get);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: false, reason: 'already_live', attempt: 1 });
    expect(agents.byName.size).toBe(1);
  });

  test('task.resume carries the worker to continue to the task agent', async () => {
    const agents = stubAgents();
    const res = await handleRequest(post({ ...payload, event: 'task.resume', workerId: 'worker-9' }), ENV, agents.get);
    expect(res.status).toBe(202);
    expect(agents.byName.get(TASK_ID)!.requests).toEqual([{ resumeWorkerId: 'worker-9' }]);
  });

  test('any other event is a plain dispatch, whatever workerId it carries', async () => {
    const agents = stubAgents();
    await handleRequest(post({ ...payload, event: 'task.retry', workerId: 'worker-9' }), ENV, agents.get);
    expect(agents.byName.get(TASK_ID)!.requests).toEqual([{}]);
  });

  test.each([
    ['no workerId', { event: 'task.resume' }],
    ['a path-like workerId', { event: 'task.resume', workerId: '../w' }],
    ['a numeric workerId', { event: 'task.resume', workerId: 7 }],
  ])('task.resume with %s -> 400', async (_label, extra) => {
    const agents = stubAgents();
    const res = await handleRequest(post({ ...payload, ...extra }), ENV, agents.get);
    expect(res.status).toBe(400);
    expect(agents.lookups).toHaveLength(0);
  });

  test.each([
    ['invalid JSON', undefined, '{not json'],
    ['no taskId', { event: 'task_created' }, undefined],
    ['numeric taskId', { taskId: 42 }, undefined],
    ['flag-like taskId', { taskId: '--help' }, undefined],
    ['path-like taskId', { taskId: '../x' }, undefined],
    ['null body', null, undefined],
  ])('%s -> 400', async (_label, body, raw) => {
    const agents = stubAgents();
    const res = await handleRequest(post(body, `Bearer ${TOKEN}`, raw), ENV, agents.get);
    expect(res.status).toBe(400);
    expect(agents.lookups).toHaveLength(0);
  });

  test('an oversized body is rejected', async () => {
    const agents = stubAgents();
    const res = await handleRequest(post({ taskId: TASK_ID, pad: 'x'.repeat(70_000) }), ENV, agents.get);
    expect(res.status).toBe(413);
  });

  test('GET /dispatch is not allowed', async () => {
    const agents = stubAgents();
    const res = await handleRequest(new Request('https://d.example/dispatch', { headers: { Authorization: `Bearer ${TOKEN}` } }), ENV, agents.get);
    expect(res.status).toBe(405);
  });
});

describe('GET /tasks/:taskId', () => {
  test('returns the agent state', async () => {
    const agents = stubAgents();
    await handleRequest(post(payload), ENV, agents.get);
    const res = await handleRequest(new Request(`https://d.example/tasks/${TASK_ID}`, { headers: { Authorization: `Bearer ${TOKEN}` } }), ENV, agents.get);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ taskId: TASK_ID, status: 'running', attempt: 1 });
  });

  test('rejects a bad id', async () => {
    const agents = stubAgents();
    const res = await handleRequest(new Request('https://d.example/tasks/%E0%A4%A', { headers: { Authorization: `Bearer ${TOKEN}` } }), ENV, agents.get);
    expect(res.status).toBe(400);
  });

  test('unknown paths are 404', async () => {
    const agents = stubAgents();
    const res = await handleRequest(new Request('https://d.example/', { headers: { Authorization: `Bearer ${TOKEN}` } }), ENV, agents.get);
    expect(res.status).toBe(404);
  });
});

describe('POST /tasks/:id/kill (debug; recovery testing on a real account)', () => {
  const kill = (auth: string | null = `Bearer ${TOKEN}`, method = 'POST', id = TASK_ID) =>
    new Request(`https://d.example/tasks/${id}/kill`, { method, headers: auth ? { Authorization: auth } : {} });
  const ON = { ...ENV, ALLOW_DEBUG_KILL: '1' };

  test('off unless ALLOW_DEBUG_KILL=1: 404, and no agent is touched', async () => {
    const agents = stubAgents();
    for (const env of [ENV, { ...ENV, ALLOW_DEBUG_KILL: 'true' }, { ...ENV, ALLOW_DEBUG_KILL: '0' }]) {
      expect((await handleRequest(kill(), env, agents.get)).status).toBe(404);
    }
    expect(agents.lookups).toHaveLength(0);
  });

  test('needs the dispatch token', async () => {
    const agents = stubAgents();
    expect((await handleRequest(kill(null), ON, agents.get)).status).toBe(401);
    expect((await handleRequest(kill('Bearer nope'), ON, agents.get)).status).toBe(401);
    expect(agents.lookups).toHaveLength(0);
  });

  test('POST only, valid task id only', async () => {
    const agents = stubAgents();
    expect((await handleRequest(kill(undefined, 'GET'), ON, agents.get)).status).toBe(405);
    expect((await handleRequest(kill(undefined, 'POST', '..%2Fx'), ON, agents.get)).status).toBe(400);
  });

  test("destroys the task's container and says whether a run was live", async () => {
    const agents = stubAgents();
    await handleRequest(post(payload), ON, agents.get);
    const res = await handleRequest(kill(), ON, agents.get);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskId: TASK_ID, killed: true });
    expect(agents.byName.get(TASK_ID)!.kills).toBe(1);
  });
});
