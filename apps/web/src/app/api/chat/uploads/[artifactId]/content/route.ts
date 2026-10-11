import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { storeChatUploadBytes, MAX_RELAYED_UPLOAD_BYTES } from '@/lib/artifact-chat-files';

type Ctx = { params: Promise<{ artifactId: string }> };

/**
 * PUT /api/chat/uploads/[artifactId]/content (body: the file's bytes) → { stored: true }
 *
 * The same upload through this server instead of straight to storage, for a
 * browser whose direct PUT was refused (e.g. by the bucket's CORS policy). Up
 * to MAX_RELAYED_UPLOAD_BYTES, the platform's request-body ceiling. The bytes
 * must be exactly the size and media type the upload was started with; then
 * finalize as usual. Only the uploader, only while the upload is pending.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { artifactId } = await ctx.params;
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_RELAYED_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Too large to relay; upload it directly' }, { status: 413 });
  }
  const bytes = Buffer.from(await req.arrayBuffer());
  const result = await storeChatUploadBytes(artifactId, r.caller.user.id, r.caller.teamIds, bytes, req.headers.get('content-type'));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ stored: true });
}
