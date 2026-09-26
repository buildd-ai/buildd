import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds } from '@/lib/team-access';
import { loadTeamKeySettings, setProviderKey } from '@/lib/provider-keys';
import { policyAllowsOwnKey } from '@buildd/core/inference-key-policy';
import { PKCE_COOKIE, PKCE_COOKIE_PATH, decodePkceCookie, exchangeOpenRouterCode } from '@/lib/openrouter-oauth';

/**
 * GET /api/inference-keys/openrouter/callback/<state>?code=
 *
 * OpenRouter sends the browser here after "Connect OpenRouter". Checks the
 * state against the flow cookie, re-checks the caller may write that scope,
 * swaps the code for a key and stores it. The key is never logged or echoed.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  const flow = decodePkceCookie(req.cookies.get(PKCE_COOKIE)?.value);
  const returnTo = flow?.returnTo ?? '/app/home';

  const finish = (outcome: { connected: true } | { error: string }) => {
    const u = new URL(returnTo, req.nextUrl.origin);
    if ('connected' in outcome) u.searchParams.set('connected', 'openrouter');
    else u.searchParams.set('provider_error', outcome.error);
    const res = NextResponse.redirect(u);
    res.cookies.set(PKCE_COOKIE, '', { path: PKCE_COOKIE_PATH, maxAge: 0 });
    return res;
  };

  if (!flow || flow.state !== state) return finish({ error: 'expired' });
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return finish({ error: 'cancelled' });

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  if (session.user.id !== flow.userId) return finish({ error: 'expired' });

  // Permissions can change in ten minutes; check again, as the start route did.
  if (!(await getUserTeamIds(flow.userId)).includes(flow.teamId)) return finish({ error: 'team' });
  if (flow.scope === 'team') {
    if (!(await getUserAdminTeamIds(flow.userId)).includes(flow.teamId)) return finish({ error: 'not_admin' });
  } else if (!policyAllowsOwnKey((await loadTeamKeySettings(flow.teamId)).keyPolicy)) {
    return finish({ error: 'team_key_only' });
  }

  const exchanged = await exchangeOpenRouterCode({ code, verifier: flow.verifier });
  if (!exchanged.ok) return finish({ error: 'exchange' });

  const stored = await setProviderKey({
    teamId: flow.teamId, userId: flow.userId, provider: 'openrouter', scope: flow.scope, value: exchanged.key,
  }).catch(() => ({ ok: false as const, status: 500, error: 'store' }));
  if (!stored.ok) return finish({ error: 'rejected' });
  return finish({ connected: true });
}
