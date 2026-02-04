import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { observations, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

// DELETE /api/workspaces/[id]/observations/[obsId]
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; obsId: string }> }
) {
    const { id, obsId } = await params;

    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // Verify workspace ownership
        const workspace = await db.query.workspaces.findFirst({
            where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
            columns: { id: true },
        });
        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        await db.delete(observations).where(
            and(eq(observations.id, obsId), eq(observations.workspaceId, id))
        );

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete observation error:', error);
        return NextResponse.json({ error: 'Failed to delete observation' }, { status: 500 });
    }
}
