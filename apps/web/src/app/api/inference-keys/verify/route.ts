import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { reverifyProviderKey } from '@/lib/provider-keys';
import { isChatProvider, type VerifyProviderKeyRequest } from '@buildd/shared';

/**
 * POST /api/inference-keys/verify { teamId, provider, scope }
 * Re-checks a stored key against a free provider endpoint and records health.
 * Returns `{ key: MaskedProviderKey }`, or 404 when no key is stored there.
 */
export async function POST(req: NextRequest) {
  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const userId = session.user.id;

  let body: Partial<VerifyProviderKeyRequest>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const teamIds = await getUserTeamIds(userId);
  const teamId = body.teamId || await resolveActiveTeamId(userId, req.cookies.get('buildd-team')?.value ?? null);
  if (!teamId || !teamIds.includes(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  if (!isChatProvider(body.provider)) {
    return NextResponse.json({ error: 'provider must be anthropic, openai or openrouter' }, { status: 400 });
  }
  if (body.scope !== 'user' && body.scope !== 'team') {
    return NextResponse.json({ error: "scope must be 'user' or 'team'" }, { status: 400 });
  }
  if (body.scope === 'team' && !(await getUserAdminTeamIds(userId)).includes(teamId)) {
    return NextResponse.json({ error: 'Only a team owner or admin can manage the team key.' }, { status: 403 });
  }

  try {
    const key = await reverifyProviderKey({ teamId, userId, provider: body.provider, scope: body.scope });
    if (!key) return NextResponse.json({ error: 'No key stored' }, { status: 404 });
    return NextResponse.json({ key });
  } catch (error) {
    console.error('[inference-keys] verify failed:', error);
    return NextResponse.json({ error: 'Failed to verify provider key' }, { status: 500 });
  }
}
