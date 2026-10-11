import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { getOwnConversation } from '@/lib/chat/store';
import { conversationAttachments } from '@/lib/artifact-chat-attachments';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/chat/[id]/attachments → { attachments: [{ artifactId, revision, sha256, chars, title, messageId }] }
 *
 * The long pastes of the caller's own conversation, oldest first: metadata
 * only, never the text (read one with ./[artifactId]). Session only, like the
 * conversation itself.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  if (!conversation || !r.caller.teamIds.includes(conversation.teamId)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  return NextResponse.json({ attachments: await conversationAttachments(conversation.id) });
}
