import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { getOwnConversation } from '@/lib/chat/store';
import { deliverWatchesToConversation } from '@/lib/chat/watch-delivery';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/chat/[id]/deliveries[?open=1] → { delivered, marked, skipped?, pollMs }
 *
 * The open conversation pulls its fired watches (lib/chat/watch-delivery.ts):
 * `open=1` when the conversation is opened or the tab comes back (always
 * drains), then a light poll while visible that only reaches Postgres when
 * the Redis flag says there is something to pull. `pollMs` is when to ask again.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  if (!conversation || !r.caller.teamIds.includes(conversation.teamId)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const open = req.nextUrl.searchParams.get('open') === '1';
  const out = await deliverWatchesToConversation({ userId: r.caller.user.id, conversationId: conversation.id, open });
  return NextResponse.json(out);
}
