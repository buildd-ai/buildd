import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async () => ({ id: 'user-1' }) as any);
const mockTasksFindFirst = mock(async () => null as any);
const mockVerifyWorkspaceAccess = mock(async () => ({ teamId: 'team-1' }) as any);
const mockProbe = mock(async (_t: any, _n?: Date) => [] as any[] | null);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess, verifyAccountWorkspaceAccess: async () => true }));
mock.module('@/lib/coordination-probe', () => ({ probeCoordination: mockProbe }));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: mockTasksFindFirst } } } }));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' } }));

import { GET } from './route';
import { makeWaitingReason } from '@buildd/core/waiting-reason';

const call = () => GET(new NextRequest('http://localhost/api/tasks/t1/waiting'), { params: Promise.resolve({ id: 't1' }) });
const prHold = makeWaitingReason('pr_overlap_live', {
  because: 'both edit packages/core/db/schema.ts',
  blocker: { type: 'pr', id: '3818', label: 'PR #3818' },
  provenance: { source: 'probe', derivedFrom: 't' },
});

describe('GET /api/tasks/[id]/waiting', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockProbe.mockReset();
    mockProbe.mockResolvedValue([]);
  });

  it('401 without a session, 404 without workspace access', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending' });
    mockVerifyWorkspaceAccess.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
  });

  it('a pending task held by an open PR returns the canonical reasons and the force spec', async () => {
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: {} });
    mockProbe.mockResolvedValueOnce([prHold]);
    const body = await (await call()).json();
    expect(body.waitingReasons[0].kind).toBe('pr_overlap_live');
    expect(body.canForce).toBe(true);
    expect(body.force.gates).toEqual(['Open-PR file overlap']);
    expect(typeof body.reasonsDigest).toBe('string');
  });

  it('reports an unexpired force start awaiting its claim', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: { forceStart: { loopKeys: ['path_overlap'], kinds: ['pr_overlap_live'], expiresAt } } });
    mockProbe.mockResolvedValueOnce([prHold]);
    expect((await (await call()).json()).forceStart).toEqual({ kinds: ['pr_overlap_live'], expiresAt });
  });

  it('a running task has no reasons and is never probed', async () => {
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'in_progress' });
    expect((await (await call()).json()).waitingReasons).toEqual([]);
    expect(mockProbe).not.toHaveBeenCalled();
  });
});
