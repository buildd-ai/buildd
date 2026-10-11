import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async () => ({ id: 'user-1' }) as any);
const mockResolveOpenWorkerForUser = mock(async (..._a: unknown[]) => ({ workspaceId: 'ws-1', lastCommitSha: 'head-1' }) as any);
const mockVerify = mock((_t: unknown) => ({ ok: true, payload: { workspaceId: 'ws-1', prNumber: 7, headSha: 'head-1', taskId: 'task-1', facts: {}, exp: 0 } }) as any);
const mockAsk = mock(async (_i: unknown) => ({ kind: 'answer', reused: false, advice: { decision: 'wait', source: 'rule', line: 'Wait: CI is still running.', at: 'x', stale: null } }) as any);
const mockWorkspaceFindFirst = mock(async () => ({ teamId: 'team-1' }) as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolveOpenWorkerForUser }));
mock.module('@/lib/merge-advice-server', () => ({ verifyMergeAdviceToken: mockVerify }));
mock.module('@/lib/merge-readiness-decision', () => ({ askMergeReadiness: mockAsk }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: mockWorkspaceFindFirst } } } }));
mock.module('@buildd/core/db/schema', () => ({ workspaces: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }));

import { POST } from './route';

const post = (body: unknown, pr = '7') =>
  POST(new NextRequest(`http://localhost/api/prs/${pr}/merge-readiness`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ prNumber: pr }) });

beforeEach(() => {
  for (const m of [mockGetCurrentUser, mockResolveOpenWorkerForUser, mockVerify, mockAsk, mockWorkspaceFindFirst]) m.mockClear();
});

describe('POST /api/prs/[prNumber]/merge-readiness', () => {
  it('401 without a session', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    expect((await post({ workspaceId: 'ws-1', token: 't' })).status).toBe(401);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('400 on a bad PR number, a missing workspace or a token that does not verify', async () => {
    expect((await post({ workspaceId: 'ws-1', token: 't' }, 'abc')).status).toBe(400);
    expect((await post({ token: 't' })).status).toBe(400);
    mockVerify.mockReturnValueOnce({ ok: false, reason: 'bad_signature' });
    const res = await post({ workspaceId: 'ws-1', token: 'forged' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_signature');
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('400 when the token was signed for another PR or workspace', async () => {
    expect((await post({ workspaceId: 'ws-1', token: 't' }, '8')).status).toBe(400);
    expect((await post({ workspaceId: 'ws-2', token: 't' })).status).toBe(400);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('passes through the access check', async () => {
    mockResolveOpenWorkerForUser.mockResolvedValueOnce({ error: 'Workspace "ws-1" not found or not accessible', status: 403 });
    expect((await post({ workspaceId: 'ws-1', token: 't' })).status).toBe(403);
    expect(mockResolveOpenWorkerForUser).toHaveBeenCalledWith('user-1', 7, 'ws-1');
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('409 head_moved when the PR has new commits since the card was built', async () => {
    mockResolveOpenWorkerForUser.mockResolvedValueOnce({ workspaceId: 'ws-1', lastCommitSha: 'head-2' });
    const res = await post({ workspaceId: 'ws-1', token: 't' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('head_moved');
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('asks for the signed facts as the workspace team and returns the answer', async () => {
    const res = await post({ workspaceId: 'ws-1', token: 't' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'answer', advice: { line: 'Wait: CI is still running.' } });
    expect(mockAsk).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1', userId: 'user-1', payload: expect.objectContaining({ headSha: 'head-1' }) }));
  });
});
