/**
 * GET /api/admin/root-causes: the real owner gate, so a refusal here is the
 * gate's, not a stub's. Only the key lookup and the stores are stubbed.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { NextRequest } from 'next/server';
import type { RootCauseRecord } from '@buildd/shared';

const OWNER = 'acct-owner';
const OWN_TEAM = '11111111-1111-4111-8111-111111111111';
const OTHER_TEAM = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';

const keys: Record<string, { id: string; teamId: string; level: string; createdByUserId: string | null }> = {
  bld_owner: { id: OWNER, teamId: OWN_TEAM, level: 'admin', createdByUserId: null },
  // An admin key of a team: as high as a team credential goes, still not the platform's.
  bld_team_admin: { id: 'acct-team', teamId: OTHER_TEAM, level: 'admin', createdByUserId: null },
  bld_team_worker: { id: 'acct-worker', teamId: OWN_TEAM, level: 'worker', createdByUserId: null },
};
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async (key: string) => keys[key] ?? null }));
// A signed-in person who is not an operator. The gate must not consult a session at all.
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'user-1', email: 'member@example.test' }) }));

const stub = async () => ({});
mock.module('@/lib/admin/data', () => ({
  resolveScopeWorkspaces: async () => ({ workspaces: [{ id: WS, teamId: OWN_TEAM }] }),
  loadOwnTeams: async () => [{ id: OWN_TEAM, name: 'Team A' }],
  listChatRetros: stub, listTeamsWithWorkspaces: stub, loadAgentAccess: stub, loadDispatchHealth: stub, loadFailures: stub,
  loadGates: stub, loadInsights: stub, loadInsightsBand: stub, loadOperatorData: stub, loadUsage: stub,
}));

const record = (teamId: string, over: Partial<RootCauseRecord> = {}): RootCauseRecord => ({
  key: 'credential:runner-1:claude',
  teamId,
  capability: { kind: 'runner', runnerId: 'runner-1', provider: 'claude', component: null, workspaceId: null },
  classification: 'credential_expired',
  affectedTaskIds: ['task-1', 'task-2'],
  firstSeenAt: '2026-10-13T09:00:00.000Z',
  lastSeenAt: '2026-10-13T09:30:00.000Z',
  verifiedRestoredAt: null,
  ...over,
});
const listCalls: any[] = [];
let stored: RootCauseRecord[] = [];
mock.module('@/lib/root-cause-record', () => ({
  listRootCauses: async (opts: any) => { listCalls.push(opts); return stored; },
}));

const { PLATFORM_ADMIN_ENV } = await import('@/lib/platform-admin');
const { GET } = await import('./route');

const original = process.env[PLATFORM_ADMIN_ENV];
const req = (opts: { key?: string; cookie?: string; query?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`http://localhost:3000/api/admin/root-causes${opts.query ?? ''}`, { headers });
};

beforeEach(() => {
  process.env[PLATFORM_ADMIN_ENV] = OWNER;
  listCalls.length = 0;
  stored = [record(OWN_TEAM), record(OTHER_TEAM, { key: 'pattern:stranded_gate:ws-x', classification: 'platform_managed', capability: { kind: 'platform', runnerId: null, provider: null, component: 'stranded_gate', workspaceId: 'ws-x' } })];
});
afterAll(() => {
  if (original === undefined) delete process.env[PLATFORM_ADMIN_ENV];
  else process.env[PLATFORM_ADMIN_ENV] = original;
});

describe('AC-4: only the platform owner reads root causes', () => {
  const refusals: Array<[string, () => NextRequest]> = [
    ['a team API key, even at admin level', () => req({ key: 'bld_team_admin' })],
    ['a team worker key', () => req({ key: 'bld_team_worker' })],
    ['a non-operator browser session', () => req({ cookie: 'authjs.session-token=abc' })],
    ['an unknown key', () => req({ key: 'bld_nope' })],
    ['no credential', () => req()],
  ];
  for (const [name, make] of refusals) {
    it(`refuses ${name} with the same 404 as an unknown path, and reads nothing`, async () => {
      const res = await GET(make());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(listCalls).toHaveLength(0);
    });
  }

  it('refuses the owner key too when the platform allowlist is unset', async () => {
    delete process.env[PLATFORM_ADMIN_ENV];
    expect((await GET(req({ key: 'bld_owner' }))).status).toBe(404);
    expect(listCalls).toHaveLength(0);
  });
});

describe('the owner\'s read', () => {
  it('returns every team\'s root causes, with other teams\' work as a count only', async () => {
    const res = await GET(req({ key: 'bld_owner' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(listCalls[0]).toMatchObject({ teamIds: null, limit: 200 });
    const [own, other] = body.rootCauses;
    expect(own).toMatchObject({ own: true, team: 'Team A', teamId: OWN_TEAM, affectedTaskIds: ['task-1', 'task-2'], affectedTaskCount: 2, classification: 'credential_expired' });
    expect(other).toMatchObject({ own: false, teamId: OTHER_TEAM, affectedTaskIds: [], affectedTaskCount: 2, classification: 'platform_managed' });
    expect(other.team).toStartWith('Team ');
    expect(other.team).not.toContain(OTHER_TEAM);
  });

  it('carries no operator state', async () => {
    const body = await (await GET(req({ key: 'bld_owner' }))).json();
    for (const r of body.rootCauses) {
      for (const field of ['severity', 'status', 'acknowledgedAt', 'resolvedAt', 'linkedFixTaskId', 'verdict', 'lastAlertedAt', 'signature']) {
        expect(r).not.toHaveProperty(field);
      }
    }
  });

  it('narrows to one team and passes the window through', async () => {
    await GET(req({ key: 'bld_owner', query: `?teamId=${OWN_TEAM}&window=24h&limit=10` }));
    expect(listCalls[0]).toMatchObject({ teamIds: [OWN_TEAM], limit: 10 });
    expect(Date.now() - listCalls[0].since.getTime()).toBeLessThan(86_400_000 + 60_000);
  });

  it('rejects a bad window', async () => {
    expect((await GET(req({ key: 'bld_owner', query: '?window=90d' }))).status).toBe(400);
  });
});
