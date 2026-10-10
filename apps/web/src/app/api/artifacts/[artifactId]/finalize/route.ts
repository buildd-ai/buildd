import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { isStorageConfigured } from '@/lib/storage';
import { finalizeArtifactUpload } from '@/lib/artifact-upload';
import { isUuid } from '@/lib/uuid';

/**
 * POST /api/artifacts/[artifactId]/finalize { sha256? } — after the PUT to the
 * presigned URL: verify the stored bytes (size, and sha256 when sent) and mark
 * the upload ready, or failed. Only the uploading worker's caller may finalize;
 * a reader of the artifact finalizes lazily on its own (lib/artifact-upload.ts).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isUuid(artifactId)) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  if (!isStorageConfigured()) return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });

  const artifact = await db.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId), with: { worker: true } });
  if (!artifact || !taskScopeAllowsWorkspace(account, artifact.workspaceId ?? artifact.worker?.workspaceId ?? null)) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }
  if (!artifact.worker || artifact.worker.accountId !== account.id || !taskScopeAllowsWorker(account, artifact.worker)) {
    return NextResponse.json({ error: 'Only the uploading worker may finalize this upload' }, { status: 403 });
  }
  if (!artifact.storageKey) return NextResponse.json({ error: 'Artifact has no file' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const sha256 = (body as { sha256?: unknown }).sha256;
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256))) {
    return NextResponse.json({ error: 'sha256 must be 64 hex characters' }, { status: 400 });
  }

  const result = await finalizeArtifactUpload(artifactId, { expectedSha256: sha256 as string | undefined });
  const status = result.state === 'ready' ? 200 : result.state === 'pending' ? 409 : result.state === 'missing' ? 404 : 422;
  return NextResponse.json({ artifactId, ...result }, { status });
}
