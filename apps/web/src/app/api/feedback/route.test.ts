import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock functions ──────────────────────────────────────────────────────────

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));

const mockFeedbackFindFirst = mock(() => null as any);
const mockFeedbackFindMany = mock(() => [] as any[]);
const mockFeedbackInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => []),
  })),
}));
const mockFeedbackUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => []),
    })),
  })),
}));
const mockFeedbackDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

// ── Register mocks before importing the route ───────────────────────────────

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      userFeedback: {
        findFirst: mockFeedbackFindFirst,
        findMany: mockFeedbackFindMany,
      },
    },
    insert: () => mockFeedbackInsert(),
    update: () => mockFeedbackUpdate(),
    delete: () => mockFeedbackDelete(),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  userFeedback: {
    userId: 'user_id',
    entityType: 'entity_type',
    entityId: 'entity_id',
    id: 'id',
    signal: 'signal',
    createdAt: 'created_at',
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

import { POST, GET } from './route';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createPostRequest(body: Record<string, any>): NextRequest {
  return new NextRequest('http://localhost:3000/api/feedback', {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function createGetRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/feedback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString(), { method: 'GET' });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/feedback', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockFeedbackFindFirst.mockReset();
    mockFeedbackInsert.mockReset();
    mockFeedbackUpdate.mockReset();
    mockFeedbackDelete.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await POST(createPostRequest({
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'dismiss',
    }));

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for invalid entityType', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await POST(createPostRequest({
      entityType: 'invalid_type',
      entityId: 'art-1',
      signal: 'dismiss',
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid entityType');
  });

  it('returns 400 for missing entityId', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await POST(createPostRequest({
      entityType: 'artifact',
      signal: 'dismiss',
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('entityId is required');
  });

  it('returns 400 for invalid signal', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await POST(createPostRequest({
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'invalid',
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid signal');
  });

  it('returns 403 when user has no team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue([]);

    const res = await POST(createPostRequest({
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'dismiss',
    }));

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('No team found');
  });

  it('creates new feedback entry (201)', async () => {
    const feedbackEntry = {
      id: 'fb-1',
      userId: 'user-1',
      teamId: 'team-1',
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'dismiss',
      comment: 'Too verbose',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockFeedbackFindFirst.mockResolvedValue(null); // no existing feedback
    mockFeedbackInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [feedbackEntry]),
      })),
    });

    const res = await POST(createPostRequest({
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'dismiss',
      comment: 'Too verbose',
    }));

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.signal).toBe('dismiss');
    expect(data.entityId).toBe('art-1');
    expect(data.comment).toBe('Too verbose');
  });

  it('toggles off when same signal sent again (removes feedback)', async () => {
    const existing = {
      id: 'fb-1',
      userId: 'user-1',
      teamId: 'team-1',
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'down',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockFeedbackFindFirst.mockResolvedValue(existing);
    mockFeedbackDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });

    const res = await POST(createPostRequest({
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'down', // same signal as existing
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.removed).toBe(true);
  });

  it('updates signal when different signal sent', async () => {
    const existing = {
      id: 'fb-1',
      userId: 'user-1',
      teamId: 'team-1',
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'up',
    };
    const updatedEntry = { ...existing, signal: 'down' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockFeedbackFindFirst.mockResolvedValue(existing);
    mockFeedbackUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [updatedEntry]),
        })),
      })),
    });

    const res = await POST(createPostRequest({
      entityType: 'artifact',
      entityId: 'art-1',
      signal: 'down',
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.signal).toBe('down');
  });

  it('accepts all valid entity types', async () => {
    const entityTypes = ['note', 'artifact', 'summary', 'orchestration', 'heartbeat'];

    for (const entityType of entityTypes) {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserTeamIds.mockResolvedValue(['team-1']);
      mockFeedbackFindFirst.mockResolvedValue(null);
      mockFeedbackInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => [{
            id: 'fb-new',
            userId: 'user-1',
            teamId: 'team-1',
            entityType,
            entityId: 'ent-1',
            signal: 'up',
          }]),
        })),
      });

      const res = await POST(createPostRequest({
        entityType,
        entityId: 'ent-1',
        signal: 'up',
      }));

      expect(res.status).toBe(201);
    }
  });

  it('accepts all valid signal types', async () => {
    const signals = ['up', 'down', 'dismiss'];

    for (const signal of signals) {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserTeamIds.mockResolvedValue(['team-1']);
      mockFeedbackFindFirst.mockResolvedValue(null);
      mockFeedbackInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => [{
            id: 'fb-new',
            userId: 'user-1',
            teamId: 'team-1',
            entityType: 'artifact',
            entityId: 'ent-1',
            signal,
          }]),
        })),
      });

      const res = await POST(createPostRequest({
        entityType: 'artifact',
        entityId: 'ent-1',
        signal,
      }));

      expect(res.status).toBe(201);
    }
  });
});

describe('GET /api/feedback', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockFeedbackFindMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await GET(createGetRequest({ entityType: 'artifact', entityIds: 'art-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing entityType', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await GET(createGetRequest({}));
    expect(res.status).toBe(400);
  });

  it('returns feedback map for given entityIds', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockFeedbackFindMany.mockResolvedValue([
      { entityId: 'art-1', signal: 'up' },
      { entityId: 'art-2', signal: 'dismiss' },
      { entityId: 'art-3', signal: 'down' },
    ]);

    const res = await GET(createGetRequest({
      entityType: 'artifact',
      entityIds: 'art-1,art-2',
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.feedback['art-1']).toBe('up');
    expect(data.feedback['art-2']).toBe('dismiss');
    // art-3 should be filtered out since it wasn't in entityIds
    expect(data.feedback['art-3']).toBeUndefined();
  });

  it('returns all feedback when no entityIds specified', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockFeedbackFindMany.mockResolvedValue([
      { entityId: 'art-1', signal: 'up' },
      { entityId: 'art-2', signal: 'down' },
    ]);

    const res = await GET(createGetRequest({ entityType: 'note' }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.keys(data.feedback).length).toBe(2);
  });
});
