import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';

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
  pickRegistryRow,
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

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A, 'agent');
    expect(entry.model).toBe(TIER_DEFAULTS.standard.model);
    expect(entry.provider).toBe('anthropic');
    expect(entry.source).toBe('default');
  });

  it('uses team default when workspace override is absent', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'standard', provider: 'anthropic', model: 'team-model', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A, 'agent');
    expect(entry.model).toBe('team-model');
    expect(entry.source).toBe('team');
  });

  it('workspace override wins over team default', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'standard', provider: 'anthropic', model: 'team-model', defaultEffort: null, defaultMaxTurns: null },
      { teamId: TEAM_A, workspaceId: WS_A, tier: 'standard', provider: 'anthropic', model: 'ws-model', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A, 'agent');
    expect(entry.model).toBe('ws-model');
    expect(entry.source).toBe('workspace');
  });

  it('propagates defaultEffort and defaultMaxTurns from registry', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'premium', provider: 'anthropic', model: 'some-opus', defaultEffort: 'high', defaultMaxTurns: 50 },
    ]);
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null, 'agent');
    expect(entry.defaultEffort).toBe('high');
    expect(entry.defaultMaxTurns).toBe(50);
  });

  it('stores openrouter provider entry without error', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: null, tier: 'budget', provider: 'openrouter', model: 'mistralai/mistral-large', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('budget', TEAM_A, null, 'agent');
    expect(entry.provider).toBe('openrouter');
    expect(entry.model).toBe('mistralai/mistral-large');
    expect(entry.source).toBe('team');
  });

  it('caches results and avoids redundant DB calls', async () => {
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: WS_A, tier: 'standard', provider: 'anthropic', model: 'cached-model', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    await resolveTierEntry('standard', TEAM_A, WS_A, 'agent');
    await resolveTierEntry('standard', TEAM_A, WS_A, 'agent'); // should hit cache

    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('falls back gracefully when DB throws', async () => {
    mockFindMany.mockRejectedValue(new Error('DB unavailable'));
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('premium', TEAM_A, WS_A, 'agent');
    expect(entry.model).toBe(TIER_DEFAULTS.premium.model);
    expect(entry.source).toBe('default');
  });
});

// ── resolveTierEntry — live catalog fallback ───────────────────────────────
//
// No registry row pinning a tier is the DEFAULT state for most teams — this
// is the self-healing path: a same-band release is adopted without a deploy
// or a registry write, but only if it was released no later than the newest
// model in MODEL_MIN_CLI_VERSION. Anything newer needs a floor row (a code
// change, so a deploy) before the catalog will pick it.

describe('resolveTierEntry — catalog fallback', () => {
  it('resolves to the newer in-band model when the catalog has one and no row pins the tier', async () => {
    mockFindMany.mockResolvedValue([]); // no registry row for premium
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      catalogEntry({ id: 'claude-opus-5', created: 1_780_000_000, input: 5 }),
      catalogEntry({ id: 'claude-opus-5-5', created: 1_780_000_000 + 86_400 * 30, input: 6 }),
    ]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null, 'agent');
    expect(entry.model).toBe('claude-opus-5-5');
    expect(entry.provider).toBe('anthropic');
    expect(entry.source).toBe('catalog');
  });

  it('falls back to TIER_DEFAULTS when the catalog is empty and no row pins the tier', async () => {
    mockFindMany.mockResolvedValue([]);
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null, 'agent');
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

    const entry = await resolveTierEntry('premium', TEAM_A, null, 'agent');
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
    const stale = await resolveTierEntry('premium-plus', TEAM_A, null, 'agent', '2.1.200');
    expect(stale.model).toBe('claude-mythos-5');
    expect(stale.source).toBe('catalog');

    invalidateTierCache(TEAM_A, null);

    // At/above the floor: the newest release is servable and wins normally.
    const current = await resolveTierEntry('premium-plus', TEAM_A, null, 'agent', '2.1.251');
    expect(current.model).toBe('claude-fable-5-1');
  });

  it('a catalog release newer than every model in the floor table is not picked — falls back to the newest recorded one', async () => {
    mockFindMany.mockResolvedValue([]);
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      catalogEntry({ id: 'claude-opus-5-5', created: 1_780_000_000, input: 6 }),
      // Unknown to MODEL_MIN_CLI_VERSION and newer than its newest entry: its
      // CLI floor is unknown, so an old runner would 400 on every attempt.
      catalogEntry({ id: 'claude-opus-99', created: 1_780_000_000 + 86_400 * 30, input: 6 }),
    ]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium', TEAM_A, null, 'agent', '2.1.280');
    expect(entry.model).toBe('claude-opus-5-5');
    expect(entry.source).toBe('catalog');
  });

  it('warns once, naming the refused id and the floor table, when a newer release is held back', async () => {
    mockFindMany.mockResolvedValue([]);
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      catalogEntry({ id: 'claude-opus-5-5', created: 1_780_000_000, input: 6 }),
      catalogEntry({ id: 'claude-opus-98', created: 1_780_000_000 + 86_400 * 30, input: 6 }),
    ]));
    invalidateTierCache(TEAM_A, null);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await resolveTierEntry('premium', TEAM_A, null, 'agent', '2.1.280');
      await resolveTierEntry('premium', TEAM_A, null, 'agent', '2.1.280');
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('claude-opus-98'));
      expect(hits).toHaveLength(1);
      expect(String(hits[0][0])).toContain('MODEL_MIN_CLI_VERSION');
    } finally {
      warn.mockRestore();
    }
  });

  it('an unparseable/missing runner CLI version fails open — no filtering applied', async () => {
    mockFindMany.mockResolvedValue([]);
    mockGetCachedOpenRouterCatalog.mockReturnValue(Promise.resolve([
      catalogEntry({ id: 'claude-fable-5-1', created: 1_780_000_000, input: 10 }),
    ]));
    invalidateTierCache(TEAM_A, null);

    const entry = await resolveTierEntry('premium-plus', TEAM_A, null, 'agent', undefined);
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

    await resolveTierEntry('standard', TEAM_A, WS_A, 'agent');
    expect(mockFindMany).toHaveBeenCalledTimes(1);

    // Simulate registry update — cache invalidated, new model returned
    mockFindMany.mockResolvedValue([
      { teamId: TEAM_A, workspaceId: WS_A, tier: 'standard', provider: 'anthropic', model: 'v2', defaultEffort: null, defaultMaxTurns: null },
    ]);
    invalidateTierCache(TEAM_A, WS_A);

    const entry = await resolveTierEntry('standard', TEAM_A, WS_A, 'agent');
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

    const all = await resolveAllTiers(TEAM_A, null, 'agent');
    expect(all.premium.model).toBe(TIER_DEFAULTS.premium.model);
    expect(all.standard.model).toBe(TIER_DEFAULTS.standard.model);
    expect(all.budget.model).toBe(TIER_DEFAULTS.budget.model);
  });
});

// ── surface rows ────────────────────────────────────────────────────────────
//
// Order: workspace+surface → workspace → team+surface → team → catalog →
// TIER_DEFAULTS. A row with surface NULL serves both surfaces.

const row = (workspaceId: string | null, surface: 'agent' | 'chat' | null, model: string) => ({
  teamId: TEAM_A, workspaceId, surface, tier: 'standard', provider: 'anthropic', model, defaultEffort: null, defaultMaxTurns: null,
});

describe('pickRegistryRow — surface precedence', () => {
  const all = [
    row(null, null, 'team'),
    row(null, 'agent', 'team-agent'),
    row(WS_A, null, 'ws'),
    row(WS_A, 'agent', 'ws-agent'),
  ];

  it('workspace+surface wins over everything', () => {
    expect(pickRegistryRow(all, WS_A, 'agent')?.model).toBe('ws-agent');
  });

  it('a workspace shared row wins over a team surface row', () => {
    expect(pickRegistryRow(all, WS_A, 'chat')?.model).toBe('ws');
  });

  it('team+surface wins over the team shared row', () => {
    expect(pickRegistryRow(all, null, 'agent')?.model).toBe('team-agent');
  });

  it('a surface with no row of its own falls back to the NULL row', () => {
    expect(pickRegistryRow(all, null, 'chat')?.model).toBe('team');
  });

  it('workspace with no rows of its own reaches team+surface before team', () => {
    expect(pickRegistryRow(all, 'other-ws', 'agent')?.model).toBe('team-agent');
  });

  it('null surface reads only shared rows', () => {
    expect(pickRegistryRow(all, null, null)?.model).toBe('team');
    expect(pickRegistryRow(all, WS_A, null)?.model).toBe('ws');
  });

  it('rows without a surface field (pre-migration shape) read as shared', () => {
    const legacy = [{ workspaceId: null, model: 'legacy' }];
    expect(pickRegistryRow(legacy, null, 'chat')?.model).toBe('legacy');
    expect(pickRegistryRow(legacy, null, 'agent')?.model).toBe('legacy');
  });

  it('a surface row alone does not serve the other surface or the shared view', () => {
    const only = [row(null, 'agent', 'team-agent')];
    expect(pickRegistryRow(only, null, 'chat')).toBeUndefined();
    expect(pickRegistryRow(only, null, null)).toBeUndefined();
  });
});

describe('resolveTierEntry — split tier', () => {
  it('an agent claim and a chat call resolve different models when the tier is split', async () => {
    mockFindMany.mockResolvedValue([
      row(null, null, 'shared-model'),
      row(null, 'agent', 'agent-model'),
      row(null, 'chat', 'chat-model'),
    ]);

    const agent = await resolveTierEntry('standard', TEAM_A, WS_A, 'agent');
    const chat = await resolveTierEntry('standard', TEAM_A, WS_A, 'chat');
    expect(agent).toMatchObject({ model: 'agent-model', source: 'team', surface: 'agent' });
    expect(chat).toMatchObject({ model: 'chat-model', source: 'team', surface: 'chat' });
  });

  it('a surface with no row falls back to the NULL row, unannotated', async () => {
    mockFindMany.mockResolvedValue([
      row(null, null, 'shared-model'),
      row(null, 'agent', 'agent-model'),
    ]);

    const chat = await resolveTierEntry('standard', TEAM_A, null, 'chat');
    expect(chat.model).toBe('shared-model');
    expect(chat.surface).toBeUndefined();
  });

  it('caches the team document once, and one surface never serves the other its entry', async () => {
    mockFindMany.mockResolvedValue([
      row(null, 'agent', 'agent-model'),
      row(null, 'chat', 'chat-model'),
    ]);

    expect((await resolveTierEntry('standard', TEAM_A, null, 'agent')).model).toBe('agent-model');
    expect((await resolveTierEntry('standard', TEAM_A, null, 'chat')).model).toBe('chat-model');
    expect((await resolveTierEntry('standard', TEAM_A, null, 'agent')).model).toBe('agent-model');
    // One load: the cache holds the team's rows (its policy document), and the
    // surface is applied by the resolver on every read.
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('a team write flushes cached workspace entries too', async () => {
    mockFindMany.mockResolvedValue([row(null, null, 'v1')]);
    expect((await resolveTierEntry('standard', TEAM_A, WS_A, 'agent')).model).toBe('v1');

    mockFindMany.mockResolvedValue([row(null, null, 'v2')]);
    invalidateTierCache(TEAM_A, null);
    expect((await resolveTierEntry('standard', TEAM_A, WS_A, 'agent')).model).toBe('v2');
  });
});
