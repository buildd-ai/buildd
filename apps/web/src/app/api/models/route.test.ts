import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockFetch = mock(() => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Static import after mocks
import { GET, _resetCache } from './route';

const makeAnthropicResponse = (models: { id: string; display_name?: string }[]) =>
  new Response(JSON.stringify({ data: models }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('GET /api/models', () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as any;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    _resetCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/models');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns models filtered to claude-* excluding claude-2 and claude-3 families', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockFetch.mockReturnValue(
      Promise.resolve(
        makeAnthropicResponse([
          { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
          { id: 'claude-fable-5', display_name: 'Claude Fable 5' },
          { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
          { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' }, // excluded
          { id: 'claude-2-1', display_name: 'Claude 2.1' }, // excluded
          { id: 'gpt-4o', display_name: 'GPT-4o' }, // excluded
        ])
      )
    );
    const req = new NextRequest('http://localhost/api/models');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toHaveLength(3);
    const ids = data.models.map((m: any) => m.id);
    expect(ids).not.toContain('claude-3-5-sonnet-20241022');
    expect(ids).not.toContain('claude-2-1');
    expect(ids).not.toContain('gpt-4o');
    expect(ids).toContain('claude-sonnet-5');
  });

  it('returns correct response shape with provider field', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockFetch.mockReturnValue(
      Promise.resolve(
        makeAnthropicResponse([
          { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
        ])
      )
    );
    const req = new NextRequest('http://localhost/api/models');
    const res = await GET(req);
    const data = await res.json();
    expect(data.models[0]).toMatchObject({
      id: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      provider: 'anthropic',
    });
  });

  it('sorts models newest-first (lexicographic descending by id)', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockFetch.mockReturnValue(
      Promise.resolve(
        makeAnthropicResponse([
          { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5' },
          { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
          { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
        ])
      )
    );
    const req = new NextRequest('http://localhost/api/models');
    const res = await GET(req);
    const data = await res.json();
    const ids = data.models.map((m: any) => m.id);
    expect(ids).toEqual([...ids].sort((a: string, b: string) => b.localeCompare(a)));
  });

  it('returns empty list if Anthropic API returns non-ok', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockFetch.mockReturnValue(
      Promise.resolve(new Response('Server Error', { status: 500 }))
    );
    const req = new NextRequest('http://localhost/api/models');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models).toHaveLength(0);
  });

  it('returns empty list if fetch throws', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockFetch.mockImplementation(() => Promise.reject(new Error('network error')));
    const req = new NextRequest('http://localhost/api/models');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.models)).toBe(true);
  });

  it('serves from cache on second request without re-fetching', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockFetch.mockReturnValue(
      Promise.resolve(
        makeAnthropicResponse([{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }])
      )
    );
    const req1 = new NextRequest('http://localhost/api/models');
    await GET(req1);
    const req2 = new NextRequest('http://localhost/api/models');
    await GET(req2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
