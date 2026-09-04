import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * The model catalog must not depend on `ANTHROPIC_API_KEY`.
 *
 * That env var is unset in production, so this route returned `[]` and the picker
 * told operators to "check your Anthropic API key in Settings" — a field that does
 * not exist. The tier registry now provides a credential-free floor, the live
 * catalog is additive, and `catalogComplete` reports which of the two happened.
 */

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockResolveActiveTeamId = mock(() => Promise.resolve('team-1' as string | null));
const mockResolveAnthropicAuth = mock(() => Promise.resolve(null as any));
const DEFAULT_TIERS = {
  'premium-plus': { provider: 'anthropic', model: 'claude-fable-5-1', source: 'default' },
  premium: { provider: 'anthropic', model: 'claude-opus-5', source: 'default' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'default' },
  budget: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'default' },
};
const mockResolveAllTiers = mock(() => Promise.resolve(DEFAULT_TIERS as any));
const mockFetch = mock(() => Promise.resolve(null as any));
// The public OpenRouter catalog. Mocked at module level so no test touches the
// network, and so `globalThis.fetch` assertions still speak only for Anthropic.
const mockFetchOpenRouterCatalog = mock(() => Promise.resolve([] as any[]));
const mockSetCatalogPrices = mock((_: any) => {});

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  resolveActiveTeamId: mockResolveActiveTeamId,
}));

mock.module('@/lib/claude-credential', () => ({
  resolveAnthropicAuth: mockResolveAnthropicAuth,
}));

mock.module('@buildd/core/model-tier-registry', () => ({
  resolveAllTiers: mockResolveAllTiers,
  TIERS: ['premium-plus', 'premium', 'standard', 'budget'],
}));

mock.module('@buildd/core/model-catalog', () => ({
  fetchOpenRouterCatalog: mockFetchOpenRouterCatalog,
}));

mock.module('@buildd/core/model-prices', () => ({
  setCatalogPrices: mockSetCatalogPrices,
}));

// Static import after mocks
import { GET, _resetCache } from './route';

const OAUTH_AUTH = {
  headers: { 'anthropic-version': '2023-06-01', Authorization: 'Bearer tok' },
  purpose: 'oauth_token',
  secretId: 's-1',
};

const makeAnthropicResponse = (models: { id: string; display_name?: string }[]) =>
  new Response(JSON.stringify({ data: models }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function req() {
  return new NextRequest('http://localhost/api/models');
}

describe('GET /api/models', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockResolveActiveTeamId.mockReset();
    mockResolveActiveTeamId.mockReturnValue(Promise.resolve('team-1'));
    mockResolveAnthropicAuth.mockReset();
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(null));
    mockFetch.mockReset();
    // Must be reset like every other mock: an override here used to leak into
    // all subsequent tests.
    mockResolveAllTiers.mockReset();
    mockResolveAllTiers.mockReturnValue(Promise.resolve(DEFAULT_TIERS as any));
    mockFetchOpenRouterCatalog.mockReset();
    mockFetchOpenRouterCatalog.mockReturnValue(Promise.resolve([]));
    mockSetCatalogPrices.mockReset();
    globalThis.fetch = mockFetch as any;
    _resetCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  // ── The regression this route existed to cause ─────────────────────────────

  it('regression: with no credential it still returns the team tier models', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const data = await res.json();

    // Previously []. An empty list is what produced the "check your Anthropic API
    // key in Settings" dead end.
    expect(data.models.map((m: any) => m.id)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]);
    expect(data.models[0]).toMatchObject({ tier: 'premium-plus', provider: 'anthropic' });
    // The catalog is NOT complete, so absence from this list means nothing.
    expect(data.catalogComplete).toBe(false);
    // No credential means no outbound call at all.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not call Anthropic when no credential resolves', async () => {
    await GET(req());
    expect(mockResolveAnthropicAuth).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Live catalog ───────────────────────────────────────────────────────────

  it('merges the live catalog behind the tier models and reports it complete', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
    ])));

    const data = await (await GET(req())).json();

    expect(data.catalogComplete).toBe(true);
    const ids = data.models.map((m: any) => m.id);
    // Tier models lead; catalog entries follow.
    expect(ids.slice(0, 4)).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
    expect(ids).toContain('claude-sonnet-5');
    // claude-opus-5 is in both; it appears once, keeping its tier label.
    expect(ids.filter((i: string) => i === 'claude-opus-5')).toHaveLength(1);
    expect(data.models.find((m: any) => m.id === 'claude-opus-5').tier).toBe('premium');
  });

  it('authenticates the catalog call with the resolved credential headers', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([])));

    await GET(req());

    const [, init] = mockFetch.mock.calls[0] as any[];
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('filters the catalog to claude-* excluding the claude-2 and claude-3 families', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([
      { id: 'claude-fable-5', display_name: 'Claude Fable 5' },
      { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
      { id: 'claude-2-1', display_name: 'Claude 2.1' },
      { id: 'gpt-4o', display_name: 'GPT-4o' },
    ])));

    const data = await (await GET(req())).json();
    const ids = data.models.map((m: any) => m.id);
    expect(ids).toContain('claude-fable-5');
    expect(ids).not.toContain('claude-3-5-sonnet-20241022');
    expect(ids).not.toContain('claude-2-1');
    expect(ids).not.toContain('gpt-4o');
  });

  it('sorts catalog entries newest-first', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([
      { id: 'claude-aaa-1' },
      { id: 'claude-zzz-9' },
      { id: 'claude-mmm-5' },
    ])));

    const data = await (await GET(req())).json();
    const catalogIds = data.models.filter((m: any) => !m.tier).map((m: any) => m.id);
    expect(catalogIds).toEqual([...catalogIds].sort((a: string, b: string) => b.localeCompare(a)));
  });

  // ── Degradation ────────────────────────────────────────────────────────────

  it('keeps the tier floor and reports incomplete when the API errors', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(new Response('nope', { status: 401 })));

    const data = await (await GET(req())).json();
    expect(data.models).toHaveLength(4);
    // A dead credential must not be reported as a complete catalog, or the client
    // would warn that every pinned model has been retired.
    expect(data.catalogComplete).toBe(false);
  });

  it('keeps the tier floor and reports incomplete when the fetch throws', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockImplementation(() => Promise.reject(new Error('network error')));

    const data = await (await GET(req())).json();
    expect(data.models).toHaveLength(4);
    expect(data.catalogComplete).toBe(false);
  });

  it('survives a tier registry failure', async () => {
    mockResolveAllTiers.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toEqual([]);
  });

  it('returns an empty list when the user belongs to no team', async () => {
    mockResolveActiveTeamId.mockReturnValue(Promise.resolve(null));
    const data = await (await GET(req())).json();
    expect(data.models).toEqual([]);
    expect(data.catalogComplete).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Cache ──────────────────────────────────────────────────────────────────

  it('serves the catalog from cache on a second request', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([{ id: 'claude-sonnet-5' }])));

    await GET(req());
    await GET(req());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed catalog read', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(new Response('nope', { status: 500 })));

    await GET(req());
    await GET(req());
    // Caching the failure would leave the picker degraded for 24h after a blip.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('caches per team, so one team cannot serve another team its catalog', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([{ id: 'claude-sonnet-5' }])));

    await GET(req());
    mockResolveActiveTeamId.mockReturnValue(Promise.resolve('team-2'));
    await GET(req());

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
  // ── Tier audit ─────────────────────────────────────────────────────────────
  //
  // detectStalePin (client) covers a model the USER pinned. Nothing checked the
  // team's tier CONFIG, which is how `standard` came to sit a generation behind
  // a cheaper model with no signal anywhere.

  it('flags a tier sitting behind a newer model in the same family', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
      { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
      { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
    ])));

    const data = await (await GET(req())).json();

    expect(data.tierAudit.checked).toBe(true);
    expect(data.tierAudit.superseded).toEqual([
      { tier: 'standard', model: 'claude-sonnet-4-6', newer: 'claude-sonnet-5' },
    ]);
    expect(data.tierAudit.unknown).toEqual([]);
  });

  it('flags a tier pinned to a model the API no longer returns', async () => {
    mockResolveAllTiers.mockReturnValue(Promise.resolve({
      ...DEFAULT_TIERS,
      standard: { provider: 'anthropic', model: 'claude-sonnet-retired', source: 'team' },
    } as any));
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([
      { id: 'claude-opus-5' },
      { id: 'claude-fable-5-1' },
      { id: 'claude-haiku-4-5-20251001' },
    ])));

    const data = await (await GET(req())).json();

    expect(data.tierAudit.unknown).toEqual([
      { tier: 'standard', model: 'claude-sonnet-retired' },
    ]);
  });

  // ── Public catalog (OpenRouter, no credential) ─────────────────────────────
  //
  // The reason this source exists: `auditTierModels` only ever ran where an
  // Anthropic credential was stored, which is not the OAuth deployments. The
  // public list needs no key and covers both vendors.

  const publicEntry = (id: string, provider = 'anthropic', displayName?: string) => ({
    id,
    canonicalId: null,
    openRouterId: `${provider}/${id}`,
    provider,
    displayName: displayName ?? id,
    contextLength: 1_000_000,
    created: 1_780_000_000,
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  });

  it('audits the tiers off the public catalog when there is NO credential', async () => {
    // This is the regression that mattered: no credential used to mean no audit.
    mockFetchOpenRouterCatalog.mockReturnValue(Promise.resolve([
      publicEntry('claude-sonnet-5'),
      publicEntry('claude-sonnet-4-6'),
      publicEntry('claude-opus-5'),
      publicEntry('claude-fable-5-1'),
      publicEntry('claude-haiku-4-5-20251001'),
    ]));

    const data = await (await GET(req())).json();

    expect(mockResolveAnthropicAuth).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled(); // no Anthropic call happened
    expect(data.tierAudit.checked).toBe(true);
    expect(data.tierAudit.superseded).toEqual([
      { tier: 'standard', model: 'claude-sonnet-4-6', newer: 'claude-sonnet-5' },
    ]);
  });

  it('reports the catalog as INCOMPLETE even with a public catalog loaded', async () => {
    // OpenRouter does not resell every model or any dated snapshot, so absence
    // from it cannot justify a "your pinned model is gone" warning.
    mockFetchOpenRouterCatalog.mockReturnValue(Promise.resolve([publicEntry('claude-opus-5')]));

    const data = await (await GET(req())).json();

    expect(data.catalogComplete).toBe(false);
    expect(data.catalogSources).toMatchObject({ openRouter: true, anthropic: false });
  });

  it('merges public models into the picker and publishes their prices', async () => {
    mockFetchOpenRouterCatalog.mockReturnValue(Promise.resolve([
      publicEntry('gpt-5.6-terra', 'openai', 'OpenAI: GPT-5.6 Terra'),
    ]));

    const data = await (await GET(req())).json();
    const gpt = data.models.find((m: any) => m.id === 'gpt-5.6-terra');

    expect(gpt).toMatchObject({ provider: 'openai', displayName: 'OpenAI: GPT-5.6 Terra' });
    // Prices reach model-prices, which is what fixes GPT cost math.
    expect(mockSetCatalogPrices).toHaveBeenCalled();
  });

  it('prefers the credentialed catalog for the audit when both are present', async () => {
    // The Anthropic list is authoritative (dated snapshots, unreselled models);
    // the public one is the fallback, not an override.
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockReturnValue(Promise.resolve(makeAnthropicResponse([
      { id: 'claude-opus-5' },
      { id: 'claude-sonnet-4-6' },
      { id: 'claude-fable-5-1' },
      { id: 'claude-haiku-4-5-20251001' },
    ])));
    // The public catalog knows sonnet-5; the credentialed one does not. The
    // audit must follow the credentialed list and report no supersession.
    mockFetchOpenRouterCatalog.mockReturnValue(Promise.resolve([publicEntry('claude-sonnet-5')]));

    const data = await (await GET(req())).json();

    expect(data.catalogComplete).toBe(true);
    expect(data.tierAudit.superseded).toEqual([]);
  });

  it('a failed public catalog read degrades to the previous behaviour', async () => {
    mockFetchOpenRouterCatalog.mockReturnValue(Promise.resolve([]));

    const data = await (await GET(req())).json();

    expect(data.models).toHaveLength(4); // tier floor intact
    expect(data.tierAudit.checked).toBe(false);
    expect(data.catalogSources.openRouter).toBe(false);
  });

  it('audits nothing when the catalog is incomplete, rather than condemning every tier', async () => {
    // No credential AND an empty public catalog => nothing to audit against.
    // Warning here would flag every tier as retired off an empty set — the
    // inverse of a gate that passes vacuously.
    const data = await (await GET(req())).json();

    expect(data.catalogComplete).toBe(false);
    expect(data.tierAudit.checked).toBe(false);
    expect(data.tierAudit.unknown).toEqual([]);
    expect(data.tierAudit.superseded).toEqual([]);
  });
});
