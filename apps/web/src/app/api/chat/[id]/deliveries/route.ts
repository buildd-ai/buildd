import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { getOwnConversation } from '@/lib/chat/store';
import { deliverWatchesToConversation } from '@/lib/chat/watch-delivery';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/chat/[id]/deliveries → { delivered }
 *
 * The open conversation pulls its fired watches (lib/chat/watch-delivery.ts):
 * called on open and on a light poll while the tab is visible. Each one is
 * posted as an event message and pinged, so other tabs refetch too.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  if (!conversation || !r.caller.teamIds.includes(conversation.teamId)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const out = await deliverWatchesToConversation({ userId: r.caller.user.id, conversationId: conversation.id });
  return NextResponse.json(out);
}
