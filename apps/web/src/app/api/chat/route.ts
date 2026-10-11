import { NextRequest, NextResponse } from 'next/server';
import { isChatTierName, type CreateConversationRequest, type ListConversationsResponse } from '@buildd/shared';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { createConversation, listConversations, toConversationDTO } from '@/lib/chat/store';
import { isSensitiveWorkspace, requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { assertMemberRepoAccess } from '@/lib/member-repo-access';
import { rejectOverCeiling } from '@/lib/tier-ceiling-check';

/**
 * GET  /api/chat?cursor=&limit=  → ListConversationsResponse (the caller's own, in teams they still belong to, newest first)
 * POST /api/chat { teamId?, workspaceId?, tier? } → { conversation }
 *
 * Session only. Chat is always on, so creating a conversation needs only team
 * membership; a turn with no resolvable key is refused later (no_key).
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
    const repoAccessRefusal = await assertMemberRepoAccess(r.caller.user.id, workspaceId);
    if (repoAccessRefusal) return repoAccessRefusal;
  }
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const tier = isChatTierName(body.tier) ? body.tier : null;
  // A chat that starts pinned above the person's tier maximum is refused
  // (policy_denied); every turn re-checks too (lib/chat/turn.ts).
  const ceilingRejection = await rejectOverCeiling({
    subject: { teamId, workspaceId, userId: r.caller.user.id },
    surface: 'chat',
    request: { tier, tierOrigin: 'chat_pin' },
    gate: { surface: 'POST /api/chat', workspaceId, callerOrigin: 'dashboard' },
  });
  if (ceilingRejection) return ceilingRejection;
  const conversation = await createConversation({ teamId, workspaceId, userId: r.caller.user.id, tier });
  return NextResponse.json({ conversation: toConversationDTO(conversation) }, { status: 201 });
}
