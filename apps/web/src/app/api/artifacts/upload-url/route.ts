import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'crypto';
import { authenticateApiKey } from '@/lib/api-auth';
import { isStorageConfigured, generateUploadUrl } from '@/lib/storage';
import { ArtifactType } from '@buildd/shared';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// POST /api/artifacts/upload-url - Get a presigned upload URL and create artifact record
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  const body = await req.json();
  const { workerId, filename, mimeType, sizeBytes, title, type, metadata } = body as {
    workerId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    title?: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };

  if (!workerId || !filename || !mimeType || !sizeBytes) {
    return NextResponse.json(
      { error: 'workerId, filename, mimeType, and sizeBytes are required' },
      { status: 400 }
    );
  }

  if (sizeBytes > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds 50MB limit' }, { status: 400 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const uuid = randomUUID();
  const storageKey = `artifacts/${worker.workspaceId}/${uuid}/${filename}`;
  const shareToken = randomBytes(24).toString('base64url');

  const artifactType = type || ArtifactType.FILE;
  const artifactTitle = title || filename;

  const [artifact] = await db
    .insert(artifacts)
    .values({
      workerId,
      workspaceId: worker.workspaceId || null,
      type: artifactType,
      title: artifactTitle,
      storageKey,
      shareToken,
      metadata: {
        ...(metadata || {}),
        filename,
        mimeType,
        sizeBytes,
      },
    })
    .returning();

  const uploadUrl = await generateUploadUrl(storageKey, mimeType);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://buildd.dev';

  const downloadUrl = `${baseUrl}/api/artifacts/${artifact.id}/download?token=${shareToken}`;
  const shareUrl = `${baseUrl}/share/${shareToken}`;

  return NextResponse.json({
    artifactId: artifact.id,
    uploadUrl,
    downloadUrl,
    shareUrl,
    storageKey,
  });
}
