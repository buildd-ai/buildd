import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => [] as string[]);
const mockReturning = mock(() => Promise.resolve([{ id: 'snooze-1', subjectKey: 'sub-1' }] as any[]));
const mockOnConflictDoUpdate = mock(() => ({ returning: mockReturning }));
const mockValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockValues }));
const mockWhere = mock(() => Promise.resolve());
const mockDelete = mock(() => ({ where: mockWhere }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));

mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => mockInsert(),
    delete: () => mockDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  actionQueueSnoozes: { userId: 'userId', subjectKey: 'subjectKey' },
}));

import { POST, DELETE } from './route';

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/action-queue/snooze', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function deleteReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/action-queue/snooze', {
    method: 'DELETE',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockGetUserTeamIds.mockReset();
  mockInsert.mockReset();
  mockValues.mockReset();
  mockOnConflictDoUpdate.mockReset();
  mockReturning.mockReset();
  mockDelete.mockReset();
  mockWhere.mockReset();

  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockGetUserTeamIds.mockResolvedValue(['team-1']);
  mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: 'snooze-1', subjectKey: 'pr:https://github.com/x/y/pull/1', snoozedUntil: new Date() }]);
  mockInsert.mockReturnValue({ values: mockValues });
  mockWhere.mockResolvedValue(undefined);
  mockDelete.mockReturnValue({ where: mockWhere });
});

describe('POST /api/action-queue/snooze', () => {
  it('returns 401 when not signed in', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(postReq({ subjectKey: 'pr:1', hours: 24 }));
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 when subjectKey is missing', async () => {
    const res = await POST(postReq({ hours: 24 }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 for a duration that is not one of the SwipeableRow snooze options', async () => {
    const res = await POST(postReq({ subjectKey: 'pr:1', hours: 48 }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 403 when the user has no team', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    const res = await POST(postReq({ subjectKey: 'pr:1', hours: 24 }));
    expect(res.status).toBe(403);
  });

  it('upserts a snooze row for a valid 24h/3d/7d duration', async () => {
    for (const hours of [24, 72, 168]) {
      const res = await POST(postReq({ subjectKey: 'pr:1', hours }));
      expect(res.status).toBe(201);
    }
    expect(mockInsert).toHaveBeenCalledTimes(3);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(3);
  });

  it('returns 400 rather than throwing on a malformed body', async () => {
    const bad = new NextRequest('http://localhost:3000/api/action-queue/snooze', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: 'not json',
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/action-queue/snooze', () => {
  it('returns 401 when not signed in', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await DELETE(deleteReq({ subjectKey: 'pr:1' }));
    expect(res.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 400 when subjectKey is missing', async () => {
    const res = await DELETE(deleteReq({}));
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes the snooze row scoped to the current user', async () => {
    const res = await DELETE(deleteReq({ subjectKey: 'pr:1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true, subjectKey: 'pr:1' });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});
