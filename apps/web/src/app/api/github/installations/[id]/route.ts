import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';

// DELETE /api/github/installations/[id] - Disconnect an installation
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ ok: true });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const installation = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, id),
    });

    if (!installation) {
      return NextResponse.json({ error: 'Installation not found' }, { status: 404 });
    }

    // Delete the installation (cascade will delete repos)
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, id));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Delete installation error:', error);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
