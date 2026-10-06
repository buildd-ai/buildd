import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * Tier pool admin routes (docs/design/tier-model-pools.md). The SQL of each
 * write is asserted in packages/core/__tests__/tier-pool-admin.test.ts; here
 * the guardrails and wiring: who may write, premium-plus refused, chat arms
 * need a key, the base is pinned before the first challenger, stale screens
 * get 409, and the draw cache is flushed after a write.
 */

let role: string | null = 'admin';
let user: { id: string } | null = { id: 'user-1' };
let tierEntry: any = { provider: 'anthropic', model: 'claude-sonnet-5', source: 'team' };
let cred: any = { key: 'k', scope: 'team' };
let addResult: any = { ok: true, armId: 'arm-2' };
let writeVersion: number | null = 5;
let removeVersion: number | null = 6;
let registryRow: any = null;
let changes: any[] = [];
const calls: Record<string, any[]> = {};
const log = (k: string) => (...a: any[]) => { (calls[k] ??= []).push(a); };

const POOL = {
  pool: { id: 'pool-1', tier: 'standard', surface: 'chat', mode: 'split', allocation: { inc: 1, ch: 0 }, weights: { inc: 'high', ch: 'off' }, allocationVersion: 4, incumbentFloor: 0.6, explorationCap: 0.3 },
  arms: [
    { id: 'inc', role: 'incumbent', status: 'active', route: 'anthropic', model: 'claude-sonnet-5', addedAt: new Date('2026-01-01') },
    { id: 'ch', role: 'challenger', status: 'active', route: 'openrouter', model: 'qwen/qwen3-coder', addedAt: new Date('2026-01-02') },
  ],
};

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => role }));
mock.module('@buildd/core/model-catalog-cache', () => ({ getCachedOpenRouterCatalog: async () => [] }));
mock.module('@buildd/core/model-tier-registry', () => ({
  resolveAllTiers: async () => ({}),
  resolveTierEntry: async () => tierEntry,
  invalidateTierCache: log('invalidateTierCache'),
}));
mock.module('@buildd/core/inference-keys', () => ({
  resolveInferenceCredential: async (o: any) => { log('cred')(o); return cred; },
  isInferenceKeyProvider: (p: string) => ['anthropic', 'openai', 'openrouter'].includes(p),
}));
mock.module('@buildd/core/tier-pool-admin', () => ({
  listTeamPools: async () => [],
  loadArmStats: async () => new Map(),
  ensurePool: async (a: any) => { log('ensurePool')(a); return { pool: { id: 'pool-1' }, arms: [] }; },
  addChallenger: async (a: any) => { log('addChallenger')(a); return addResult; },
  loadPool: async () => POOL,
  writeAllocation: async (a: any) => { log('writeAllocation')(a); return writeVersion; },
  removeChallenger: async (a: any) => { log('removeChallenger')(a); return removeVersion; },
  listPoolChanges: async () => changes,
}));
mock.module('@buildd/core/tier-pool-source', () => ({
  invalidateTierPoolCache: log('invalidatePool'),
  orderArms: (a: any[]) => [...a].sort((x, y) => (x.role === 'incumbent' ? 0 : 1) - (y.role === 'incumbent' ? 0 : 1)),
}));
mock.module('@buildd/core/tier-pool-daily-source', () => ({
  loadPoolEvidence: async (p: any) => new Map(p.arms.map((a: any) => [a.id, { graded: 0, successes: 0, failures: 0, earlyCritical: 0, spread: { units: 0, conversations: 0, users: 0 } }])),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null }, modelTierRegistry: { findFirst: async () => registryRow } },
    insert: () => ({ values: async (v: any) => { log('registryInsert')(v); } }),
  },
}));

const pools = await import('./route');
const poolById = await import('./[id]/route');
const arm = await import('./[id]/arms/[armId]/route');

const req = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
});
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const add = (body: Record<string, unknown>) => pools.POST(req('/api/model-tiers/pools', 'POST', { teamId: 'team-1', tier: 'standard', surface: 'chat', route: 'openrouter', model: 'qwen/qwen3-coder', ...body }));

beforeEach(() => {
  role = 'admin'; user = { id: 'user-1' };
  tierEntry = { provider: 'anthropic', model: 'claude-sonnet-5', source: 'team' };
  cred = { key: 'k', scope: 'team' };
  addResult = { ok: true, armId: 'arm-2' };
  writeVersion = 5; removeVersion = 6; registryRow = null; changes = [];
  POOL.pool.mode = 'split';
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('POST /api/model-tiers/pools — add a model', () => {
  it('creates the pool with the registry model as base and adds the challenger', async () => {
    const res = await add({});
    expect(res.status).toBe(201);
    expect(calls.ensurePool[0][0]).toMatchObject({ teamId: 'team-1', tier: 'standard', surface: 'chat', incumbent: { route: 'anthropic', model: 'claude-sonnet-5' }, actorUserId: 'user-1' });
    expect(calls.addChallenger[0][0]).toMatchObject({ poolId: 'pool-1', route: 'openrouter', model: 'qwen/qwen3-coder' });
    expect(calls.invalidatePool).toHaveLength(1);
    expect(calls.registryInsert).toBeUndefined();
  });

  it('pins the base first when the tier was following the catalog', async () => {
    tierEntry = { provider: 'anthropic', model: 'claude-sonnet-5', source: 'catalog' };
    await add({});
    expect(calls.registryInsert[0][0]).toMatchObject({ teamId: 'team-1', tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-5', workspaceId: null });
  });

  it('refuses premium-plus, members, a wrong route for the surface, and a chat route with no key', async () => {
    expect((await add({ tier: 'premium-plus' })).status).toBe(400);
    expect((await add({ surface: 'agent' })).status).toBe(400);
    cred = null;
    expect((await add({})).status).toBe(400);
    cred = { key: 'k' };
    role = 'member';
    expect((await add({})).status).toBe(403);
    role = null;
    expect((await add({})).status).toBe(404);
    expect(calls.addChallenger).toBeUndefined();
  });

  it('agent arms take runner routes and need no API key', async () => {
    cred = null;
    const res = await add({ surface: 'agent', route: 'runner:claude', model: 'claude-opus-5' });
    expect(res.status).toBe(201);
    expect(calls.ensurePool[0][0].incumbent).toEqual({ route: 'runner:claude', model: 'claude-sonnet-5' });
  });

  it('409s a fifth model, a duplicate, and the base model itself', async () => {
    addResult = { ok: false, reason: 'full' };
    expect((await add({})).status).toBe(409);
    addResult = { ok: false, reason: 'duplicate' };
    expect((await add({})).status).toBe(409);
    expect((await add({ route: 'anthropic', model: 'claude-sonnet-5' })).status).toBe(409);
  });
});

describe('PATCH /api/model-tiers/pools/[id] — traffic', () => {
  const patch = (body: Record<string, unknown>) => poolById.PATCH(req('/api/model-tiers/pools/pool-1', 'PATCH', { teamId: 'team-1', expectedVersion: 4, ...body }), ctx({ id: 'pool-1' }));

  it('derives the allocation from weights and flushes the draw cache', async () => {
    const res = await patch({ weights: { ch: 'low' }, mode: 'split' });
    expect(res.status).toBe(200);
    expect(calls.writeAllocation[0][0]).toMatchObject({
      teamId: 'team-1', poolId: 'pool-1', expectedVersion: 4,
      allocation: { inc: 0.75, ch: 0.25 }, weights: { inc: 'high', ch: 'low' },
      mode: 'split', kind: 'allocation', actorUserId: 'user-1',
    });
    expect(calls.invalidatePool).toHaveLength(1);
  });

  it('accepts a split that crosses the old 60% floor — the admin\'s weights are final', async () => {
    const res = await patch({ weights: { inc: 'off', ch: 'high' } });
    expect(res.status).toBe(200);
    expect(calls.writeAllocation[0][0]).toMatchObject({ allocation: { inc: 0, ch: 1 } });
  });

  it('rejects a weight level that is not off/low/med/high', async () => {
    const res = await patch({ weights: { ch: 'medium' } });
    expect(res.status).toBe(400);
    expect(calls.writeAllocation).toBeUndefined();
  });

  it('rejects a weight for an arm that is not in the pool', async () => {
    const res = await patch({ weights: { ghost: 'low' } });
    expect(res.status).toBe(400);
    expect(calls.writeAllocation).toBeUndefined();
  });

  it('pins without touching the saved split', async () => {
    await patch({ mode: 'pinned' });
    expect(calls.writeAllocation[0][0]).toMatchObject({ mode: 'pinned', kind: 'mode', allocation: { inc: 1, ch: 0 } });
  });

  it('a stale screen gets 409', async () => {
    writeVersion = null;
    expect((await patch({ mode: 'pinned' })).status).toBe(409);
  });

  it('explore projects the current split onto stage bounds: a new challenger learns at 10%', async () => {
    POOL.pool.allocation = { inc: 1, ch: 0 };
    const res = await patch({ mode: 'explore' });
    expect(res.status).toBe(200);
    expect(calls.writeAllocation[0][0]).toMatchObject({ mode: 'explore', kind: 'mode', allocation: { inc: 0.9, ch: 0.1 }, actorUserId: 'user-1' });
  });

  it('an explore pool takes no typed allocation', async () => {
    POOL.pool.mode = 'explore';
    expect((await patch({ allocation: { inc: 0.9, ch: 0.1 } })).status).toBe(400);
    POOL.pool.mode = 'split';
    expect((await patch({ allocation: { inc: 0.9, ch: 0.1 }, mode: 'explore' })).status).toBe(400);
    expect(calls.writeAllocation).toBeUndefined();
  });

  it('members cannot change traffic', async () => {
    role = 'member';
    expect((await patch({ mode: 'pinned' })).status).toBe(403);
  });
});

describe('GET /api/model-tiers/pools/[id] — change log', () => {
  it('never re-serves rankings: evidence (popularity priors, views, as-of) is not returned', async () => {
    changes = [{
      id: 'c1', poolId: 'pool-1', kind: 'allocation', before: { allocation: { inc: 1 } }, after: { allocation: { inc: 0.9, ch: 0.1 } },
      evidence: { arms: { ch: { prior: { signal: 'popularity', views: ['text'], asOf: '2026-09-26', m: 0.55 } } }, signals: [{ kind: 'popularity', armId: 'ch' }] },
      actorUserId: null, actorSystem: 'system:explore', createdAt: new Date('2026-09-27T06:00:00Z'),
    }];
    const res = await poolById.GET(req('/api/model-tiers/pools/pool-1?teamId=team-1', 'GET'), ctx({ id: 'pool-1' }));
    const body = await res.json();
    expect(body.changes[0]).toMatchObject({ id: 'c1', actor: 'system:explore' });
    expect(JSON.stringify(body)).not.toContain('popularity');
    expect(JSON.stringify(body)).not.toContain('asOf');
  });
});

describe('DELETE /api/model-tiers/pools/[id]/arms/[armId]', () => {
  const del = (armId: string, v = 4) => arm.DELETE(req(`/api/model-tiers/pools/pool-1/arms/${armId}?teamId=team-1&expectedVersion=${v}`, 'DELETE'), ctx({ id: 'pool-1', armId }));

  it('hands a removed challenger\'s share to the base', async () => {
    POOL.pool.allocation = { inc: 0.8, ch: 0.2 };
    const res = await del('ch');
    expect(res.status).toBe(200);
    expect(calls.removeChallenger[0][0]).toMatchObject({ armId: 'ch', expectedVersion: 4, allocation: { inc: 1 } });
  });

  it('cannot remove the base', async () => {
    expect((await del('inc')).status).toBe(400);
  });

  it('a stale screen gets 409', async () => {
    removeVersion = null;
    expect((await del('ch')).status).toBe(409);
  });
});
