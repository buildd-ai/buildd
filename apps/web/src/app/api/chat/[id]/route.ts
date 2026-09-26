import { NextRequest, NextResponse, after } from 'next/server';
import type { ChatTurnRequest, GetConversationResponse, UpdateConversationRequest } from '@buildd/shared';
import {
  getOwnConversation,
  loadApprovals,
  loadMessages,
  pingConversation,
  setConversationArchived,
  setConversationTitle,
  toConversationDTO,
  toMessageDTO,
} from '@/lib/chat/store';
import {
  linkMissionToConversation,
  loadTeamChatSettings,
  requireChatCaller,
  turnUserFor,
  workspaceForConversation,
} from '@/lib/chat/session';
import { runChatTurn } from '@/lib/chat/turn';
import { evaluateLimits, loadLimitInputs } from '@/lib/chat/limits';
import { createInProcessApi } from '@/lib/chat/in-process-api';
import { autoTitleConversation } from '@/lib/chat/auto-title';

// The turn streams for up to ~45s (TURN_BUDGET_MS) plus persistence.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

async function loadOwn(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r;
  const { id } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  if (!conversation) return { response: NextResponse.json({ error: 'Conversation not found' }, { status: 404 }) };
  return { caller: r.caller, conversation };
}

/** GET /api/chat/[id] → GetConversationResponse */
export async function GET(req: NextRequest, ctx: Ctx) {
  const r = await loadOwn(req, ctx);
  if ('response' in r) return r.response;
  const [messages, approvals] = await Promise.all([loadMessages(r.conversation.id), loadApprovals(r.conversation.id)]);
  const body: GetConversationResponse = {
    conversation: toConversationDTO(r.conversation),
    messages: messages.map(toMessageDTO),
    approvals,
  };
  return NextResponse.json(body);
}

/** PATCH /api/chat/[id] { title?, archived? } — rename (titleSource → 'user') or archive. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const r = await loadOwn(req, ctx);
  if ('response' in r) return r.response;
  let body: UpdateConversationRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  if (body.title !== undefined) {
    const title = await setConversationTitle(r.conversation.id, String(body.title), 'user');
    if (!title) return NextResponse.json({ error: 'title must not be empty' }, { status: 400 });
    await pingConversation(r.conversation.id, 'title');
  }
  if (typeof body.archived === 'boolean') {
    await setConversationArchived(r.conversation.id, body.archived);
    await pingConversation(r.conversation.id, 'archived');
  }
  const fresh = await getOwnConversation(r.conversation.id, r.caller.user.id);
  return NextResponse.json({ conversation: toConversationDTO(fresh ?? r.conversation) });
}

/** POST /api/chat/[id] — stream one turn. Body: ChatTurnRequest. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const r = await loadOwn(req, ctx);
  if ('response' in r) return r.response;
  const conv = r.conversation;
  if (conv.archivedAt) return NextResponse.json({ error: 'Conversation is archived' }, { status: 409 });

  let body: ChatTurnRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const settings = await loadTeamChatSettings(conv.teamId);
  const [user, workspace] = await Promise.all([
    turnUserFor(r.caller.user, conv.teamId, settings.timezone),
    workspaceForConversation(conv.workspaceId, conv.teamId),
  ]);

  return runChatTurn({
    conversation: conv,
    workspace,
    user,
    body,
    deps: {
      chatEnabled: async () => settings.chatEnabled,
      limits: async a => evaluateLimits({ ...a, ...(await loadLimitInputs(a)), dailyBudgetUsd: settings.dailyBudgetUsd }),
      makeApi: onCall => createInProcessApi({ origin: req.nextUrl.origin, headers: req.headers, onCall }),
      actionContext: {
        workspaceId: conv.workspaceId ?? undefined,
        teamId: conv.teamId,
        // A session can see several workspaces: ambiguous actions must name one.
        authType: 'oauth',
        getWorkspaceId: async () => conv.workspaceId,
        // Level gates are token-scoped; the routes enforce the user's real
        // authorization, and the chat allowlist bounds the actions.
        getLevel: async () => 'admin',
        appBaseUrl: req.nextUrl.origin,
      },
      linkMission: missionId => linkMissionToConversation(missionId, conv.id, conv.teamId),
      later: fn => after(fn),
      autoTitle: (c, messages) => autoTitleConversation(c, messages, user.id),
    },
  });
}
