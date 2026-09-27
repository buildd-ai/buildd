import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let session: any = { user: { id: 'u-1' } };
let adminTeams: string[] = ['t-1'];
let policy = 'team';
let exchange: any = { ok: true, key: 'sk-or-v1-created-by-oauth' };
const stored: any[] = [];

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: async () => session }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t-1'],
  getUserAdminTeamIds: async () => adminTeams,
}));
mock.module('@/lib/provider-keys', () => ({
  loadTeamKeySettings: async () => ({ keyPolicy: policy }),
  setProviderKey: async (input: any) => { stored.push(input); return { ok: true, key: {} }; },
}));

const real = await import('@/lib/openrouter-oauth');
mock.module('@/lib/openrouter-oauth', () => ({ ...real, exchangeOpenRouterCode: async () => exchange }));

const { GET } = await import('./route');

function flowCookie(over: Record<string, unknown> = {}) {
  return real.encodePkceCookie({ state: 'st', verifier: 'ver', teamId: 't-1', userId: 'u-1', scope: 'team', returnTo: '/app/home', exp: Date.now() + 60_000, ...over } as never);
}

function call(state: string, qs: string, cookie: string | null = flowCookie()) {
  const r = new NextRequest(`https://app.example/api/inference-keys/openrouter/callback/${state}?${qs}`, {
    headers: cookie ? { cookie: `${real.PKCE_COOKIE}=${cookie}` } : {},
  });
  return GET(r, { params: Promise.resolve({ state }) });
}

const outcome = (res: Response) => new URL(res.headers.get('location')!).searchParams;

beforeEach(() => {
  session = { user: { id: 'u-1' } }; adminTeams = ['t-1']; policy = 'team';
  exchange = { ok: true, key: 'sk-or-v1-created-by-oauth' }; stored.length = 0;
});

describe('GET /api/inference-keys/openrouter/callback/[state]', () => {
  it('swaps the code for a key and stores it at team scope', async () => {
    const res = await call('st', 'code=abc');
    expect(outcome(res).get('connected')).toBe('openrouter');
    expect(stored).toEqual([{ teamId: 't-1', userId: 'u-1', provider: 'openrouter', scope: 'team', value: 'sk-or-v1-created-by-oauth' }]);
    // The key never rides back in the redirect.
    expect(res.headers.get('location')).not.toContain('sk-or');
    // The flow cookie is spent.
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('rejects a state that does not match the cookie, or no cookie at all', async () => {
    expect(outcome(await call('other', 'code=abc')).get('provider_error')).toBe('expired');
    expect(outcome(await call('st', 'code=abc', null)).get('provider_error')).toBe('expired');
    expect(stored).toHaveLength(0);
  });

  it('rejects a flow started by someone else', async () => {
    session = { user: { id: 'u-2' } };
    expect(outcome(await call('st', 'code=abc')).get('provider_error')).toBe('expired');
    expect(stored).toHaveLength(0);
  });

  it('re-checks admin rights for a team key', async () => {
    adminTeams = [];
    expect(outcome(await call('st', 'code=abc')).get('provider_error')).toBe('not_admin');
    expect(stored).toHaveLength(0);
  });

  it('a personal key follows the team policy', async () => {
    const cookie = flowCookie({ scope: 'user', returnTo: '/app/chat' });
    expect(outcome(await call('st', 'code=abc', cookie)).get('provider_error')).toBe('team_key_only');
    policy = 'own';
    const res = await call('st', 'code=abc', cookie);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/app/chat');
    expect(stored[0]).toMatchObject({ scope: 'user' });
  });

  it('a cancelled sign-in or a failed exchange stores nothing', async () => {
    expect(outcome(await call('st', '')).get('provider_error')).toBe('cancelled');
    exchange = { ok: false, error: 'x' };
    expect(outcome(await call('st', 'code=abc')).get('provider_error')).toBe('exchange');
    expect(stored).toHaveLength(0);
  });
});
