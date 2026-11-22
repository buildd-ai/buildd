/**
 * The assertion grant (RFC 7523), server side: buildd signs an assertion for
 * one worker on one task, and the gateway exchanges it at the provider's token
 * endpoint. The mint route (/api/connectors/[id]/assertion) and the connector
 * gateway share these, so the claims an assertion carries are one definition.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

const mockGetActiveSigningKey = mock(async () => ({ kid: 'kid-1', privateKeyJwk: { k: 'x' } }) as any);
const mockSignAssertion = mock(async (_payload: any, _jwk: any, _kid: string) => 'header.payload.sig');
mock.module('@/lib/signing-keys', () => ({ getActiveSigningKey: mockGetActiveSigningKey, signAssertion: mockSignAssertion }));
mock.module('@/lib/oauth/config', () => ({ getIssuer: () => 'https://issuer.example.test' }));

const { buildAssertionClaims, mintConnectorAssertion, exchangeAssertion, tokenEndpointAllowed } = await import('./connector-assertion');

const realFetch = globalThis.fetch;
let fetchCalls: { url: string; init: any }[] = [];
let fetchAnswer: () => Response = () => new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 120 }), { status: 200 });
globalThis.fetch = (async (url: any, init: any) => { fetchCalls.push({ url: String(url), init }); return fetchAnswer(); }) as any;
afterAll(() => { globalThis.fetch = realFetch; });

const input = { accountId: 'acct-1', accountTeamId: 'team-1', workerId: 'worker-1', taskId: 'task-1', audience: 'https://mcp.example.test/mcp' };

beforeEach(() => {
  fetchCalls = [];
  fetchAnswer = () => new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 120 }), { status: 200 });
  mockGetActiveSigningKey.mockClear();
  mockSignAssertion.mockClear();
});

describe('buildAssertionClaims', () => {
  it('names the tenant as sub and the worker and task as the actor, valid for five minutes', () => {
    const c = buildAssertionClaims(input, new Date('2026-11-20T00:00:00.000Z'));
    expect(c.iss).toBe('https://issuer.example.test');
    expect(c.sub).toBe('acct-1:team-1');
    expect(c.act).toEqual({ sub: 'worker:worker-1', tid: 'task-1' });
    expect(c.aud).toBe('https://mcp.example.test/mcp');
    expect(c.exp - c.iat).toBe(300);
    expect(c.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(buildAssertionClaims(input).jti).not.toBe(c.jti);
  });
});

describe('mintConnectorAssertion', () => {
  it('signs the claims with the active key', async () => {
    const out = await mintConnectorAssertion(input);
    expect(out?.assertion).toBe('header.payload.sig');
    const [payload, jwk, kid] = mockSignAssertion.mock.calls[0];
    expect(payload.sub).toBe('acct-1:team-1');
    expect(jwk).toEqual({ k: 'x' });
    expect(kid).toBe('kid-1');
    expect(out!.expiresAt.getTime()).toBe(payload.exp * 1000);
  });

  it('null when no signing key is active', async () => {
    mockGetActiveSigningKey.mockResolvedValueOnce(null as any);
    expect(await mintConnectorAssertion(input)).toBeNull();
    expect(mockSignAssertion).not.toHaveBeenCalled();
  });
});

describe('exchangeAssertion', () => {
  it('posts a jwt-bearer grant and returns the access token with its expiry', async () => {
    const before = Date.now();
    const out = await exchangeAssertion('https://mcp.example.test/oauth/token', 'header.payload.sig');
    expect(out.accessToken).toBe('at');
    expect(out.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(fetchCalls[0].url).toBe('https://mcp.example.test/oauth/token');
    expect(fetchCalls[0].init.method).toBe('POST');
    expect(fetchCalls[0].init.redirect).toBe('manual');
    const form = new URLSearchParams(fetchCalls[0].init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')).toBe('header.payload.sig');
  });

  it('throws on a refused exchange or an answer with no token', async () => {
    fetchAnswer = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    await expect(exchangeAssertion('https://mcp.example.test/oauth/token', 'a')).rejects.toThrow(/400/);
    fetchAnswer = () => new Response('{}', { status: 200 });
    await expect(exchangeAssertion('https://mcp.example.test/oauth/token', 'a')).rejects.toThrow();
  });

  it('never sends an assertion to a non-https endpoint', async () => {
    await expect(exchangeAssertion('http://mcp.example.test/oauth/token', 'a')).rejects.toThrow(/https/);
    expect(fetchCalls).toHaveLength(0);
    expect(tokenEndpointAllowed('https://a.example.test/t')).toBe(true);
    expect(tokenEndpointAllowed('ftp://a.example.test/t')).toBe(false);
    expect(tokenEndpointAllowed('not a url')).toBe(false);
  });
});
