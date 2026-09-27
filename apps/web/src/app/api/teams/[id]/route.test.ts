import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRequireSessionUser = mock(() => Promise.resolve(null as any));
mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: mockRequireSessionUser,
  getRequestPrincipal: async () => principal,
}));
let principal: any = null;

let membership: any = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'admin' };
let teamRow: any = { id: '11111111-1111-4111-8111-111111111111', name: 'Team', slug: 'team', timezone: null };
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

const ctx = { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) };

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111', {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRequireSessionUser.mockReset();
  mockRequireSessionUser.mockResolvedValue({ user: { id: 'user-1' } });
  membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'admin' };
  teamRow = { id: '11111111-1111-4111-8111-111111111111', name: 'Team', slug: 'team', timezone: null };
  capturedUpdates.length = 0;
});

describe('non-UUID id guard', () => {
  it('GET returns 404 for a non-UUID id without querying the db', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    const res = await GET(new NextRequest('http://localhost:3000/api/teams/not-a-uuid'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(teamQueries.length).toBe(0);
    principal = null;
  });

  it('PATCH returns 404 for a non-UUID id without querying the db', async () => {
    const req = new NextRequest('http://localhost:3000/api/teams/not-a-uuid', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'X' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(capturedUpdates).toHaveLength(0);
    expect(mockRequireSessionUser).not.toHaveBeenCalled();
  });
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
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'member' };
    const res = await PATCH(patchReq({ timezone: 'America/New_York' }), ctx);
    expect(res.status).toBe(403);
    expect(capturedUpdates).toHaveLength(0);
  });
});

describe('GET /api/teams/[id] — response columns', () => {
  it('no longer reads the deprecated criteriaEvaluationStrategy column', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    const res = await GET(new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111'), ctx);
    expect(res.status).toBe(200);
    const columns = teamQueries[0]?.columns ?? {};
    expect(Object.keys(columns).length).toBeGreaterThan(0);
    expect(columns).not.toHaveProperty('criteriaEvaluationStrategy');
    principal = null;
  });

  // Regression (UX review, Settings > Members): the column list left out
  // timezone, so the Timezone section read "Not set. buildd uses UTC." for a
  // team with a zone saved, and a save looked lost on the next load.
  it('returns the team timezone the Timezone section reads', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    await GET(new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111'), ctx);
    expect(teamQueries[0].columns).toMatchObject({ timezone: true });
    principal = null;
  });
});

describe('PATCH /api/teams/[id] — chat budgets', () => {
  it('an admin can raise the team and per-person daily chat budgets', async () => {
    const res = await PATCH(patchReq({ chatDailyBudgetUsd: 150, chatUserDailyBudgetUsd: 40.5 }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).toMatchObject({ chatDailyBudgetUsd: '150.00', chatUserDailyBudgetUsd: '40.50' });
  });

  it('null reverts to the defaults', async () => {
    const res = await PATCH(patchReq({ chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).toMatchObject({ chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null });
  });

  it('rejects negative, non-numeric or absurd values', async () => {
    for (const v of [-1, 'lots', Number.MAX_SAFE_INTEGER]) {
      const res = await PATCH(patchReq({ chatDailyBudgetUsd: v }), ctx);
      expect(res.status).toBe(400);
    }
    expect((await PATCH(patchReq({ chatUserDailyBudgetUsd: -5 }), ctx)).status).toBe(400);
    expect(capturedUpdates).toHaveLength(0);
  });

  it('a member cannot change them', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'member' };
    const res = await PATCH(patchReq({ chatDailyBudgetUsd: 1000 }), ctx);
    expect(res.status).toBe(403);
    expect(capturedUpdates).toHaveLength(0);
  });

  it('GET returns the key policy, and never reads the deprecated chat switch', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    await GET(new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111'), ctx);
    expect(teamQueries[0].columns).toMatchObject({ inferenceKeyPolicy: true });
    expect(teamQueries[0].columns).not.toHaveProperty('chatDisabled');
    principal = null;
  });

  it('GET returns both, so a settings page can show them', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    await GET(new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111'), ctx);
    expect(teamQueries[0].columns).toMatchObject({ chatDailyBudgetUsd: true, chatUserDailyBudgetUsd: true });
    principal = null;
  });
});

describe('PATCH /api/teams/[id] — key policy', () => {
  it('an admin sets the key policy', async () => {
    for (const p of ['team', 'team_or_own', 'own']) {
      capturedUpdates.length = 0;
      const res = await PATCH(patchReq({ inferenceKeyPolicy: p }), ctx);
      expect(res.status).toBe(200);
      expect(capturedUpdates[0]).toMatchObject({ inferenceKeyPolicy: p });
    }
  });

  it('rejects an unknown policy', async () => {
    const res = await PATCH(patchReq({ inferenceKeyPolicy: 'anyone' }), ctx);
    expect(res.status).toBe(400);
    expect(capturedUpdates).toHaveLength(0);
  });

  it('chat is always on: a chatDisabled field is ignored, never written', async () => {
    await PATCH(patchReq({ chatDisabled: true, inferenceKeyPolicy: 'team' }), ctx);
    await PATCH(patchReq({ chatDisabled: 'yes', inferenceKeyPolicy: 'team' }), ctx);
    for (const u of capturedUpdates) expect(u).not.toHaveProperty('chatDisabled');
  });

  it('a member cannot change it', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'member' };
    expect((await PATCH(patchReq({ inferenceKeyPolicy: 'own' }), ctx)).status).toBe(403);
    expect(capturedUpdates).toHaveLength(0);
  });
});

describe('PATCH /api/teams/[id] — server-side feature overrides', () => {
  it('stores overrides, dropping unknown features and "default"', async () => {
    const res = await PATCH(patchReq({ inferenceFeatureModes: { criteria_grading: 'runner', visual_qa: 'default', chat: 'runner' } }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).toMatchObject({ inferenceFeatureModes: { criteria_grading: 'runner' } });
  });

  it('clears every override with null or an all-default map', async () => {
    await PATCH(patchReq({ inferenceFeatureModes: null }), ctx);
    await PATCH(patchReq({ inferenceFeatureModes: { criteria_grading: 'default' } }), ctx);
    expect(capturedUpdates.map((u) => u.inferenceFeatureModes)).toEqual([null, null]);
  });

  it('rejects a non-object', async () => {
    const res = await PATCH(patchReq({ inferenceFeatureModes: ['runner'] }), ctx);
    expect(res.status).toBe(400);
    expect(capturedUpdates).toHaveLength(0);
  });

  it('ignores the retired allowlist field instead of writing it', async () => {
    const res = await PATCH(patchReq({ enabledInferenceCapabilities: ['chat'] }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).not.toHaveProperty('enabledInferenceCapabilities');
  });

  it('a member cannot change them', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'member' };
    expect((await PATCH(patchReq({ inferenceFeatureModes: { criteria_grading: 'runner' } }), ctx)).status).toBe(403);
  });

  it('GET returns them', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    await GET(new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111'), ctx);
    expect(teamQueries[0].columns).toMatchObject({ inferenceFeatureModes: true });
    principal = null;
  });
});
