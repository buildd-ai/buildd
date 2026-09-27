import { NextRequest, NextResponse, after } from 'next/server';
import { isChatTierName, type ChatTurnRequest, type GetConversationResponse, type UpdateConversationRequest } from '@buildd/shared';
import {
  getOwnConversation,
  loadApprovals,
  loadMessages,
  pingConversation,
  setConversationArchived,
  setConversationTier,
  setConversationTitle,
  setConversationWorkspace,
  toConversationDTO,
  toMessageDTO,
} from '@/lib/chat/store';
import {
  isSensitiveWorkspace,
  linkMissionToConversation,
  linkedMissionFor,
  loadRoutableWorkspaces,
  loadTeamChatSettings,
  requireChatCaller,
  turnUserFor,
  workspaceForConversation,
} from '@/lib/chat/session';
import { runChatTurn } from '@/lib/chat/turn';
import { loadAllowedToolGroups } from '@/lib/chat/permissions-store';
import { checkChatLimits } from '@/lib/chat/limits';
import { createInProcessApi } from '@/lib/chat/in-process-api';
import { loadChatReach } from '@/lib/chat/reach';
import { autoTitleConversation } from '@/lib/chat/auto-title';
import { getMemoryStoreForTeam } from '@/lib/memory-helper';
import { PgVectorStore, getVoyageEmbedder, getVoyageReranker } from '@buildd/core/knowledge-store';

// The turn streams for up to ~45s (TURN_BUDGET_MS) plus persistence.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

async function loadOwn(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r;
  const { id } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  // Ownership alone isn't enough: a conversation lives in a team, and runs on
  // that team's key and data. Leaving the team ends access to it.
  if (!conversation || !r.caller.teamIds.includes(conversation.teamId)) return { response: NextResponse.json({ error: 'Conversation not found' }, { status: 404 }) };
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

/**
 * PATCH /api/chat/[id] { title?, archived?, tier?, workspaceId? } — rename
 * (titleSource → 'user'), archive, pin a tier, or pin a workspace (null = all
 * workspaces, routed per turn).
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const r = await loadOwn(req, ctx);
  if ('response' in r) return r.response;
  let body: UpdateConversationRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  if (body.tier !== undefined && body.tier !== null && !isChatTierName(body.tier)) {
    return NextResponse.json({ error: 'tier must be budget, standard, premium or null' }, { status: 400 });
  }
  if (body.workspaceId !== undefined && body.workspaceId !== null) {
    // A pin must be one of this team's workspaces, and never a sensitive one.
    const ws = typeof body.workspaceId === 'string' ? await workspaceForConversation(body.workspaceId, r.conversation.teamId) : null;
    if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    if (await isSensitiveWorkspace(ws.id)) {
      return NextResponse.json({ error: 'sensitive_workspace', message: 'This workspace is marked sensitive, so its data is not sent to a chat model.' }, { status: 403 });
    }
  }
  if (body.tier !== undefined) {
    await setConversationTier(r.conversation.id, body.tier);
    await pingConversation(r.conversation.id, 'tier');
  }
  if (body.workspaceId !== undefined) {
    await setConversationWorkspace(r.conversation.id, body.workspaceId);
    await pingConversation(r.conversation.id, 'scope');
  }
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
  const [user, workspace, reach, allowedToolGroups] = await Promise.all([
    turnUserFor(r.caller.user, conv.teamId, settings.timezone),
    workspaceForConversation(conv.workspaceId, conv.teamId),
    loadChatReach(conv.teamId),
    // The caller's own "Allow" choices; empty (ask for everything) on failure.
    loadAllowedToolGroups(conv.teamId, r.caller.user.id),
  ]);

  // The pinned workspace only counts while it's in reach: a conversation
  // pinned to a workspace later marked sensitive loses it as a default, so
  // no tool (or knowledge read) falls back to it.
  const defaultWorkspaceId = conv.workspaceId && reach.workspaceIds.has(conv.workspaceId) ? conv.workspaceId : null;
  // Unpinned: every in-reach workspace, for routing to pick the turn's scope.
  const workspaces = defaultWorkspaceId ? [] : await loadRoutableWorkspaces(conv.teamId, reach.workspaceIds).catch(() => []);
  const embedder = getVoyageEmbedder();
  const knowledgeStore = new PgVectorStore(embedder, getVoyageReranker());

  /** Tool context and memory with `wsId` as the default workspace (null = none). */
  const scopeFor = (wsId: string | null) => {
    const def = wsId && reach.workspaceIds.has(wsId) ? wsId : null;
    return {
      memory: async (requested: string | null) => {
        const target = requested ?? def;
        if (!target || !reach.workspaceIds.has(target)) return null;
        const store = await getMemoryStoreForTeam(target, conv.teamId);
        if (!store) return null;
        return { store, ctx: { workspaceId: target, teamId: conv.teamId, knowledgeStore, embedder, isSensitive: false } };
      },
      actionContext: {
        workspaceId: def ?? undefined,
        teamId: conv.teamId,
        // A session can see several workspaces: ambiguous actions must name one.
        authType: 'oauth' as const,
        getWorkspaceId: async () => def,
        knowledgeStore,
        embedder,
        // Admin knowledge ops (memory_delete, consolidate_knowledge) act on the
        // default workspace's team store, and only while it's in reach.
        // A caller naming a workspace gets that one's store, and only if in reach.
        getMemoryClient: async (requested?: string) => {
          const target = requested ?? def;
          return target && reach.workspaceIds.has(target) ? getMemoryStoreForTeam(target, conv.teamId) : null;
        },
        // Level gates are token-scoped; the routes enforce the user's real
        // authorization, the chat allowlist bounds the actions, and `reach`
        // bounds the workspaces (this team's, never a sensitive one).
        getLevel: async () => 'admin' as const,
        appBaseUrl: req.nextUrl.origin,
      },
    };
  };
  const base = scopeFor(defaultWorkspaceId);

  return runChatTurn({
    conversation: conv,
    workspace: defaultWorkspaceId ? workspace : null,
    workspaces,
    user,
    body,
    deps: {
      scopeFor: wsId => scopeFor(wsId),
      allowedToolGroups,
      limits: a => checkChatLimits({ ...a, settings }),
      makeApi: (onCall, opts) => createInProcessApi({ origin: req.nextUrl.origin, headers: req.headers, onCall, reach, routes: opts?.routes }),
      memory: base.memory,
      actionContext: base.actionContext,
      linkMission: missionId => linkMissionToConversation(missionId, conv.id, conv.teamId),
      linkedMissionId: () => linkedMissionFor(conv.id, conv.teamId),
      later: fn => after(fn),
      autoTitle: (c, messages) => autoTitleConversation(c, messages, user.id),
    },
  });
}
