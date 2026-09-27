import { NextRequest, NextResponse } from 'next/server';
import type { GetChatPermissionsResponse, UpdateChatPermissionRequest } from '@buildd/shared';
import { requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { isAllowableGroup, toolPermissionRows } from '@/lib/chat/permissions';
import { loadAllowedToolGroups, setToolGroupMode } from '@/lib/chat/permissions-store';

/**
 * GET   /api/chat/permissions?teamId=           → GetChatPermissionsResponse
 * PATCH /api/chat/permissions { teamId?, group, mode: 'ask' | 'allow' }
 *
 * The caller's own chat tool permissions in one team (lib/chat/permissions.ts).
 * Session only; a choice never applies to anyone else. Admin, read-only and
 * never-in-chat rows are locked and can't be changed here.
 */

export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const teamId = await resolveChatTeam(req, r.caller, req.nextUrl.searchParams.get('teamId'));
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const body: GetChatPermissionsResponse = { rows: toolPermissionRows(await loadAllowedToolGroups(teamId, r.caller.user.id)) };
  return NextResponse.json(body);
}

export async function PATCH(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  let body: UpdateChatPermissionRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const teamId = await resolveChatTeam(req, r.caller, body?.teamId);
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  if (!isAllowableGroup(body?.group)) return NextResponse.json({ error: 'group can\'t be changed' }, { status: 400 });
  if (body.mode !== 'ask' && body.mode !== 'allow') return NextResponse.json({ error: 'mode must be ask or allow' }, { status: 400 });

  const ok = await setToolGroupMode(teamId, r.caller.user.id, body.group, body.mode);
  if (!ok) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const out: GetChatPermissionsResponse = { rows: toolPermissionRows(await loadAllowedToolGroups(teamId, r.caller.user.id)) };
  return NextResponse.json(out);
}
