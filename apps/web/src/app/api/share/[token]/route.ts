import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts, workers, tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

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
    where: eq(artifacts.shareToken, token),
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
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

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
