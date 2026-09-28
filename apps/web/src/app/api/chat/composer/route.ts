import { NextRequest, NextResponse } from 'next/server';
import { isChatTierName, type GetComposerPrefsResponse, type UpdateComposerPrefsRequest } from '@buildd/shared';
import { getTeamWorkspaceIds, verifyWorkspaceAccess } from '@/lib/team-access';
import { requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { loadComposerSeed, saveComposerPrefs } from '@/lib/chat/composer-prefs-store';
import type { ComposerPrefs } from '@/lib/chat/composer-prefs';

/**
 * GET   /api/chat/composer?teamId=                 → GetComposerPrefsResponse
 * PATCH /api/chat/composer { teamId?, workspaceId?, tier? }
 *
 * The caller's last composer choices in one team (lib/chat/composer-prefs.ts),
 * so a new conversation on any device starts where they left off. GET returns
 * the seed with the team's tier cap already applied. Session only; never
 * touches an existing conversation (PATCH /api/chat/[id] does that).
 */

export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const teamId = await resolveChatTeam(req, r.caller, req.nextUrl.searchParams.get('teamId'));
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const wsIds = await getTeamWorkspaceIds(teamId).catch(() => []);
  const body: GetComposerPrefsResponse = await loadComposerSeed(teamId, r.caller.user.id, wsIds);
  return NextResponse.json(body);
}

export async function PATCH(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  let body: UpdateComposerPrefsRequest;
  try { body = (await req.json()) ?? {}; } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const teamId = await resolveChatTeam(req, r.caller, body.teamId);
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const patch: ComposerPrefs = {};
  if (body.workspaceId !== undefined) {
    if (body.workspaceId !== null) {
      if (typeof body.workspaceId !== 'string') return NextResponse.json({ error: 'workspaceId must be a string or null' }, { status: 400 });
      const access = await verifyWorkspaceAccess(r.caller.user.id, body.workspaceId);
      if (!access || access.teamId !== teamId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    patch.workspaceId = body.workspaceId;
  }
  if (body.tier !== undefined) {
    if (body.tier !== null && !isChatTierName(body.tier)) return NextResponse.json({ error: 'tier must be budget, standard, premium or null' }, { status: 400 });
    patch.tier = body.tier;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to remember' }, { status: 400 });

  const ok = await saveComposerPrefs(teamId, r.caller.user.id, patch);
  if (!ok) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
