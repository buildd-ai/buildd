import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let session: any = { user: { id: 'u-1' } };
// The caller's team roles and the team's permission overrides, read by the
// real permission check (lib/permissions.ts) through this db mock.
let roles: Record<string, string> = { 't-1': 'admin' };
let overrides: Record<string, unknown> | null = null;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: async () => Object.entries(roles).map(([teamId, role]) => ({ teamId, role })) },
      teams: { findFirst: async () => ({ id: 'not-a-personal-team', permissionOverrides: overrides }) },
    },
  },
}));
let policy = 'team';

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: async () => session }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t-1'],
  resolveActiveTeamId: async () => 't-1',
}));
mock.module('@/lib/provider-keys', () => ({ loadTeamKeySettings: async () => ({ keyPolicy: policy }) }));

const { GET } = await import('./route');
const { decodePkceCookie, PKCE_COOKIE } = await import('@/lib/openrouter-oauth');

const req = (qs: string) => new NextRequest(`https://app.example/api/inference-keys/openrouter/start?${qs}`);

beforeEach(() => { session = { user: { id: 'u-1' } }; roles = { 't-1': 'admin' }; overrides = null; policy = 'team'; });

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
    roles = { 't-1': 'member' };
    const res = await GET(req('scope=team&teamId=t-1&returnTo=/app/home'));
    expect(new URL(res.headers.get('location')!).searchParams.get('provider_error')).toBe('not_admin');
  });

  it('a team key follows the team permission overrides for manage_inference_providers', async () => {
    overrides = { manage_inference_providers: ['owner'] };
    const refused = await GET(req('scope=team&teamId=t-1&returnTo=/app/home'));
    expect(new URL(refused.headers.get('location')!).searchParams.get('provider_error')).toBe('not_admin');
    expect(refused.cookies.get(PKCE_COOKIE)).toBeUndefined();

    roles = { 't-1': 'member' };
    overrides = { manage_inference_providers: ['owner', 'admin', 'member'] };
    const admitted = await GET(req('scope=team&teamId=t-1&returnTo=/app/home'));
    expect(new URL(admitted.headers.get('location')!).hostname).toBe('openrouter.ai');
    expect(decodePkceCookie(admitted.cookies.get(PKCE_COOKIE)?.value)).toMatchObject({ teamId: 't-1', scope: 'team' });
  });

  it('refuses a personal key when the team pays for everyone', async () => {
    const res = await GET(req('scope=user&teamId=t-1&returnTo=/app/settings/account'));
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/app/settings/account');
    expect(loc.searchParams.get('provider_error')).toBe('team_key_only');
  });

  it('allows a personal key when everyone brings their own', async () => {
    policy = 'own';
    roles = { 't-1': 'member' };
    const res = await GET(req('scope=user&teamId=t-1&returnTo=/app/chat'));
    expect(new URL(res.headers.get('location')!).hostname).toBe('openrouter.ai');
  });

  it('never returns to another origin', async () => {
    roles = { 't-1': 'member' };
    const res = await GET(req('scope=team&teamId=t-1&returnTo=https://evil.example/'));
    expect(new URL(res.headers.get('location')!).origin).toBe('https://app.example');
  });
});
