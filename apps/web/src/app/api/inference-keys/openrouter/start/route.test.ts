import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let session: any = { user: { id: 'u-1' } };
let adminTeams: string[] = ['t-1'];
let policy = 'team';

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: async () => session }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t-1'],
  getUserAdminTeamIds: async () => adminTeams,
  resolveActiveTeamId: async () => 't-1',
}));
mock.module('@/lib/provider-keys', () => ({ loadTeamKeySettings: async () => ({ keyPolicy: policy }) }));

const { GET } = await import('./route');
const { decodePkceCookie, PKCE_COOKIE } = await import('@/lib/openrouter-oauth');

const req = (qs: string) => new NextRequest(`https://app.example/api/inference-keys/openrouter/start?${qs}`);

beforeEach(() => { session = { user: { id: 'u-1' } }; adminTeams = ['t-1']; policy = 'team'; });

describe('GET /api/inference-keys/openrouter/start', () => {
  it('sends an admin to OpenRouter with a PKCE challenge and a state-bearing callback', async () => {
    const res = await GET(req('scope=team&teamId=t-1&returnTo=/app/home'));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://openrouter.ai/auth');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    const cb = new URL(loc.searchParams.get('callback_url')!);
    expect(cb.origin).toBe('https://app.example');
    const flow = decodePkceCookie(res.cookies.get(PKCE_COOKIE)?.value)!;
    expect(cb.pathname).toBe(`/api/inference-keys/openrouter/callback/${flow.state}`);
    expect(flow).toMatchObject({ teamId: 't-1', userId: 'u-1', scope: 'team', returnTo: '/app/home' });
    // The verifier stays server-side: in an httpOnly cookie, never in the URL.
    expect(loc.toString()).not.toContain(flow.verifier);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
  });

  it('refuses a team key for a member', async () => {
    adminTeams = [];
    const res = await GET(req('scope=team&teamId=t-1&returnTo=/app/home'));
    expect(new URL(res.headers.get('location')!).searchParams.get('provider_error')).toBe('not_admin');
  });

  it('refuses a personal key when the team pays for everyone', async () => {
    const res = await GET(req('scope=user&teamId=t-1&returnTo=/app/settings/account'));
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/app/settings/account');
    expect(loc.searchParams.get('provider_error')).toBe('team_key_only');
  });

  it('allows a personal key when everyone brings their own', async () => {
    policy = 'own';
    adminTeams = [];
    const res = await GET(req('scope=user&teamId=t-1&returnTo=/app/chat'));
    expect(new URL(res.headers.get('location')!).hostname).toBe('openrouter.ai');
  });

  it('never returns to another origin', async () => {
    adminTeams = [];
    const res = await GET(req('scope=team&teamId=t-1&returnTo=https://evil.example/'));
    expect(new URL(res.headers.get('location')!).origin).toBe('https://app.example');
  });
});
