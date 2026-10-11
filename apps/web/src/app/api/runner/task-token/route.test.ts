import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock((_key: string | null, _req?: unknown) => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockVerifyAccess = mock((_a: string, _w: string, _p?: string) => Promise.resolve(true));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyAccountWorkspaceAccess: mockVerifyAccess }));
mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findFirst: mockTasksFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));

import { POST } from './route';
import { verifyTaskToken, taskTokenKeyBinding } from '@/lib/task-token';

const savedSecret = process.env.AUTH_SECRET;
afterAll(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = { id: 'acct-1', teamId: 'team-1', level: 'worker', apiKey: 'hash-1' };

function req(body: Record<string, unknown>, key = 'bld_dispatcher'): NextRequest {
  return new NextRequest('http://localhost/api/runner/task-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

describe('POST /api/runner/task-token', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-secret';
    mockAuthenticateApiKey.mockReset();
    mockTasksFindFirst.mockReset();
    mockVerifyAccess.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: WORKSPACE_ID });
    mockVerifyAccess.mockResolvedValue(true);
  });

  it('mints a token bound to the caller and the task', async () => {
    const res = await POST(req({ taskId: TASK_ID }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token.startsWith('bldt_')).toBe(true);
    expect(verifyTaskToken(data.token)).toMatchObject({
      accountId: 'acct-1', taskId: TASK_ID, workspaceId: WORKSPACE_ID, keyBinding: taskTokenKeyBinding('hash-1'),
    });
    expect(mockVerifyAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'acct-1' }), WORKSPACE_ID, 'canClaim');
  });

  it('echoes the stored role and ignores caller-provided browser authority', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: WORKSPACE_ID, roleSlug: 'builder' });
    expect(await (await POST(req({ taskId: TASK_ID, roleSlug: 'visual-auditor' }))).json()).toMatchObject({ roleSlug: 'builder' });
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: WORKSPACE_ID, roleSlug: 'visual-auditor' });
    expect(await (await POST(req({ taskId: TASK_ID }))).json()).toMatchObject({ roleSlug: 'visual-auditor' });
  });

  it('passes the request to auth, so a capability-scoped runner key is checked rather than refused', async () => {
    // authenticateApiKey returns null for any key with scopes when it gets no
    // request to check them against; the cloud runner's dispatcher key is
    // typically such a key.
    const r = req({ taskId: TASK_ID });
    await POST(r);
    expect(mockAuthenticateApiKey).toHaveBeenCalledWith('bld_dispatcher', r);
  });

  it('answers 404 when a workspace-restricted key does not list the task\'s workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, workspaceIds: ['33333333-3333-4333-8333-333333333333'] });
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(404);
  });

  it('mints for a workspace-restricted key that lists the task\'s workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, workspaceIds: [WORKSPACE_ID] });
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(200);
  });

  it('mints for a scoped key with the runner capabilities', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, scopes: ['tasks:read', 'tasks:write', 'workers:write', 'analytics:read', 'knowledge:write'], workspaceIds: null });
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(200);
  });

  it('refuses, with a reason, a scoped key below the runner capabilities instead of minting a token that cannot authenticate', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, scopes: ['tasks:read', 'workers:write'], workspaceIds: null });
    const res = await POST(req({ taskId: TASK_ID }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('knowledge:write');
  });

  it('returns 401 without a valid account key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(401);
  });

  it('refuses a trigger key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(403);
  });

  it('answers 404 for a task the caller cannot claim', async () => {
    mockVerifyAccess.mockResolvedValue(false);
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(404);
  });

  it('answers 404 for a missing task and 400 for a malformed id', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(404);
    expect((await POST(req({ taskId: 'nope' }))).status).toBe(400);
  });

  it('fails closed with no signing secret', async () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    expect((await POST(req({ taskId: TASK_ID }))).status).toBe(503);
  });
});

describe('POST /api/runner/task-token — admin level', () => {
  const ADMIN = { ...ACCOUNT, level: 'admin', scopes: null };
  const ORG_TASK = {
    id: TASK_ID, workspaceId: WORKSPACE_ID, roleSlug: 'organizer', mode: 'execution', context: {},
    workspace: { name: 'app', repo: 'https://github.com/example/app', githubRepoId: null },
  };
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-secret';
    mockAuthenticateApiKey.mockReset();
    mockTasksFindFirst.mockReset();
    mockVerifyAccess.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(ADMIN);
    mockTasksFindFirst.mockResolvedValue(ORG_TASK);
    mockVerifyAccess.mockResolvedValue(true);
  });

  it('mints an admin token for an orchestration task with an admin key, and says so', async () => {
    const res = await POST(req({ taskId: TASK_ID, level: 'admin' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.level).toBe('admin');
    expect(verifyTaskToken(data.token)?.level).toBe('admin');
  });

  it.each([
    ['a planning task', { roleSlug: 'builder', mode: 'planning', context: {} }],
    ['a heartbeat', { roleSlug: 'builder', mode: 'execution', context: { heartbeat: true } }],
  ])('mints one for %s', async (_label, row) => {
    mockTasksFindFirst.mockResolvedValue({ ...ORG_TASK, ...row });
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(200);
  });

  it('mints one for a scoped key with the full admin scope', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'admin', scopes: ['admin'], workspaceIds: null });
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(200);
  });

  it('defaults to worker, and an admin key asking for nothing gets a worker token', async () => {
    const data = await (await POST(req({ taskId: TASK_ID }))).json();
    expect(data.level).toBe('worker');
    expect(verifyTaskToken(data.token)?.level).toBe('worker');
  });

  it('refuses a worker-level key with a reason, before reading the task', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const res = await POST(req({ taskId: TASK_ID, level: 'admin' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('admin key');
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });

  it('refuses a scoped key with only some admin capabilities', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      ...ACCOUNT, level: 'worker', workspaceIds: null,
      scopes: ['tasks:read', 'tasks:write', 'workers:write', 'analytics:read', 'knowledge:write', 'missions:admin', 'tasks:admin', 'workers:admin'],
    });
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(403);
  });

  it('refuses a task that is not an orchestration task, judged from the row and never the request', async () => {
    mockTasksFindFirst.mockResolvedValue({ ...ORG_TASK, roleSlug: 'builder', mode: 'execution', context: {} });
    const res = await POST(req({ taskId: TASK_ID, level: 'admin', roleSlug: 'organizer', mode: 'planning', context: { heartbeat: true } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('orchestration task');
  });

  it('refuses an orchestration task in a coordination workspace or one with no repo', async () => {
    mockTasksFindFirst.mockResolvedValue({ ...ORG_TASK, workspace: { name: '__coordination', repo: null, githubRepoId: null } });
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(403);
    mockTasksFindFirst.mockResolvedValue({ ...ORG_TASK, workspace: { name: 'notes', repo: null, githubRepoId: null } });
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(403);
    mockTasksFindFirst.mockResolvedValue({ ...ORG_TASK, workspace: { name: 'app', repo: null, githubRepoId: 'gh-1' } });
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(200);
  });

  it('never mints admin for a task the key could not claim', async () => {
    mockVerifyAccess.mockResolvedValue(false);
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(404);
    mockVerifyAccess.mockResolvedValue(true);
    mockAuthenticateApiKey.mockResolvedValue({ ...ADMIN, workspaceIds: ['33333333-3333-4333-8333-333333333333'] });
    expect((await POST(req({ taskId: TASK_ID, level: 'admin' }))).status).toBe(404);
  });

  it('rejects an unknown level', async () => {
    expect((await POST(req({ taskId: TASK_ID, level: 'owner' }))).status).toBe(400);
  });
});
