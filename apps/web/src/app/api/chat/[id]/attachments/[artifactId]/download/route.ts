import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { getOwnConversation } from '@/lib/chat/store';
import { conversationFile } from '@/lib/artifact-chat-files';
import { generateDownloadUrl } from '@/lib/storage';

type Ctx = { params: Promise<{ id: string; artifactId: string }> };

/**
 * GET /api/chat/[id]/attachments/[artifactId]/download → 302 to the original
 *
 * An image or file a message of the caller's own conversation carries: a
 * short-lived link to the original bytes, exactly as uploaded (their sha256
 * is on the message). Missing, another conversation's, and another person's
 * read the same: 404.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id, artifactId } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  if (!conversation || !r.caller.teamIds.includes(conversation.teamId)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const file = await conversationFile(conversation.id, artifactId);
  if (!file) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  return NextResponse.redirect(await generateDownloadUrl(file.storageKey), { status: 302, headers: { 'Cache-Control': 'private, no-store' } });
}
