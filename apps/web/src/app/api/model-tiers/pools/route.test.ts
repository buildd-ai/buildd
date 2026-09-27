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
const calls: Record<string, any[]> = {};
const log = (k: string) => (...a: any[]) => { (calls[k] ??= []).push(a); };

const POOL = {
  pool: { id: 'pool-1', tier: 'standard', surface: 'chat', mode: 'split', allocation: { inc: 1, ch: 0 }, allocationVersion: 4, incumbentFloor: 0.6, explorationCap: 0.3 },
  arms: [
    { id: 'inc', role: 'incumbent', status: 'active', route: 'anthropic', model: 'claude-sonnet-5' },
    { id: 'ch', role: 'challenger', status: 'active', route: 'openrouter', model: 'qwen/qwen3-coder' },
  ],
};

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => role }));
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
  listPoolChanges: async () => [],
}));
mock.module('@buildd/core/tier-pool-source', () => ({ invalidateTierPoolCache: log('invalidatePool') }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { modelTierRegistry: { findFirst: async () => registryRow } },
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
  writeVersion = 5; removeVersion = 6; registryRow = null;
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

  it('writes a valid split with the expected version and flushes the draw cache', async () => {
    const res = await patch({ allocation: { inc: 0.8, ch: 0.2 }, mode: 'split' });
    expect(res.status).toBe(200);
    expect(calls.writeAllocation[0][0]).toMatchObject({ teamId: 'team-1', poolId: 'pool-1', expectedVersion: 4, allocation: { inc: 0.8, ch: 0.2 }, mode: 'split', kind: 'allocation', actorUserId: 'user-1' });
    expect(calls.invalidatePool).toHaveLength(1);
  });

  it('refuses a split below the base floor', async () => {
    const res = await patch({ allocation: { inc: 0.5, ch: 0.5 } });
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

  it('members cannot change traffic', async () => {
    role = 'member';
    expect((await patch({ mode: 'pinned' })).status).toBe(403);
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
