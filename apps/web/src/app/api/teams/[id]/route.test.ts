import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

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
let deletedTeams = 0;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findFirst: () => Promise.resolve(membership), findMany: () => Promise.resolve([]) },
      teams: { findFirst: (q: any) => { teamQueries.push(q); return Promise.resolve(teamRow); } },
    },
    update: (_t: any) => ({
      set: (vals: any) => ({ where: (_c: any) => { capturedUpdates.push(vals); return Promise.resolve(); } }),
    }),
    delete: (_t: any) => ({ where: (_c: any) => { deletedTeams++; return Promise.resolve(); } }),
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

import { DELETE, GET, PATCH } from './route';

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

describe('PATCH /api/teams/[id] — chat tier policy', () => {
  it('an admin sets the default tier and turns the new-session cap on', async () => {
    const res = await PATCH(patchReq({ chatDefaultTier: 'standard', chatCapNewSessionTier: true }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).toMatchObject({ chatDefaultTier: 'standard', chatCapNewSessionTier: true });
  });

  it('null default tier is auto', async () => {
    const res = await PATCH(patchReq({ chatDefaultTier: null }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).toMatchObject({ chatDefaultTier: null });
  });

  it('rejects a tier chat does not have, or a non-boolean cap', async () => {
    expect((await PATCH(patchReq({ chatDefaultTier: 'premium-plus' }), ctx)).status).toBe(400);
    expect((await PATCH(patchReq({ chatCapNewSessionTier: 'yes' }), ctx)).status).toBe(400);
    expect(capturedUpdates).toHaveLength(0);
  });

  it('a member cannot change it', async () => {
    membership = { teamId: 'team-1', userId: 'user-1', role: 'member' };
    expect((await PATCH(patchReq({ chatCapNewSessionTier: true }), ctx)).status).toBe(403);
    expect(capturedUpdates).toHaveLength(0);
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

  it('the legacy name writes the credential policy too, so the columns never disagree', async () => {
    const want = { team: 'team', team_or_own: 'personal_first', own: 'personal_only' } as const;
    for (const [legacy, cp] of Object.entries(want)) {
      capturedUpdates.length = 0;
      await PATCH(patchReq({ inferenceKeyPolicy: legacy }), ctx);
      expect(capturedUpdates[0]).toMatchObject({ inferenceKeyPolicy: legacy, credentialPolicy: cp });
    }
  });

  it('an admin sets the credential policy by its new name, writing both columns', async () => {
    const want = { team: 'team', personal_first: 'team_or_own', personal_only: 'own' } as const;
    for (const [cp, legacy] of Object.entries(want)) {
      capturedUpdates.length = 0;
      const res = await PATCH(patchReq({ credentialPolicy: cp }), ctx);
      expect(res.status).toBe(200);
      expect(capturedUpdates[0]).toMatchObject({ credentialPolicy: cp, inferenceKeyPolicy: legacy });
    }
  });

  it('rejects an unknown credential policy, including a legacy value under the new name', async () => {
    for (const bad of ['anyone', 'team_or_own']) {
      const res = await PATCH(patchReq({ credentialPolicy: bad }), ctx);
      expect(res.status).toBe(400);
    }
    expect(capturedUpdates).toHaveLength(0);
  });

  it('GET reads the credential policy column', async () => {
    principal = { kind: 'user', user: { id: 'user-1' } };
    teamQueries.length = 0;
    await GET(new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111'), ctx);
    expect(teamQueries[0].columns).toMatchObject({ credentialPolicy: true });
    principal = null;
  });

  it('a member cannot change it', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'member' };
    expect((await PATCH(patchReq({ inferenceKeyPolicy: 'own' }), ctx)).status).toBe(403);
    expect(capturedUpdates).toHaveLength(0);
  });
});

describe('PATCH /api/teams/[id] — optional decision capabilities', () => {
  for (const role of ['owner', 'admin']) {
    it(`allows a signed-in ${role} to save and clear optional decisions`, async () => {
      membership.role = role;
      const enabled = ['orchestration_manifest', 'orchestration_claim'];
      expect((await PATCH(patchReq({ enabledDecisionShadows: enabled }), ctx)).status).toBe(200);
      expect(capturedUpdates[0].enabledDecisionShadows).toEqual(enabled);
      for (const cleared of [[], null]) {
        capturedUpdates.length = 0;
        expect((await PATCH(patchReq({ enabledDecisionShadows: cleared }), ctx)).status).toBe(200);
        expect(capturedUpdates[0].enabledDecisionShadows).toBeNull();
      }
    });
  }

  it('rejects a member without writing optional decision settings', async () => {
    membership.role = 'member';
    for (const enabledDecisionShadows of [['orchestration_manifest'], null]) {
      expect((await PATCH(patchReq({ enabledDecisionShadows }), ctx)).status).toBe(403);
    }
    expect(capturedUpdates).toHaveLength(0);
  });

  it('requires the session guard for an admin MCP API key', async () => {
    principal = { kind: 'api_key', account: { level: 'admin', teamId: teamRow.id } };
    mockRequireSessionUser.mockResolvedValue({ response: NextResponse.json(
      { error: 'This action requires a signed-in session' }, { status: 403 },
    ) });
    const req = patchReq({ enabledDecisionShadows: ['orchestration_manifest'] });
    req.headers.set('authorization', 'Bearer bld_test');
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('signed-in session');
    expect(mockRequireSessionUser).toHaveBeenCalledWith(req);
    expect(capturedUpdates).toHaveLength(0);
    principal = null;
  });

  it('rejects invalid capabilities and preserves the setting when omitted', async () => {
    expect((await PATCH(patchReq({ enabledDecisionShadows: ['unknown'] }), ctx)).status).toBe(400);
    expect(capturedUpdates).toHaveLength(0);
    expect((await PATCH(patchReq({ name: 'Renamed' }), ctx)).status).toBe(200);
    expect(capturedUpdates[0]).not.toHaveProperty('enabledDecisionShadows');
  });
});

describe('PATCH /api/teams/[id] — decision model', () => {
  it('stores a chat model via the LiteLLM gateway', async () => {
    const res = await PATCH(patchReq({ decisionModel: { endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' } }), ctx);
    expect(res.status).toBe(200);
    expect(capturedUpdates[0]).toMatchObject({ decisionModel: { endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' } });
  });

  it('clears back to Jev with null', async () => {
    await PATCH(patchReq({ decisionModel: null }), ctx);
    expect(capturedUpdates[0]).toMatchObject({ decisionModel: null });
  });

  it('rejects a System One model through the gateway, and a bad model id', async () => {
    expect((await PATCH(patchReq({ decisionModel: { endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'litellm' } }), ctx)).status).toBe(400);
    expect((await PATCH(patchReq({ decisionModel: { endpoint: 'chat', model: 'has space', via: 'openrouter' } }), ctx)).status).toBe(400);
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

describe('DELETE /api/teams/[id]', () => {
  const del = () =>
    DELETE(new NextRequest('http://localhost:3000/api/teams/11111111-1111-4111-8111-111111111111', { method: 'DELETE' }), ctx);

  beforeEach(() => { deletedTeams = 0; });

  it('a member cannot delete the team', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'member' };
    expect((await del()).status).toBe(403);
    expect(deletedTeams).toBe(0);
  });

  it('an admin cannot delete the team', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'admin' };
    expect((await del()).status).toBe(403);
    expect(deletedTeams).toBe(0);
  });

  it('a non-member cannot delete the team', async () => {
    membership = undefined;
    expect((await del()).status).toBe(403);
    expect(deletedTeams).toBe(0);
  });

  it('an owner deletes the team', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'owner' };
    expect((await del()).status).toBe(200);
    expect(deletedTeams).toBe(1);
  });

  it('an owner still cannot delete a personal team', async () => {
    membership = { teamId: '11111111-1111-4111-8111-111111111111', userId: 'user-1', role: 'owner' };
    teamRow = { ...teamRow, slug: 'personal-user-1' };
    expect((await del()).status).toBe(400);
    expect(deletedTeams).toBe(0);
  });
});
