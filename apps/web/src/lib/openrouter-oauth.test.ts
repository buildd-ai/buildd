import { describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import {
  OPENROUTER_AUTH_URL,
  OPENROUTER_KEYS_URL,
  buildOpenRouterAuthUrl,
  createPkcePair,
  decodePkceCookie,
  encodePkceCookie,
  exchangeOpenRouterCode,
  safeReturnTo,
} from './openrouter-oauth';

describe('createPkcePair', () => {
  it('makes an S256 challenge of a 43+ char base64url verifier', () => {
    const { verifier, challenge, state } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(createPkcePair().verifier).not.toBe(verifier);
  });
});

describe('buildOpenRouterAuthUrl', () => {
  it('sends callback_url, the S256 challenge and a key label', () => {
    const url = new URL(buildOpenRouterAuthUrl({ callbackUrl: 'https://app.example/api/cb/abc', challenge: 'ch', keyLabel: 'buildd' }));
    expect(`${url.origin}${url.pathname}`).toBe(OPENROUTER_AUTH_URL);
    expect(url.searchParams.get('callback_url')).toBe('https://app.example/api/cb/abc');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('key_label')).toBe('buildd');
  });
});

describe('pkce cookie', () => {
  it('round-trips and rejects junk or an expired flow', () => {
    const now = 1_000_000;
    const c = encodePkceCookie({ state: 's', verifier: 'v', teamId: 't', userId: 'u', scope: 'team', returnTo: '/app/home', exp: now + 600_000 });
    expect(decodePkceCookie(c, now)).toMatchObject({ state: 's', verifier: 'v', scope: 'team' });
    expect(decodePkceCookie(c, now + 700_000)).toBeNull();
    expect(decodePkceCookie('not-json', now)).toBeNull();
    expect(decodePkceCookie(undefined, now)).toBeNull();
  });
});

describe('safeReturnTo', () => {
  it('keeps in-app paths only', () => {
    expect(safeReturnTo('/app/settings/providers')).toBe('/app/settings/providers');
    expect(safeReturnTo('https://evil.example/app')).toBe('/app/home');
    expect(safeReturnTo('//evil.example')).toBe('/app/home');
    expect(safeReturnTo('/api/x')).toBe('/app/home');
    expect(safeReturnTo(null)).toBe('/app/home');
  });
});

describe('exchangeOpenRouterCode', () => {
  it('posts the code and verifier and returns the key', async () => {
    let sent: { url: string; body: unknown } | null = null;
    const fetcher = async (url: string, init?: RequestInit) => {
      sent = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ key: 'sk-or-v1-created' }), { status: 200 });
    };
    expect(await exchangeOpenRouterCode({ code: 'c', verifier: 'v', fetcher })).toEqual({ ok: true, key: 'sk-or-v1-created' });
    expect(sent).toEqual({ url: OPENROUTER_KEYS_URL, body: { code: 'c', code_verifier: 'v', code_challenge_method: 'S256' } });
  });

  it('reports a failure without echoing anything key-shaped', async () => {
    const fetcher = async () => new Response('{"error":"bad code sk-or-v1-leak"}', { status: 400 });
    const r = await exchangeOpenRouterCode({ code: 'c', verifier: 'v', fetcher });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('sk-or');
  });

  it('treats a 200 with no key as a failure', async () => {
    const fetcher = async () => new Response('{}', { status: 200 });
    expect((await exchangeOpenRouterCode({ code: 'c', verifier: 'v', fetcher })).ok).toBe(false);
  });
});
