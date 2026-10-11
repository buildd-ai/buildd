import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller } from '@/lib/chat/session';
import { finalizeChatUpload } from '@/lib/artifact-chat-files';

type Ctx = { params: Promise<{ artifactId: string }> };

/**
 * POST /api/chat/uploads/[artifactId]/finalize { sha256? }
 *   → { state: 'ready', sha256, sizeBytes } | { state: 'pending' | 'failed', reason }
 *
 * Check the stored bytes against what the upload was signed for (size, media
 * type) and, when sent, the hash the browser computed. Only the uploader;
 * anyone else, and a missing upload, read 404.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { artifactId } = await ctx.params;
  const body = await req.json().catch(() => ({})) as { sha256?: unknown };
  const sha256 = typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(body.sha256) ? body.sha256 : null;
  const result = await finalizeChatUpload(artifactId, r.caller.user.id, r.caller.teamIds, { expectedSha256: sha256 });
  if (result.state === 'missing') return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  if (result.state === 'ready') return NextResponse.json({ state: 'ready', artifactId, sha256: result.sha256, sizeBytes: result.sizeBytes });
  return NextResponse.json({ state: result.state, artifactId, reason: result.reason }, { status: result.state === 'pending' ? 409 : 422 });
}
