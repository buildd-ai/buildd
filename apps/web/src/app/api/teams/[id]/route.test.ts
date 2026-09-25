import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRequireSessionUser = mock(() => Promise.resolve(null as any));
mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: mockRequireSessionUser,
  getRequestPrincipal: async () => principal,
}));
let principal: any = null;

let membership: any = { teamId: 'team-1', userId: 'user-1', role: 'admin' };
let teamRow: any = { id: 'team-1', name: 'Team', slug: 'team', timezone: null };
const capturedUpdates: any[] = [];
const teamQueries: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findFirst: () => Promise.resolve(membership), findMany: () => Promise.resolve([]) },
      teams: { findFirst: (q: any) => { teamQueries.push(q); return Promise.resolve(teamRow); } },
    },
    update: (_t: any) => ({
      set: (vals: any) => ({ where: (_c: any) => { capturedUpdates.push(vals); return Promise.resolve(); } }),
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teams: 'teams',
  teamMembers: 'teamMembers',
  users: 'users',
}));

import { GET, PATCH } from './route';

const ctx = { params: Promise.resolve({ id: 'team-1' }) };

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/teams/team-1', {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRequireSessionUser.mockReset();
  mockRequireSessionUser.mockResolvedValue({ user: { id: 'user-1' } });
  membership = { teamId: 'team-1', userId: 'user-1', role: 'admin' };
  teamRow = { id: 'team-1', name: 'Team', slug: 'team', timezone: null };
  capturedUpdates.length = 0;
});

describe('PATCH /api/teams/[id] — timezone', () => {
  it('stores a valid IANA zone', async () => {
    const res = await PATCH(patchReq({ timezone: 'America/New_York' }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0].timezone).toBe('America/New_York');
  });

  it('accepts null to clear the zone back to UTC', async () => {
    const res = await PATCH(patchReq({ timezone: null }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0].timezone).toBeNull();
  });

  it('rejects a zone the runtime does not recognise', async () => {
    const res = await PATCH(patchReq({ timezone: 'Mars/Olympus' }), ctx);
    expect(res.status).toBe(400);
    expect(capturedUpdates).toHaveLength(0);
  });

  it('leaves the zone untouched when the field is absent', async () => {
    const res = await PATCH(patchReq({ name: 'Renamed' }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).not.toHaveProperty('timezone');
  });

  it('requires at least admin — a member cannot set the team zone', async () => {
    membership = { teamId: 'team-1', userId: 'user-1', role: 'member' };
    const res = await PATCH(patchReq({ timezone: 'America/New_York' }), ctx);
    expect(res.status).toBe(403);
    expect(capturedUpdates).toHaveLength(0);
  });
});

describe('GET /api/teams/[id] — response columns', () => {
  it('no longer reads the deprecated criteriaEvaluationStrategy column', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    const res = await GET(new NextRequest('http://localhost:3000/api/teams/team-1'), ctx);
    expect(res.status).toBe(200);
    const columns = teamQueries[0]?.columns ?? {};
    expect(Object.keys(columns).length).toBeGreaterThan(0);
    expect(columns).not.toHaveProperty('criteriaEvaluationStrategy');
    principal = null;
  });
});
