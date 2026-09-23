import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { getInstallationAccessForUser } from '@/lib/github-installation-access';

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

    // Disconnecting requires managing the installation (its installer, or an
    // admin/owner of a team it belongs to) and is refused while workspaces in
    // teams the caller does not administer still use it.
    const access = await getInstallationAccessForUser(session.user.id!, installation);
    if (!access.canManage) {
      return NextResponse.json({ error: 'Installation not found' }, { status: 404 });
    }
    if (access.otherTeamsUsingIt.length > 0) {
      return NextResponse.json(
        { error: 'Installation is still used by workspaces in teams you do not administer' },
        { status: 409 },
      );
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
