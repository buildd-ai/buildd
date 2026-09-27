import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { loadTeamKeySettings } from '@/lib/provider-keys';
import { policyAllowsOwnKey } from '@buildd/core/inference-key-policy';
import {
  PKCE_COOKIE, PKCE_COOKIE_PATH, PKCE_TTL_MS,
  buildOpenRouterAuthUrl, createPkcePair, encodePkceCookie, safeReturnTo,
} from '@/lib/openrouter-oauth';

/**
 * GET /api/inference-keys/openrouter/start?scope=team|user&teamId=&returnTo=
 *
 * Starts "Connect OpenRouter" (lib/openrouter-oauth.ts). A team key needs an
 * owner or admin; a personal key needs a team policy that allows one. Errors
 * go back to `returnTo` as `?provider_error=`, since this is a navigation.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const returnTo = safeReturnTo(params.get('returnTo'));
  const back = (error: string) => {
    const u = new URL(returnTo, req.nextUrl.origin);
    u.searchParams.set('provider_error', error);
    return NextResponse.redirect(u);
  };

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const userId = session.user.id;

  const scope = params.get('scope') === 'user' ? 'user' : 'team';
  const teamIds = await getUserTeamIds(userId);
  const teamId = params.get('teamId') || await resolveActiveTeamId(userId, req.cookies.get('buildd-team')?.value ?? null);
  if (!teamId || !teamIds.includes(teamId)) return back('team');

  if (scope === 'team') {
    if (!(await getUserAdminTeamIds(userId)).includes(teamId)) return back('not_admin');
  } else {
    const { keyPolicy } = await loadTeamKeySettings(teamId);
    if (!policyAllowsOwnKey(keyPolicy)) return back('team_key_only');
  }

  const { verifier, challenge, state } = createPkcePair();
  const callbackUrl = `${req.nextUrl.origin}${PKCE_COOKIE_PATH}/callback/${state}`;
  const res = NextResponse.redirect(buildOpenRouterAuthUrl({ callbackUrl, challenge, keyLabel: 'buildd' }));
  res.cookies.set(PKCE_COOKIE, encodePkceCookie({ state, verifier, teamId, userId, scope, returnTo, exp: Date.now() + PKCE_TTL_MS }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: PKCE_COOKIE_PATH,
    maxAge: PKCE_TTL_MS / 1000,
  });
  return res;
}
