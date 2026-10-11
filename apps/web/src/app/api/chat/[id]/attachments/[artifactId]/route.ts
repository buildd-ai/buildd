import { NextRequest, NextResponse } from 'next/server';
import { ArtifactReadError, parseReadSelector, MAX_SLICE_CHARS } from '@buildd/core/artifact-read';
import { requireChatCaller } from '@/lib/chat/session';
import { getOwnConversation } from '@/lib/chat/store';
import { readChatAttachment } from '@/lib/artifact-chat-attachments';

type Ctx = { params: Promise<{ id: string; artifactId: string }> };

/**
 * GET /api/chat/[id]/attachments/[artifactId]?view=&section=&offset=&length=&grep=
 *   → { attachment: { artifactId, revision, sha256, chars, title, messageId }, read }
 *
 * One long paste of the caller's own conversation, read in bounded form (the
 * F4 views: outline, section, range, grep, meta, full). With no view, the
 * first range (MAX_SLICE_CHARS characters); the reader pages on with
 * `view=range&offset=`. Every read is recorded in the read ledger. Missing,
 * another conversation's, and another person's read the same: 404.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id, artifactId } = await ctx.params;
  const conversation = await getOwnConversation(id, r.caller.user.id);
  if (!conversation || !r.caller.teamIds.includes(conversation.teamId)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  // A bad selector throws before anything is read or recorded.
  const read = await readChatAttachment(conversation.id, r.caller.user.id, artifactId, body => (
    parseReadSelector(req.nextUrl.searchParams, body) ?? { view: 'range', offset: 0, length: MAX_SLICE_CHARS }
  )).catch(e => {
    if (e instanceof ArtifactReadError) return { ok: false as const, status: 400 as const, error: e.message };
    throw e;
  });
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  return NextResponse.json({ attachment: read.attachment, read: read.result });
}
