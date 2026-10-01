import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { TOKEN_PRESETS } from '@buildd/core/token-scopes';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(true as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockResolveRepo = mock(() => Promise.resolve({ fullName: 'acme/widgets', installationId: 42 } as any));
const mockAttach = mock(() => Promise.resolve({} as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findFirst: mockTasksFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: any, v: any) => ({ f, v }) }));

// Keep the real parser — it is pure — and stub only the DB/GitHub-touching parts.
const real = await import('@/lib/task-pr-attach');
mock.module('@/lib/task-pr-attach', () => ({
  parsePrReference: real.parsePrReference,
  resolveWorkspaceGithubRepo: mockResolveRepo,
  attachPrToTask: mockAttach,
}));

import { POST } from './route';

function call(body: unknown, id = TASK_ID) {
  const req = new NextRequest(`http://localhost/api/tasks/${id}/attach-pr`, {
    method: 'POST',
    headers: { authorization: 'Bearer bld_test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

const completedTask = {
  id: TASK_ID,
  workspaceId: 'ws-1',
  status: 'completed',
  result: null,
  workspace: { id: 'ws-1', githubRepoId: 'r', githubInstallationId: 'i' },
};

describe('POST /api/tasks/[id]/attach-pr', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin' });
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue(completedTask);
    mockResolveRepo.mockReset();
    mockResolveRepo.mockResolvedValue({ fullName: 'acme/widgets', installationId: 42 });
    mockAttach.mockReset();
    mockAttach.mockResolvedValue({
      ok: true, alreadyAttached: false, workerId: 'w-1', prNumber: 17,
      prUrl: 'https://github.com/acme/widgets/pull/17', prState: 'merged', result: { prNumber: 17 },
    });
  });

  it('attaches a PR by URL to a task closed without a worker', async () => {
    const res = await call({ prUrl: 'https://github.com/acme/widgets/pull/17' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, workerId: 'w-1', prNumber: 17, prState: 'merged' });
    const args = (mockAttach.mock.calls[0] as any[])[0];
    expect(args).toMatchObject({ prNumber: 17, accountId: 'acct-1', repo: { fullName: 'acme/widgets' } });
    expect(args.task.id).toBe(TASK_ID);
  });

  it('requires an admin-level token', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'worker' });
    const res = await call({ prNumber: 17 });
    expect(res.status).toBe(403);
    expect(mockAttach).not.toHaveBeenCalled();
  });

  for (const preset of ['ci', 'runner'] as const) {
    it(`refuses a scoped ${preset} preset token: attaching a PR needs tasks:admin`, async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin', scopes: TOKEN_PRESETS[preset].scopes, workspaceIds: null });
      const res = await call({ prNumber: 17 });
      expect(res.status).toBe(403);
      expect(mockAttach).not.toHaveBeenCalled();
    });
  }

  it('refuses a task that has not finished', async () => {
    mockTasksFindFirst.mockResolvedValue({ ...completedTask, status: 'in_progress' });
    const res = await call({ prNumber: 17 });
    expect(res.status).toBe(400);
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it('refuses a workspace with no linked GitHub repo', async () => {
    mockResolveRepo.mockResolvedValue(null);
    const res = await call({ prNumber: 17 });
    expect(res.status).toBe(400);
  });

  it('refuses a PR URL from another repo before touching GitHub', async () => {
    const res = await call({ prUrl: 'https://github.com/other/repo/pull/17' });
    expect(res.status).toBe(400);
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it('passes an attach refusal through with its status', async () => {
    mockAttach.mockResolvedValue({ ok: false, status: 404, error: 'PR #17 not found' });
    const res = await call({ prNumber: 17 });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('not found');
  });

  it('404s a task the caller cannot reach', async () => {
    mockVerifyAccountWorkspaceAccess.mockResolvedValueOnce(false);
    const res = await call({ prNumber: 17 });
    expect(res.status).toBe(404);
  });

  it('rejects an ID prefix', async () => {
    const res = await call({ prNumber: 17 }, '11111111');
    expect(res.status).toBe(400);
  });
});
