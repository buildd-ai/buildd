import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));

const mockWorkersFindMany = mock(() => [] as any[]);
const mockMissionNotesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));

mock.module('@/lib/merge-policy', () => ({
  resolvePolicy: (ws: any) => {
    const tier = ws?.gitConfig?.mergePolicy?.tier ?? 'auto-threshold';
    return { tier };
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      missionNotes: { findMany: mockMissionNotesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  isNotNull: (a: any) => ({ type: 'isNotNull', a }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  sql: (strings: any, ...values: any[]) => ({ type: 'sql', strings, values }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: {
    workspaceId: 'workspaceId',
    prUrl: 'prUrl',
    mergedAt: 'mergedAt',
    prLifecycleStatus: 'prLifecycleStatus',
  },
  tasks: { id: 'id', title: 'title', missionId: 'missionId' },
  workspaces: { id: 'id' },
  missionNotes: { taskId: 'taskId', type: 'type' },
}));

import { GET } from './route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prs/escalation-inbox');
}

function makeWorker(overrides: Record<string, any> = {}) {
  return {
    id: 'w-1',
    taskId: 't-1',
    workspaceId: 'ws-1',
    prUrl: 'https://github.com/org/repo/pull/42',
    prNumber: 42,
    prLifecycleStatus: 'pr_open',
    completedAt: new Date('2026-07-20T10:00:00Z'),
    task: { id: 't-1', title: 'Build thing', missionId: null },
    ...overrides,
  };
}

describe('GET /api/prs/escalation-inbox', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockMissionNotesFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns empty when no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('includes open PR in human-gate workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].prNumber).toBe(42);
  });

  it('excludes closed PR from inbox even if DB returns it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ prLifecycleStatus: 'closed' }),
    ]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('excludes smoke-test tasks from inbox', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ task: { id: 't-1', title: '[smoke-test-4] verify worker lifecycle', missionId: null } }),
    ]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('includes escalated PR regardless of workspace policy', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([
      { taskId: 't-1', title: 'Escalated', body: 'Reviewer could not decide' },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: null },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].escalationReason).toBe('Reviewer could not decide');
  });
});
