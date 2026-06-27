import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkspacesFindFirst = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, type: 'eq' }),
  desc: (a: any) => ({ a, type: 'desc' }),
  isNotNull: (a: any) => ({ a, type: 'isNotNull' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { workspaceId: 'workspaceId', releaseResult: 'releaseResult', updatedAt: 'updatedAt' },
  workspaces: { id: 'id', teamId: 'teamId' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

describe('GET /api/workspaces/[id]/last-release', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockWorkspacesFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/last-release');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/last-release');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns null lastRelease when no releases have run', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindMany.mockResolvedValue([]);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/last-release');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lastRelease).toBeNull();
    expect(data.recentReleases).toEqual([]);
  });

  it('returns the most recent release result', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'task-1',
        title: 'feat: add feature',
        missionId: 'mission-1',
        updatedAt: '2026-06-25T10:00:00Z',
        releaseResult: {
          status: 'completed',
          message: 'Release succeeded',
          deployState: 'READY',
          deployUrl: 'https://my-project.vercel.app',
        },
        result: { sha: 'abc1234', branch: 'buildd/task-1' },
      },
    ]);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/last-release');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lastRelease).not.toBeNull();
    expect(data.lastRelease.taskId).toBe('task-1');
    expect(data.lastRelease.releaseResult.deployState).toBe('READY');
    expect(data.lastRelease.sha).toBe('abc1234');
    expect(data.recentReleases).toHaveLength(1);
  });

  it('returns up to 5 recent releases', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      missionId: null,
      updatedAt: `2026-06-0${i + 1}T00:00:00Z`,
      releaseResult: { status: 'completed', message: 'ok', deployState: 'READY' },
      result: { sha: `sha${i}` },
    }));
    mockTasksFindMany.mockResolvedValue(tasks);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/last-release');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.recentReleases).toHaveLength(5);
    expect(data.lastRelease.taskId).toBe('task-0');
  });

  it('OAuth token with matching team can read', async () => {
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-1', level: 'admin', teamId: 'team-1', authType: 'oauth' };
      return null;
    });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', accessMode: 'restricted' });
    mockTasksFindMany.mockResolvedValue([]);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/last-release', {
      headers: new Headers({ authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fakeJwt' }),
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
  });
});

afterAll(() => mock.restore());
