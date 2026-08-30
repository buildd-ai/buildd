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
const mockResolveAllTiers = mock(() => Promise.resolve({
  premium: { provider: 'anthropic', model: 'claude-opus-5', source: 'default' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'default' },
  budget: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'default' },
} as any));
const mockFetch = mock(() => Promise.resolve(null as any));

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
      'claude-opus-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]);
    expect(data.models[0]).toMatchObject({ tier: 'premium', provider: 'anthropic' });
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
    expect(ids.slice(0, 3)).toEqual(['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
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
    expect(data.models).toHaveLength(3);
    // A dead credential must not be reported as a complete catalog, or the client
    // would warn that every pinned model has been retired.
    expect(data.catalogComplete).toBe(false);
  });

  it('keeps the tier floor and reports incomplete when the fetch throws', async () => {
    mockResolveAnthropicAuth.mockReturnValue(Promise.resolve(OAUTH_AUTH));
    mockFetch.mockImplementation(() => Promise.reject(new Error('network error')));

    const data = await (await GET(req())).json();
    expect(data.models).toHaveLength(3);
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
});
