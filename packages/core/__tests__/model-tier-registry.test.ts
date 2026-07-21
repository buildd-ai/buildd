import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── mock the DB before importing the module under test ─────────────────────
const mockFindMany = mock();

mock.module('../db/client', () => ({
  db: {
    query: {
      modelTierRegistry: {
        findMany: mockFindMany,
      },
    },
  },
}));

mock.module('../db/schema', () => ({
  modelTierRegistry: { teamId: 'team_id', tier: 'tier', workspaceId: 'workspace_id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  isNull: (col: any) => ({ type: 'isNull', col }),
}));

// ── import after mocks are in place ───────────────────────────────────────
const {
  resolveTierEntry,
  resolveTierEntrySync,
  invalidateTierCache,
  mapRouterAlias,
  resolveAllTiers,
  TIER_DEFAULTS,
} = await import('../model-tier-registry');

const TEAM_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const WS_A   = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(() => {
  mockFindMany.mockReset();
  // Invalidate cache between tests so they don't bleed into each other
  invalidateTierCache(TEAM_A, WS_A);
  invalidateTierCache(TEAM_A, null);
});

// ── mapRouterAlias ─────────────────────────────────────────────────────────

describe('mapRouterAlias', () => {
  it('maps opus → premium', () => expect(mapRouterAlias('opus')).toBe('premium'));
  it('maps sonnet → standard', () => expect(mapRouterAlias('sonnet')).toBe('standard'));
  it('maps haiku → budget', () => expect(mapRouterAlias('haiku')).toBe('budget'));
  it('maps unknown → standard (safe fallback)', () => expect(mapRouterAlias('anything')).toBe('standard'));
});

// ── TIER_DEFAULTS sanity ───────────────────────────────────────────────────

describe('TIER_DEFAULTS', () => {
  it('has entries for all three tiers', () => {
    expect(TIER_DEFAULTS.premium.model).toBeTruthy();
    expect(TIER_DEFAULTS.standard.model).toBeTruthy();
    expect(TIER_DEFAULTS.budget.model).toBeTruthy();
  });

  it('all defaults are anthropic provider', () => {
    expect(TIER_DEFAULTS.premium.provider).toBe('anthropic');
    expect(TIER_DEFAULTS.standard.provider).toBe('anthropic');
    expect(TIER_DEFAULTS.budget.provider).toBe('anthropic');
  });
});

// ── resolveTierEntry — resolution chain ───────────────────────────────────

describe('resolveTierEntry', () => {
  it('falls back to code defaults when no DB rows exist', async () => {
    mockFindMany.mockResolvedValue([]);

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A);
    expect(entry.model).toBe(TIER_DEFAULTS.standard.model);
    expect(entry.provider).toBe('anthropic');
    expect(entry.source).toBe('default');
  });

  it('uses team default when workspace override is absent', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'standard', provider: 'anthropic', model: 'team-model', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A);
    expect(entry.model).toBe('team-model');
    expect(entry.source).toBe('team');
  });

  it('workspace override wins over team default', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'standard', provider: 'anthropic', model: 'team-model', defaultEffort: null, defaultMaxTurns: null },
      { teamId: TEAM_A, workspaceId: WS_A, tier: 'standard', provider: 'anthropic', model: 'ws-model', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A);
    expect(entry.model).toBe('ws-model');
    expect(entry.source).toBe('workspace');
  });

  it('propagates defaultEffort and defaultMaxTurns from registry', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'premium', provider: 'anthropic', model: 'some-opus', defaultEffort: 'high', defaultMaxTurns: 50 },
    ]);
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null);
    expect(entry.defaultEffort).toBe('high');
    expect(entry.defaultMaxTurns).toBe(50);
  });

  it('stores openrouter provider entry without error', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'budget', provider: 'openrouter', model: 'mistralai/mistral-large', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('budget', TEAM_A, null);
    expect(entry.provider).toBe('openrouter');
    expect(entry.model).toBe('mistralai/mistral-large');
    expect(entry.source).toBe('team');
  });

  it('caches results and avoids redundant DB calls', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: WS_A, tier: 'standard', provider: 'anthropic', model: 'cached-model', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    await resolveTierEntry('standard', TEAM_A, WS_A);
    await resolveTierEntry('standard', TEAM_A, WS_A); // should hit cache

    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('falls back gracefully when DB throws', async () => {
    mockFindMany.mockRejectedValue(new Error('DB unavailable'));
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('premium', TEAM_A, WS_A);
    expect(entry.model).toBe(TIER_DEFAULTS.premium.model);
    expect(entry.source).toBe('default');
  });
});

// ── invalidateTierCache ────────────────────────────────────────────────────

describe('invalidateTierCache', () => {
  it('forces a new DB call after cache invalidation', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: WS_A, tier: 'standard', provider: 'anthropic', model: 'v1', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    await resolveTierEntry('standard', TEAM_A, WS_A);
    expect(mockFindMany).toHaveBeenCalledTimes(1);

    // Simulate registry update — cache invalidated, new model returned
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: WS_A, tier: 'standard', provider: 'anthropic', model: 'v2', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A);
    expect(entry.model).toBe('v2');
    expect(mockFindMany).toHaveBeenCalledTimes(2);
  });
});

// ── resolveTierEntrySync ────────────────────────────────────────────────────

describe('resolveTierEntrySync', () => {
  it('returns TIER_DEFAULTS without any DB call', () => {
    const entry = resolveTierEntrySync('premium');
    expect(entry.model).toBe(TIER_DEFAULTS.premium.model);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns budget defaults', () => {
    const entry = resolveTierEntrySync('budget');
    expect(entry.provider).toBe('anthropic');
    expect(entry.model).toBe(TIER_DEFAULTS.budget.model);
  });
});

// ── resolveAllTiers ─────────────────────────────────────────────────────────

describe('resolveAllTiers', () => {
  it('returns all three tiers resolved', async () => {
    mockFindMany.mockResolvedValue([]);
    invalidateTierCache(TEAM_A, null);

    const all = await resolveAllTiers(TEAM_A);
    expect(all.premium.model).toBe(TIER_DEFAULTS.premium.model);
    expect(all.standard.model).toBe(TIER_DEFAULTS.standard.model);
    expect(all.budget.model).toBe(TIER_DEFAULTS.budget.model);
  });
});
