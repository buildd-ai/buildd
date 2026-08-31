import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { trackEvent } from '@/lib/axiom';

// GET /api/share/[token] - Public artifact access via share token
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!token) {
    return NextResponse.json({ error: 'Token required' }, { status: 400 });
  }

  const artifact = await db.query.artifacts.findFirst({
    where: and(eq(artifacts.shareToken, token), eq(artifacts.visibility, 'public')),
    with: {
      worker: {
        with: {
          task: {
            columns: { id: true, title: true, status: true, createdAt: true },
          },
        },
        columns: { id: true, name: true },
      },
    },
  });

  if (!artifact) {
    // The token is a bearer credential and `trackEvent` fields reach the sink
    // verbatim (lib/axiom.ts applies no redaction), so nothing derived from it
    // is logged here — on a miss there is no non-reversible id to log either.
    trackEvent('api.share.request', { status: 'not_found' });
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  trackEvent('api.share.request', {
    status: 'found',
    artifactId: artifact.id,
    artifactType: artifact.type,
    taskId: artifact.worker?.task?.id,
  });
  return NextResponse.json({
    artifact: {
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      content: artifact.content,
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
    },
    task: artifact.worker?.task ? {
      title: artifact.worker.task.title,
      status: artifact.worker.task.status,
    } : null,
  });
}
