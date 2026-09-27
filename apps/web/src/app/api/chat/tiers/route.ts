import { NextRequest, NextResponse } from 'next/server';
import type { GetChatTiersResponse } from '@buildd/shared';
import { requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { conversationCostUsd, getOwnConversation } from '@/lib/chat/store';
import { loadChatTiers } from '@/lib/chat/tier-info';

/**
 * GET /api/chat/tiers?teamId=&conversationId= → GetChatTiersResponse
 *
 * What the composer's tier switch shows: each chat tier's model and expected
 * price per 1k tokens (lib/chat/tier-info.ts), plus, for a conversation, its
 * pin and what it has cost so far. Read-only; a tier's mapping stays the admin's.
 */
export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const q = req.nextUrl.searchParams;
  const conversationId = q.get('conversationId');

  let teamId: string | null;
  let workspaceId: string | null = null;
  let pinned: GetChatTiersResponse['pinned'] = null;
  let cost: number | null = null;
  if (conversationId) {
    const conv = await getOwnConversation(conversationId, r.caller.user.id);
    if (!conv || !r.caller.teamIds.includes(conv.teamId)) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    teamId = conv.teamId;
    workspaceId = conv.workspaceId;
    pinned = conv.tier ?? null;
    cost = await conversationCostUsd(conv.id).catch(() => null);
  } else {
    teamId = await resolveChatTeam(req, r.caller, q.get('teamId'));
    if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  const body: GetChatTiersResponse = {
    tiers: await loadChatTiers({ teamId, workspaceId }),
    pinned,
    conversationCostUsd: cost,
  };
  return NextResponse.json(body);
}
