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
const mockLive = mock(async (_ids: readonly string[]) => new Map<string, any>());
mock.module('@/lib/queue-wait-load', () => ({ loadQueueWaits: mockLive }));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: mockTasksFindFirst } } } }));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' } }));

import { GET } from './route';
import { makeWaitingReason } from '@buildd/core/waiting-reason';

const call = () => GET(new NextRequest('http://localhost/api/tasks/t1/waiting'), { params: Promise.resolve({ id: 't1' }) });
const paced = makeWaitingReason('mission_paced', {
  because: 'the mission starts a task at most every 10 min',
  blocker: { type: 'mission', id: 'm', label: 'mission pacing' },
  provenance: { source: 'probe', derivedFrom: 't' },
});
const laneHold = makeWaitingReason('lane', {
  because: 'both edit packages/core/db/schema.ts, and PR #1234 holds the lane until it merges or closes',
  blocker: { type: 'pr', id: '1234', label: 'PR #1234' },
  lane: { lane: 'migration', holderTaskId: 'h', position: null },
  provenance: { source: 'probe', derivedFrom: 't' },
});
const held = makeWaitingReason('task_held', { because: 'a person paused it', provenance: { source: 'probe', derivedFrom: 't' } });

describe('GET /api/tasks/[id]/waiting', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockProbe.mockReset();
    mockProbe.mockResolvedValue([]);
    mockLive.mockReset();
    mockLive.mockResolvedValue(new Map());
  });

  it('401 without a session, 404 without workspace access', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending' });
    mockVerifyWorkspaceAccess.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
  });

  it('a pending task held by a limit returns the canonical reasons and the force spec', async () => {
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: {} });
    mockProbe.mockResolvedValueOnce([paced]);
    const body = await (await call()).json();
    expect(body.waitingReasons[0].kind).toBe('mission_paced');
    expect(body.canForce).toBe(true);
    expect(body.force.gates).toEqual(['Mission pacing']);
    expect(typeof body.reasonsDigest).toBe('string');
  });

  it('a lane wait is never offered Force start (Health › Queue R-10)', async () => {
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: {} });
    mockProbe.mockResolvedValueOnce([laneHold]);
    const body = await (await call()).json();
    expect(body.canForce).toBe(false);
    expect(body.force).toBeNull();
  });

  // Spec: Overlap scheduling, AC-10: the task page names what the claim query refuses it for, the one reason explain gives.
  it('joins the claim query\'s own refusals the probe does not cover, and returns the one queue wait', async () => {
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: {} });
    mockProbe.mockResolvedValueOnce([paced]);
    mockLive.mockResolvedValueOnce(new Map([['t1', { wait: { kind: 'limit', limit: 'task_paused', liftsAt: null, forceable: false }, reasons: [held, paced] }]]));
    const body = await (await call()).json();
    expect(body.waitingReasons.map((r: any) => r.kind).sort()).toEqual(['mission_paced', 'task_held']);
    expect(body.queueWait).toEqual({ kind: 'limit', limit: 'task_paused', liftsAt: null, forceable: false });
    expect(body.canForce).toBe(false);
  });

  it('reports an unexpired force start awaiting its claim', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'pending', context: { forceStart: { loopKeys: ['mission_paced'], kinds: ['mission_paced'], expiresAt } } });
    mockProbe.mockResolvedValueOnce([paced]);
    expect((await (await call()).json()).forceStart).toEqual({ kinds: ['mission_paced'], expiresAt });
  });

  it('a running task has no reasons and is never probed', async () => {
    mockTasksFindFirst.mockResolvedValueOnce({ id: 't1', workspaceId: 'ws', status: 'in_progress' });
    expect((await (await call()).json()).waitingReasons).toEqual([]);
    expect(mockProbe).not.toHaveBeenCalled();
  });
});
