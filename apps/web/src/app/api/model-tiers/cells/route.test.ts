import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * The model policy cells route: the team read model and the dial write.
 * The dial's decisions are covered in packages/core/__tests__/tier-dial.test.ts;
 * here the wiring: who may write, validation, shadow-first on a new dial,
 * dial 1 back to the primary, stale screens get 409, and the draw cache flush.
 */

let role: string | null = 'admin';
let user: { id: string } | null = { id: 'user-1' };
let found: any = null;
let writeVersion: number | null = 7;
const calls: Record<string, any[]> = {};
const log = (k: string) => (...a: any[]) => { (calls[k] ??= []).push(a); };

const CELLS = { teamId: 'team-1', generatedAt: '2026-10-06T00:00:00.000Z', windowDays: 30, cells: [] };

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => role }));
mock.module('@/lib/permissions', () => ({
  roleHas: (r: string) => r === 'admin' || r === 'owner',
  getTeamPermissionOverrides: async () => null,
}));
mock.module('@buildd/core/tier-pool-admin', () => ({
  findTeamPool: async (...a: any[]) => { log('findTeamPool')(...a); return found; },
}));
mock.module('@buildd/core/tier-dial-source', () => ({
  buildModelPolicyCells: async (teamId: string) => ({ ...CELLS, teamId }),
  writeDialState: async (a: any) => { log('writeDialState')(a); return writeVersion; },
}));
mock.module('@buildd/core/tier-pool-source', () => ({
  invalidateTierPoolCache: log('invalidatePool'),
  readDialState: (raw: any) => (raw && raw.state ? raw : null),
}));

const { GET, PATCH } = await import('./route');

const arms = [
  { id: 'inc', role: 'incumbent', status: 'active', route: 'runner:claude', model: 'primary-model', addedAt: new Date('2026-01-01') },
  { id: 'alt', role: 'challenger', status: 'active', route: 'runner:claude', model: 'cheap-model', addedAt: new Date('2026-01-02') },
];
const poolRow = (over: Record<string, unknown> = {}) => ({
  pool: { id: 'pool-1', tier: 'standard', surface: 'agent', mode: 'split', allocation: { inc: 0.5, alt: 0.5 }, allocationVersion: 6, dial: 3, dialState: null, ...over },
  arms,
});

const patch = (body: Record<string, unknown>) => PATCH(new NextRequest('http://localhost/api/model-tiers/cells', {
  method: 'PATCH', body: JSON.stringify({ teamId: 'team-1', tier: 'standard', surface: 'agent', expectedVersion: 6, ...body }),
}));

beforeEach(() => {
  role = 'admin';
  user = { id: 'user-1' };
  found = poolRow();
  writeVersion = 7;
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('GET /api/model-tiers/cells', () => {
  it('returns the team read model to a member', async () => {
    role = 'member';
    const res = await GET(new NextRequest('http://localhost/api/model-tiers/cells?teamId=team-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ teamId: 'team-1', windowDays: 30, cells: [], isAdmin: false });
  });

  it('refuses without a session', async () => {
    user = null;
    expect((await GET(new NextRequest('http://localhost/api/model-tiers/cells?teamId=team-1'))).status).toBe(401);
  });
});

describe('PATCH /api/model-tiers/cells', () => {
  it('only an admin may turn the dial', async () => {
    role = 'member';
    expect((await patch({ dial: 3 })).status).toBe(403);
    expect(calls.writeDialState).toBeUndefined();
  });

  it('validates tier, surface and dial', async () => {
    expect((await patch({ dial: 0 })).status).toBe(400);
    expect((await patch({ dial: 3, tier: 'premium-plus' })).status).toBe(400);
    expect((await patch({ dial: 3, surface: 'email' })).status).toBe(400);
    expect((await patch({ dial: 3, expectedVersion: undefined })).status).toBe(400);
  });

  it('a cell with no alternates yet is a 409, nothing written', async () => {
    found = null;
    const res = await patch({ dial: 3 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_alternates');
  });

  it('putting a split pool under the dial starts in shadow: all traffic on the primary', async () => {
    const res = await patch({ dial: 5 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ state: 'learning', allocation: { inc: 1, alt: 0 }, allocationVersion: 7 });
    const w = calls.writeDialState[0][0];
    expect(w).toMatchObject({ mode: 'dial', dial: 5, expectedVersion: 6, actorUserId: 'user-1' });
    expect(w.event.kind).toBe('dial');
    expect(calls.invalidatePool).toHaveLength(1);
  });

  it('dial 1 on a shifted cell returns every run to the primary, recorded', async () => {
    found = poolRow({ mode: 'dial', dialState: { state: 'shifted', since: '2026-10-01T00:00:00Z', alternateArmId: 'alt' } });
    const res = await patch({ dial: 1 });
    const body = await res.json();
    expect(body).toMatchObject({ state: 'always', allocation: { inc: 1, alt: 0 } });
    expect(calls.writeDialState[0][0].event.reason).toMatch(/always/);
  });

  it('moving the dial on a shifted cell keeps the shift and changes the share', async () => {
    found = poolRow({ mode: 'dial', dialState: { state: 'shifted', since: '2026-10-01T00:00:00Z', alternateArmId: 'alt' } });
    const body = await (await patch({ dial: 2 })).json();
    expect(body.state).toBe('shifted');
    expect(body.allocation.alt).toBeGreaterThan(0);
    expect(body.allocation.alt).toBeLessThan(0.5);
  });

  it('a stale screen gets 409', async () => {
    writeVersion = null;
    const res = await patch({ dial: 3 });
    expect(res.status).toBe(409);
    expect(calls.invalidatePool).toBeUndefined();
  });
});
