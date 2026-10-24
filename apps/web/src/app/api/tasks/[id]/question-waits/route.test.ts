import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async () => ({ id: 'user-1' }) as any);
const mockTasksFindFirst = mock(async () => null as any);
const mockVerifyWorkspaceAccess = mock(async () => ({ teamId: 'team-1' }) as any);
const mockLoad = mock(async (_i: any) => ({ taskId: 't1', waiting: [] }) as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess, verifyAccountWorkspaceAccess: async () => true }));
mock.module('@/lib/question-waits', () => ({ loadQuestionWaits: mockLoad }));
mock.module('@/lib/task-dependency-reach', () => ({ dependencyViewerOf: (u: any, a: any) => (a ? { kind: 'account', account: a } : u ? { kind: 'person', userId: u.id } : { kind: 'member' }) }));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: mockTasksFindFirst } } } }));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' } }));

import { GET } from './route';

const call = () => GET(new NextRequest('http://localhost/api/tasks/t1/question-waits'), { params: Promise.resolve({ id: 't1' }) });

describe('GET /api/tasks/[id]/question-waits', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockLoad.mockClear();
  });

  it('401 without a session, 404 without workspace access', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws' });
    mockVerifyWorkspaceAccess.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('loads the block for the signed-in person, so hidden dependents are resolved for them', async () => {
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws' });
    const body = await (await call()).json();
    expect(body.waits.taskId).toBe('t1');
    expect(mockLoad.mock.calls[0][0]).toEqual({ taskId: 't1', viewer: { kind: 'person', userId: 'user-1' } });
  });
});
