import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { getOwnConversation } from '@/lib/chat/store';
import { parseTurnSignalPost } from '@/lib/chat/turn-signal';
import { recordTurnSignal } from '@/lib/chat/turn-signal-store';
import { readTeamSettings } from '@/lib/chat-retro/store';
import { chatRetroGloballyEnabled } from '@/lib/chat-retro/settings';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/chat/[id]/turn-signal { ref, signal } → { recorded }
 *
 * What the browser saw of one user turn (lib/chat/turn-signal.ts): offsets,
 * the assistant message id and `true` flags, never text. Merged into that
 * turn's user message, first value wins, so repeats and reconnects are
 * harmless. Recorded only while the conversation's team has chat retro
 * lessons on (the chat retro is its only reader); otherwise accepted and
 * dropped. Also sent by `navigator.sendBeacon` on pagehide, so the body is
 * read as text whatever its content type.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  if (!conversation || !r.caller.teamIds.includes(conversation.teamId)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  let body: unknown;
  try { body = JSON.parse(await req.text()); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = parseTurnSignalPost(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  if (!chatRetroGloballyEnabled() || !(await readTeamSettings(conversation.teamId)).lessons) {
    return NextResponse.json({ recorded: false });
  }
  const recorded = await recordTurnSignal(conversation.id, parsed.ref, parsed.signal);
  return NextResponse.json({ recorded });
}
