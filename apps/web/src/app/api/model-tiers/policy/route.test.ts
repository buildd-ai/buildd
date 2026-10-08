import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-1';
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamRole = mock(() => Promise.resolve('owner' as string | null));
const mockWrite = mock(async (_scope: unknown, _policy: unknown) => {});
const mockLoad = mock(async () => ({ policy: { mode: 'manual', adoptedThrough: '2026-10-01T00:00:00.000Z' }, source: 'team' }) as any);
const mockReport = mock(async () => ({
  policy: { policy: { mode: 'manual', adoptedThrough: '2026-10-01T00:00:00.000Z' }, source: 'team' },
  tiers: [{ tier: 'budget', model: 'claude-haiku-4-5', selectedBy: 'catalog', why: 'x', newer: { model: 'claude-haiku-5-5', certifiedAt: null }, withheld: { reason: 'manual', eligibleAt: null }, deprecated: null }],
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => [TEAM],
  verifyWorkspaceAccess: async () => ({ teamId: TEAM, role: 'owner' }),
  verifyAccountWorkspaceAccess: async () => true,
  getUserTeamRole: mockGetUserTeamRole,
  resolveActiveTeamId: async () => TEAM,
}));
const mockSnoozeFindFirst = mock(async () => null as any);
mock.module('@buildd/core/db', () => ({
  db: { query: {
    teams: { findFirst: async () => null },
    workspaces: { findFirst: async () => ({ teamId: TEAM }) },
    actionQueueSnoozes: { findFirst: mockSnoozeFindFirst },
  } },
}));
mock.module('@buildd/core/model-upgrade-policy-store', () => ({
  readStoredUpgradePolicy: async () => ({ mode: 'manual', adoptedThrough: '2026-10-01T00:00:00.000Z' }),
  writeUpgradePolicy: mockWrite,
  loadUpgradePolicy: mockLoad,
  invalidateUpgradePolicyCache: () => {},
}));
mock.module('@buildd/core/model-tier-adoption-report', () => ({ buildAdoptionReport: mockReport }));

const { GET, PUT, DELETE } = await import('./route');
const { POST: ADOPT } = await import('./adopt/route');

const req = (method: string, body?: unknown, qs = '') =>
  new NextRequest(`http://localhost/api/model-tiers/policy${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockGetUserTeamRole.mockReset();
  mockGetUserTeamRole.mockResolvedValue('owner');
  mockWrite.mockClear();
  mockLoad.mockClear();
});

describe('/api/model-tiers/policy', () => {
  it('GET returns the effective policy, its source and the per-tier explanation', async () => {
    const res = await GET(req('GET', undefined, `?teamId=${TEAM}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy.mode).toBe('manual');
    expect(body.source).toBe('team');
    expect(body.stored.team.mode).toBe('manual');
    expect(body.tiers[0].newer.model).toBe('claude-haiku-5-5');
  });

  it('notice=1 adds the Home notice; a snooze of that exact notice hides it', async () => {
    const res = await GET(req('GET', undefined, `?teamId=${TEAM}&notice=1`));
    const body = await res.json();
    expect(body.notice.kind).toBe('newer');
    expect(body.notice.canAdopt).toBe(true);

    mockSnoozeFindFirst.mockResolvedValueOnce({ subjectKey: body.notice.subjectKey });
    const snoozed = await (await GET(req('GET', undefined, `?teamId=${TEAM}&notice=1`))).json();
    expect(snoozed.notice).toBeNull();
  });

  it('without notice=1 there is no notice field', async () => {
    const body = await (await GET(req('GET', undefined, `?teamId=${TEAM}`))).json();
    expect('notice' in body).toBe(false);
  });

  it('PUT writes the team level with the actor stamped', async () => {
    const res = await PUT(req('PUT', { mode: 'soak', soakHours: 24, teamId: TEAM }));
    expect(res.status).toBe(200);
    const [scope, policy] = mockWrite.mock.calls[0] as any[];
    expect(scope).toEqual({ teamId: TEAM });
    expect(policy).toMatchObject({ mode: 'soak', soakHours: 24, setBy: 'user-1' });
  });

  it('PUT with a workspaceId writes the workspace override', async () => {
    await PUT(req('PUT', { mode: 'manual', workspaceId: WS }));
    expect(mockWrite.mock.calls[0][0]).toEqual({ workspaceId: WS });
  });

  it('PUT rejects an unknown mode', async () => {
    const res = await PUT(req('PUT', { mode: 'pinned', teamId: TEAM }));
    expect(res.status).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('a member without manage_model_tiers cannot write', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await PUT(req('PUT', { mode: 'manual', teamId: TEAM }));
    expect(res.status).toBe(403);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('DELETE clears the level (inherit)', async () => {
    const res = await DELETE(req('DELETE', undefined, `?teamId=${TEAM}`));
    expect(res.status).toBe(200);
    expect(mockWrite.mock.calls[0]).toEqual([{ teamId: TEAM }, null]);
  });

  it('adopt moves the manual line forward at the level the policy is set on', async () => {
    const res = await ADOPT(new NextRequest('http://localhost/api/model-tiers/policy/adopt', { method: 'POST', body: JSON.stringify({ teamId: TEAM }) }));
    expect(res.status).toBe(200);
    const [scope, policy] = mockWrite.mock.calls[0] as any[];
    expect(scope).toEqual({ teamId: TEAM });
    expect(Date.parse(policy.adoptedThrough)).toBeGreaterThan(Date.parse('2026-10-01T00:00:00.000Z'));
  });

  it('adopt under latest-compatible says there is nothing to adopt', async () => {
    mockLoad.mockResolvedValueOnce({ policy: { mode: 'latest-compatible' }, source: 'default' });
    const res = await ADOPT(new NextRequest('http://localhost/api/model-tiers/policy/adopt', { method: 'POST', body: JSON.stringify({ teamId: TEAM }) }));
    expect(res.status).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
