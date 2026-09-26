import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds } from '@/lib/team-access';
import { deleteProviderKey, listProviderKeys, setProviderKey } from '@/lib/provider-keys';
import { isChatProvider, type SetProviderKeyRequest } from '@buildd/shared';

/**
 * Provider keys for chat, inference and decision calls.
 *
 *   GET    /api/inference-keys?teamId=                      → ListProviderKeysResponse
 *   PUT    /api/inference-keys  { teamId, provider, scope, value } → SetProviderKeyResponse
 *   DELETE /api/inference-keys?teamId=&provider=&scope=     → DeleteProviderKeyResponse
 *
 * Session only: a personal key belongs to a person, and API keys are not
 * people. `scope: 'team'` writes need team owner/admin. Plaintext never leaves
 * the server — responses carry the last four characters and health.
 */

type Caller = { userId: string; teamId: string; isAdmin: boolean };

async function resolveCaller(
  req: NextRequest,
  requestedTeamId: string | null | undefined,
): Promise<{ caller: Caller } | { response: Response }> {
  const session = await requireSessionUser(req);
  if (session.response) return { response: session.response };
  const userId = session.user.id;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return { response: NextResponse.json({ error: 'No team found' }, { status: 403 }) };
  const teamId = requestedTeamId || teamIds[0];
  if (!teamIds.includes(teamId)) return { response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };

  const isAdmin = (await getUserAdminTeamIds(userId)).includes(teamId);
  return { caller: { userId, teamId, isAdmin } };
}

function parseScope(value: unknown): 'user' | 'team' | null {
  return value === 'user' || value === 'team' ? value : null;
}

const TEAM_ADMIN_ONLY = 'Only a team owner or admin can manage the team key.';

export async function GET(req: NextRequest) {
  const r = await resolveCaller(req, req.nextUrl.searchParams.get('teamId'));
  if ('response' in r) return r.response;
  const { userId, teamId, isAdmin } = r.caller;
  try {
    return NextResponse.json(await listProviderKeys(teamId, userId, isAdmin));
  } catch (error) {
    console.error('[inference-keys] list failed:', error);
    return NextResponse.json({ error: 'Failed to list provider keys' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: Partial<SetProviderKeyRequest>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const r = await resolveCaller(req, body.teamId);
  if ('response' in r) return r.response;
  const { userId, teamId, isAdmin } = r.caller;

  if (!isChatProvider(body.provider)) {
    return NextResponse.json({ error: 'provider must be anthropic, openai or openrouter' }, { status: 400 });
  }
  const scope = parseScope(body.scope);
  if (!scope) return NextResponse.json({ error: "scope must be 'user' or 'team'" }, { status: 400 });
  if (typeof body.value !== 'string' || !body.value.trim()) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }
  if (scope === 'team' && !isAdmin) return NextResponse.json({ error: TEAM_ADMIN_ONLY }, { status: 403 });

  try {
    const result = await setProviderKey({ teamId, userId, provider: body.provider, scope, value: body.value });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ key: result.key });
  } catch (error) {
    console.error('[inference-keys] set failed:', error);
    return NextResponse.json({ error: 'Failed to save provider key' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const r = await resolveCaller(req, params.get('teamId'));
  if ('response' in r) return r.response;
  const { userId, teamId, isAdmin } = r.caller;

  const provider = params.get('provider');
  if (!isChatProvider(provider)) {
    return NextResponse.json({ error: 'provider must be anthropic, openai or openrouter' }, { status: 400 });
  }
  const scope = parseScope(params.get('scope'));
  if (!scope) return NextResponse.json({ error: "scope must be 'user' or 'team'" }, { status: 400 });
  if (scope === 'team' && !isAdmin) return NextResponse.json({ error: TEAM_ADMIN_ONLY }, { status: 403 });

  try {
    return NextResponse.json({ deleted: await deleteProviderKey({ teamId, userId, provider, scope }) });
  } catch (error) {
    console.error('[inference-keys] delete failed:', error);
    return NextResponse.json({ error: 'Failed to delete provider key' }, { status: 500 });
  }
}
