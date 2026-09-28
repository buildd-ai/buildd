import { NextRequest, NextResponse } from 'next/server';
import type { DismissChatDirectiveRequest } from '@buildd/shared';
import { requireChatCaller } from '@/lib/chat/session';
import { markDirectiveCard } from '@/lib/chat/directives-store';
import { checkCard } from '../validate';

/**
 * POST /api/chat/directives/dismiss { conversationId, messageId }
 *
 * The card's "Not now": nothing is saved, and the card draws answered on
 * every device from then on. The caller's own conversation only.
 */
export async function POST(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  let body: DismissChatDirectiveRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const card = await checkCard(r.caller, body);
  if ('response' in card) return card.response;
  const ok = await markDirectiveCard(card.conversationId, card.messageId, { status: 'dismissed' });
  if (!ok) return NextResponse.json({ error: 'Card not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
