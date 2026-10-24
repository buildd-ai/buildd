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
  blocker: { type: 'pr', id: '1234', label: 'PR #1234' },
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

  describe('Start anyway state (spec 36df686b R-12, AC-16)', () => {
    const intent = (over: Record<string, unknown> = {}) => ({ id: 'f1', at: '2026-10-24T11:00:00Z', kinds: ['dep_declared'], loopKeys: [], assessDependsOn: ['up-1'], expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reasonsDigest: 'x', blockers: [], ...over });

    it('an accepted request on a pending task reads requested, not running', async () => {
      mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: { forceStart: intent() } });
      const body = await (await call()).json();
      expect(body.startAnyway).toMatchObject({ phase: 'requested', executing: false });
    });

    it('a claimed task reads assessing and executing, though it is never probed', async () => {
      mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'in_progress', context: { forceStartHistory: [{ ...intent(), claimedAt: '2026-10-24T11:05:00Z' }] } });
      const body = await (await call()).json();
      expect(body.startAnyway).toMatchObject({ phase: 'assessing', executing: true });
      expect(mockProbe).not.toHaveBeenCalled();
    });

    it('a parked task names its prerequisite and next step and holds no slot', async () => {
      mockTasksFindFirst
        .mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: {
          forceStartHistory: [{ ...intent(), claimedAt: '2026-10-24T11:05:00Z' }],
          waitExit: { blockerTaskId: 'up-1', reason: 'Needs the new API', at: '2026-10-24T11:30:00Z' },
        } })
        .mockResolvedValueOnce({ title: 'Upstream task' });
      const body = await (await call()).json();
      expect(body.startAnyway).toMatchObject({ phase: 'blocked', executing: false, blockerTaskId: 'up-1' });
      expect(body.startAnyway.label).toContain('Upstream task');
      expect(body.startAnyway.label).toContain('Needs the new API');
    });

    it('a task never started this way carries no startAnyway', async () => {
      mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: {} });
      expect((await (await call()).json()).startAnyway).toBeUndefined();
    });
  });
});
