import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { createChatUpload } from '@/lib/artifact-chat-files';
import { generateConstrainedUploadUrl, isStorageConfigured } from '@/lib/storage';
import { uploadStagingKey } from '@/lib/storage-keys';

/**
 * POST /api/chat/uploads { name, mediaType, sizeBytes, teamId? }
 *   → { artifactId, uploadUrl, mediaType, sizeBytes }
 *
 * Start one chat image or file (Living Specs C3): a pending upload and a PUT
 * signed for exactly this size and media type. Then PUT the bytes and call
 * ./[artifactId]/finalize; only a ready upload can ride a message. Session
 * only, like chat; the upload belongs to the caller until a message carries it.
 */
export async function POST(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  if (!isStorageConfigured()) return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  const body = await req.json().catch(() => null) as { name?: unknown; mediaType?: unknown; sizeBytes?: unknown; teamId?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'name, mediaType and sizeBytes are required' }, { status: 400 });
  const teamId = await resolveChatTeam(req, r.caller, typeof body.teamId === 'string' ? body.teamId : null);
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const created = await createChatUpload({ teamId, userId: r.caller.user.id, name: body.name, mediaType: body.mediaType, sizeBytes: body.sizeBytes });
  if (!created.ok) return NextResponse.json({ error: created.error, code: created.code }, { status: created.status });
  // Signed for the staging key: finalize copies the verified bytes to storageKey (lib/artifact-upload.ts).
  const uploadUrl = await generateConstrainedUploadUrl(uploadStagingKey(created.storageKey), created.mediaType, created.sizeBytes);
  return NextResponse.json({ artifactId: created.artifactId, uploadUrl, mediaType: created.mediaType, sizeBytes: created.sizeBytes, name: created.name });
}
