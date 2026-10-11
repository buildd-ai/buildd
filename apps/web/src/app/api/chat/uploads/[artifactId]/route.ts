import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { cancelChatUpload } from '@/lib/artifact-chat-files';

type Ctx = { params: Promise<{ artifactId: string }> };

/**
 * DELETE /api/chat/uploads/[artifactId] → { removed: true }
 *
 * Take back an upload before it is sent: the row and its stored bytes go.
 * Only the uploader; a file a message already carries is kept (409).
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { artifactId } = await ctx.params;
  const result = await cancelChatUpload(artifactId, r.caller.user.id, r.caller.teamIds);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ removed: true });
}
