import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock transitive dependencies before any imports
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@buildd/core/db/schema', () => ({}));
mock.module('@/lib/redis', () => ({
  getCachedApiKey: mock(() => Promise.resolve(null)),
  setCachedApiKey: mock(() => Promise.resolve()),
  invalidateCachedApiKey: mock(() => Promise.resolve()),
}));
mock.module('@/lib/oauth/tokens', () => ({
  looksLikeJwt: mock(() => false),
  verifyAccessTokenAnyAudience: mock(() => Promise.resolve(null)),
}));

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockResolveAnthropicAuth = mock(() => Promise.resolve(null as any));
mock.module('@/lib/claude-credential', () => ({
  resolveAnthropicAuth: mockResolveAnthropicAuth,
}));

import { POST } from './route';

const FAKE_ACCOUNT = { id: 'acct-1', teamId: 'team-1', level: 'trigger' };
const FAKE_ANTHROPIC_AUTH = {
  headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'test-anthropic-key' },
  purpose: 'anthropic_api_key',
  secretId: 'secret-1',
};

const ROUTE = {
  id: 'home',
  title: 'Home',
  specRef: '§2 domain model',
  expectations: [
    { id: 'home-active-workers', desc: 'Active workers panel visible', specClaim: 'Dashboard surfaces active runners' },
  ],
};

const CAPTURE_NORMAL = {
  url: 'http://localhost:3000/app/home',
  finalUrl: 'http://localhost:3000/app/home',
  redirected: false,
  screenshotB64: 'base64screenshot==',
  a11yText: 'home page a11y content',
};

function makeReq(body: unknown, authHeader?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/qa/judge', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      ...(authHeader ? { authorization: authHeader } : {}),
    }),
    body: JSON.stringify(body),
  });
}

describe('POST /api/qa/judge', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockResolveAnthropicAuth.mockReset();
    mockResolveAnthropicAuth.mockResolvedValue(FAKE_ANTHROPIC_AUTH as any);

    fetchSpy = spyOn(global, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({
          overallVerdict: 'PASS',
          summary: 'All expectations met.',
          expectations: [{ id: 'home-active-workers', verdict: 'MATCHES-SPEC', evidence: 'Saw active workers panel' }],
        }) }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ) as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(makeReq({ route: ROUTE, capture: CAPTURE_NORMAL }));
    expect(res.status).toBe(401);
  });

  it('returns 503 when no Anthropic credential resolves for the team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(FAKE_ACCOUNT);
    mockResolveAnthropicAuth.mockResolvedValue(null);
    const res = await POST(makeReq({ route: ROUTE, capture: CAPTURE_NORMAL }));
    expect(res.status).toBe(503);
  });

  it('returns 400 for missing body fields', async () => {
    mockAuthenticateApiKey.mockResolvedValue(FAKE_ACCOUNT);
    const res = await POST(makeReq({ route: ROUTE }));
    expect(res.status).toBe(400);
  });

  it('returns SKIPPED verdict without calling Anthropic', async () => {
    mockAuthenticateApiKey.mockResolvedValue(FAKE_ACCOUNT);
    const res = await POST(makeReq({
      route: ROUTE,
      capture: { url: 'http://localhost:3000/app/tasks/123', skipped: true, skipReason: 'dynamic route' },
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overallVerdict).toBe('SKIPPED');
    expect(data.summary).toBe('dynamic route');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ERROR verdict without calling Anthropic when capture errored', async () => {
    mockAuthenticateApiKey.mockResolvedValue(FAKE_ACCOUNT);
    const res = await POST(makeReq({
      route: ROUTE,
      capture: { url: 'http://localhost:3000/app/home', error: 'Timeout after 30000ms' },
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overallVerdict).toBe('ERROR');
    expect(data.summary).toContain('Timeout');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // @signal-fire: visual-qa-judge-credential-resolution
  it('calls Anthropic and returns parsed verdict for a normal capture', async () => {
    mockAuthenticateApiKey.mockResolvedValue(FAKE_ACCOUNT);
    const res = await POST(makeReq({ route: ROUTE, capture: CAPTURE_NORMAL }, 'Bearer bld_testkey'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('home');
    expect(data.title).toBe('Home');
    expect(data.overallVerdict).toBe('PASS');
    expect(data.expectations[0].verdict).toBe('MATCHES-SPEC');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('anthropic.com');
    // Regression guard: this route used to read process.env.ANTHROPIC_API_KEY
    // directly and 503 on every real call — it must resolve credentials via
    // the shared team-scoped resolver, keyed by the authenticated account's team.
    expect(mockResolveAnthropicAuth).toHaveBeenCalledWith({ teamId: FAKE_ACCOUNT.teamId });
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-anthropic-key');
  });

  it('returns ERROR verdict when Anthropic API call fails', async () => {
    mockAuthenticateApiKey.mockResolvedValue(FAKE_ACCOUNT);
    fetchSpy.mockResolvedValue(new Response('{"error":"overloaded"}', { status: 529 }) as any);
    const res = await POST(makeReq({ route: ROUTE, capture: CAPTURE_NORMAL }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overallVerdict).toBe('ERROR');
    expect(data.summary).toContain('529');
  });

  it('returns ERROR verdict when Claude response is malformed JSON', async () => {
    mockAuthenticateApiKey.mockResolvedValue(FAKE_ACCOUNT);
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'not json at all' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ) as any);
    const res = await POST(makeReq({ route: ROUTE, capture: CAPTURE_NORMAL }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overallVerdict).toBe('ERROR');
    expect(data.summary).toContain('parse error');
  });
});
