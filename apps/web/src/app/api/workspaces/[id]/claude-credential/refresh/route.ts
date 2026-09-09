import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { getClaudeSecretId, refreshClaudeCredential } from '@/lib/claude-credential';

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/workspaces/[id]/claude-credential/refresh?scope=team|workspace
//
// Gated on BUILDD_ALLOW_CONTROL_PLANE_REFRESH, the same opt-in escape hatch used by
// `GET /api/cron/codex-token-refresh` and `GET /api/cron/lease-expiry-guard`.
//
// Why a manual button cannot just refresh: after the one-time interactive grant, every
// token-endpoint call must originate from the runner's static egress IP (see
// docs/design/runner-oauth-broker.md — "Core principle"). This route runs on Vercel, whose
// outbound IPs rotate, so a refresh from here is a location flip on the refresh-token family
// and is what trips provider anomaly detection into a permanent invalid_grant revocation.
// Refreshing is exactly the operation that must not happen here.
//
// With the flag off (the default) we reject rather than pretend: 503, because the capability
// is deliberately unavailable in this deployment, not malformed (4xx) or broken (500). The
// runner-side broker refreshes autonomously while it holds the credential lease, so the
// actionable advice is "check the runner is online", not "try again".
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  // Gate after the auth/access checks (so config state is not observable to strangers) and
  // before any credential lookup (no DB work for a request that cannot proceed).
  if (process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH !== 'true') {
    return NextResponse.json(
      {
        status: 'control_plane_refresh_disabled',
        error: 'Token refresh is runner-originated and cannot be triggered from the dashboard.',
        detail:
          'Refreshing from the control plane would call the provider token endpoint from a rotating ' +
          'Vercel IP, which can permanently revoke the credential. A runner holding the credential ' +
          'lease refreshes it automatically as it nears expiry. If the token is stale, check that a ' +
          'runner is online; if the credential shows as revoked, reconnect the account in Settings.',
      },
      { status: 503 },
    );
  }

  const scopeParam = req.nextUrl.searchParams.get('scope');
  const scope = scopeParam === 'workspace'
    ? { teamId: access.teamId, workspaceId: id }
    : { teamId: access.teamId };

  const secretId = await getClaudeSecretId(scope);
  if (!secretId) return NextResponse.json({ status: 'no_credential' });

  const result = await refreshClaudeCredential(secretId);
  return NextResponse.json({ status: result });
}
