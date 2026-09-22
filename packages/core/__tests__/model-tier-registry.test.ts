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

// getCachedOpenRouterCatalog is mocked so tests control the fixture directly;
// pickTierModel and checkModelClientCapability are the REAL implementations —
// only the network/DB-backed edges are mocked, so these tests exercise the
// actual price-band + capability-filter logic end to end.
const mockGetCachedOpenRouterCatalog = mock(() => Promise.resolve([] as any[]));
mock.module('../model-catalog-cache', () => ({
  getCachedOpenRouterCatalog: mockGetCachedOpenRouterCatalog,
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

const catalogEntry = (overrides: Partial<Record<string, unknown>>) => ({
  canonicalId: null,
  openRouterId: `anthropic/${overrides.id}`,
  provider: 'anthropic',
  displayName: String(overrides.id),
  contextLength: 1_000_000,
  created: 1_780_000_000,
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
  ...overrides,
});

beforeEach(() => {
  mockFindMany.mockReset();
  mockGetCachedOpenRouterCatalog.mockReset();
  mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([]));
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

// ── resolveTierEntry — live catalog fallback ───────────────────────────────
//
// No registry row pinning a tier is the DEFAULT state for most teams — this
// is the self-healing path: a newer same-band release is adopted without a
// deploy or an explicit registry write.

describe('resolveTierEntry — catalog fallback', () => {
  it('resolves to the newer in-band model when the catalog has one and no row pins the tier', async () => {
    mockFindMany.mockResolvedValue([]); // no registry row for premium
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      catalogEntry({ id: 'claude-opus-5', created: 1_780_000_000, input: 5 }),
      catalogEntry({ id: 'claude-opus-5-5', created: 1_780_000_000 + 86_400 * 30, input: 6 }),
    ]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null);
    expect(entry.model).toBe('claude-opus-5-5');
    expect(entry.provider).toBe('anthropic');
    expect(entry.source).toBe('catalog');
  });

  it('falls back to TIER_DEFAULTS when the catalog is empty and no row pins the tier', async () => {
    mockFindMany.mockResolvedValue([]);
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null);
    expect(entry.model).toBe(TIER_DEFAULTS.premium.model);
    expect(entry.source).toBe('default');
  });

  it('an explicit registry row still wins over a newer catalog pick', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'premium', provider: 'anthropic', model: 'pinned-opus', defaultEffort: null, defaultMaxTurns: null },
    ]);
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      catalogEntry({ id: 'claude-opus-5-5', created: 1_780_000_000 + 86_400 * 30, input: 6 }),
    ]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null);
    expect(entry.model).toBe('pinned-opus');
    expect(entry.source).toBe('team');
    // The row alone settles it — the catalog is never even consulted.
    expect(mockGetCachedOpenRouterCatalog).not.toHaveBeenCalled();
  });

  it('a claiming runner whose CLI predates the newest release falls back to the previous in-band model, not a deferral', async () => {
    mockFindMany.mockResolvedValue([]); // no registry row for premium-plus
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      // An older premium-plus release with no CLI version floor.
      catalogEntry({ id: 'claude-mythos-5', created: 1_780_000_000, input: 9 }),
      // claude-fable-5-1 IS TIER_DEFAULTS.premium-plus and carries a real
      // MODEL_MIN_CLI_VERSION floor (2.1.251) — using the real model here
      // exercises the real capability map instead of a synthetic one.
      catalogEntry({ id: 'claude-fable-5-1', created: 1_780_000_000 + 86_400 * 30, input: 10 }),
    ]));
    invalidateTierCache(TEAM_A, null);

    // Below the floor: falls back to the older, servable release.
    const stale = await resolveTierEntry('premium-plus', TEAM_A, null, '2.1.200');
    expect(stale.model).toBe('claude-mythos-5');
    expect(stale.source).toBe('catalog');

    invalidateTierCache(TEAM_A, null);

    // At/above the floor: the newest release is servable and wins normally.
    const current = await resolveTierEntry('premium-plus', TEAM_A, null, '2.1.251');
    expect(current.model).toBe('claude-fable-5-1');
  });

  it('an unparseable/missing runner CLI version fails open — no filtering applied', async () => {
    mockFindMany.mockResolvedValue([]);
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      catalogEntry({ id: 'claude-fable-5-1', created: 1_780_000_000, input: 10 }),
    ]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium-plus', TEAM_A, null, undefined);
    expect(entry.model).toBe('claude-fable-5-1');
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
