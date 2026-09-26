import { NextRequest, NextResponse } from 'next/server';
import type { CreateConversationRequest, ListConversationsResponse } from '@buildd/shared';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { createConversation, listConversations, toConversationDTO } from '@/lib/chat/store';
import { isSensitiveWorkspace, loadTeamChatSettings, requireChatCaller, resolveChatTeam } from '@/lib/chat/session';

/**
 * GET  /api/chat?cursor=&limit=  → ListConversationsResponse (the caller's own, in teams they still belong to, newest first)
 * POST /api/chat { teamId?, workspaceId? } → { conversation }
 *
 * Session only. Creating a conversation needs the team's `chat` capability on;
 * listing works regardless so history stays readable after chat is turned off.
 */

export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? 30);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 100) : 30;
  const cursor = req.nextUrl.searchParams.get('cursor');
  const before = cursor ? new Date(cursor) : undefined;
  if (before && Number.isNaN(before.getTime())) return NextResponse.json({ error: 'invalid cursor' }, { status: 400 });

  const page = await listConversations(r.caller.user.id, { before, limit, teamIds: r.caller.teamIds });
  const body: ListConversationsResponse = {
    conversations: page.conversations.map(toConversationDTO),
    nextCursor: page.nextCursor,
  };
  return NextResponse.json(body);
}

export async function POST(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  let body: CreateConversationRequest = {};
  try { body = (await req.json()) ?? {}; } catch { /* empty body is fine */ }

  let teamId = await resolveChatTeam(req, r.caller, body.teamId);
  const workspaceId = body.workspaceId ?? null;
  if (workspaceId) {
    const access = await verifyWorkspaceAccess(r.caller.user.id, workspaceId);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    if (body.teamId && access.teamId !== body.teamId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    teamId = access.teamId;
    if (await isSensitiveWorkspace(workspaceId)) {
      return NextResponse.json({
        error: 'sensitive_workspace',
        message: 'This workspace is marked sensitive, so its data is not sent to a chat model.',
      }, { status: 403 });
    }
  }
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const settings = await loadTeamChatSettings(teamId);
  if (!settings.chatEnabled) {
    return NextResponse.json({ error: 'capability_disabled', message: 'Chat is not enabled for this team.' }, { status: 403 });
  }

  const conversation = await createConversation({ teamId, workspaceId, userId: r.caller.user.id });
  return NextResponse.json({ conversation: toConversationDTO(conversation) }, { status: 201 });
}
