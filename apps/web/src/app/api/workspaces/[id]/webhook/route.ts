import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

// POST /api/workspaces/[id]/webhook - Save webhook config
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // Verify ownership
        const workspace = await db.query.workspaces.findFirst({
            where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const body = await req.json();

        const webhookConfig: WorkspaceWebhookConfig | null =
            body.url
                ? {
                      url: body.url,
                      token: body.token || '',
                      enabled: body.enabled ?? false,
                      runnerPreference: body.runnerPreference || undefined,
                  }
                : null;

        await db
            .update(workspaces)
            .set({
                webhookConfig,
                updatedAt: new Date(),
            })
            .where(eq(workspaces.id, id));

        return NextResponse.json({ success: true, webhookConfig });
    } catch (error) {
        console.error('Save webhook config error:', error);
        return NextResponse.json({ error: 'Failed to save webhook config' }, { status: 500 });
    }
}
