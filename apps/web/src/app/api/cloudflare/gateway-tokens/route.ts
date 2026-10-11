import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { isUuid } from '@/lib/uuid';
import { createGatewayToken, deleteGatewayToken, listGatewayTokens, type GatewayTokenScope } from '@/lib/cloudflare-gateway-tokens';

/**
 * Cloudflare AI Gateway Run tokens minted from the team's Cloudflare
 * credential (@buildd/core/cloudflare-gateway-tokens).
 *
 *   GET    ?teamId=                  → { personal, team, canManageTeam }   any member; masked
 *   POST   { teamId, scope }         → { token }                            personal: any member; team: owner/admin
 *   DELETE ?teamId=&scope=           → { deleted }                          same rule; revoked at Cloudflare first
 *
 * `personal` is the signed-in person's own token (decision calls made for
 * them spend it); `team` is the agents token (agent runs and team decision
 * calls). Session only; a token value never leaves the server.
 */

function readScope(raw: unknown): GatewayTokenScope | null {
  return raw === 'personal' || raw === 'team' ? raw : null;
}

async function caller(req: NextRequest, teamId: unknown, scope: GatewayTokenScope | 'read') {
  const session = await requireSessionUser(req);
  if (session.response) return { response: session.response };
  if (typeof teamId !== 'string' || !isUuid(teamId)) return { response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };
  const user = session.user;
  if (!(await getUserTeamIds(user.id)).includes(teamId)) return { response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };
  const canManageTeam = await can({ kind: 'user', userId: user.id }, 'manage_inference_providers', teamId);
  if (scope === 'team' && !canManageTeam) {
    return { response: NextResponse.json({ error: 'Only a team owner or admin can manage the team token.' }, { status: 403 }) };
  }
  return { user, teamId, canManageTeam };
}

export async function GET(req: NextRequest) {
  const c = await caller(req, req.nextUrl.searchParams.get('teamId'), 'read');
  if ('response' in c) return c.response;
  try {
    const tokens = await listGatewayTokens(c.teamId, c.user.id);
    return NextResponse.json({ ...tokens, canManageTeam: c.canManageTeam }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[cloudflare-gateway-tokens] read failed:', error);
    return NextResponse.json({ error: 'Failed to read gateway tokens' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { teamId?: unknown; scope?: unknown } | null;
  const scope = readScope(body?.scope);
  if (!scope) return NextResponse.json({ error: 'scope must be personal or team' }, { status: 400 });
  const c = await caller(req, body?.teamId, scope);
  if ('response' in c) return c.response;
  // Named so the team can tell tokens apart in Cloudflare's dashboard.
  const who = c.user.email || c.user.id;
  const label = scope === 'personal' ? `buildd: ${who}` : 'buildd: agents';
  try {
    const r = await createGatewayToken({ teamId: c.teamId, userId: c.user.id, scope, label });
    return r.ok ? NextResponse.json({ token: r.token }) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (error) {
    console.error('[cloudflare-gateway-tokens] create failed:', error);
    return NextResponse.json({ error: 'Failed to create the token' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const scope = readScope(req.nextUrl.searchParams.get('scope'));
  if (!scope) return NextResponse.json({ error: 'scope must be personal or team' }, { status: 400 });
  const c = await caller(req, req.nextUrl.searchParams.get('teamId'), scope);
  if ('response' in c) return c.response;
  try {
    const r = await deleteGatewayToken({ teamId: c.teamId, userId: c.user.id, scope });
    return r.ok ? NextResponse.json({ deleted: r.deleted }) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (error) {
    console.error('[cloudflare-gateway-tokens] delete failed:', error);
    return NextResponse.json({ error: 'Failed to remove the token' }, { status: 500 });
  }
}
