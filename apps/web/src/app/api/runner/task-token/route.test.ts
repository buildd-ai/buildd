import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock((_key: string | null) => Promise.resolve(null as any));
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
import { verifyTaskToken } from '@/lib/task-token';

const savedSecret = process.env.AUTH_SECRET;
afterAll(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = { id: 'acct-1', teamId: 'team-1', level: 'worker' };

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
    expect(verifyTaskToken(data.token)).toMatchObject({ accountId: 'acct-1', taskId: TASK_ID });
    expect(mockVerifyAccess).toHaveBeenCalledWith('acct-1', WORKSPACE_ID, 'canClaim');
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
