import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { observations, accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

const VALID_TYPES = ['discovery', 'decision', 'gotcha', 'pattern', 'architecture', 'summary'] as const;

async function authenticateRequest(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (apiKey) {
        const account = await db.query.accounts.findFirst({
            where: eq(accounts.apiKey, hashApiKey(apiKey)),
        });
        if (account) return { type: 'api' as const, account };
    }

    if (process.env.NODE_ENV !== 'development') {
        const user = await getCurrentUser();
        if (user) return { type: 'session' as const, user };
    } else {
        return { type: 'dev' as const };
    }

    return null;
}

// PATCH /api/workspaces/[id]/observations/[obsId]
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; obsId: string }> }
) {
    const { id, obsId } = await params;
    const auth = await authenticateRequest(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const body = await req.json();

        const updateFields: Record<string, unknown> = {};
        if (body.title !== undefined) updateFields.title = body.title;
        if (body.content !== undefined) updateFields.content = body.content;
        if (body.type !== undefined) {
            if (!VALID_TYPES.includes(body.type)) {
                return NextResponse.json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
            }
            updateFields.type = body.type;
        }
        if (body.files !== undefined) updateFields.files = body.files;
        if (body.concepts !== undefined) updateFields.concepts = body.concepts;

        if (Object.keys(updateFields).length === 0) {
            return NextResponse.json({ error: 'At least one field must be provided' }, { status: 400 });
        }

        const [updated] = await db.update(observations)
            .set(updateFields)
            .where(and(eq(observations.id, obsId), eq(observations.workspaceId, id)))
            .returning();

        if (!updated) {
            return NextResponse.json({ error: 'Observation not found' }, { status: 404 });
        }

        return NextResponse.json({ observation: updated });
    } catch (error) {
        console.error('Update observation error:', error);
        return NextResponse.json({ error: 'Failed to update observation' }, { status: 500 });
    }
}

// DELETE /api/workspaces/[id]/observations/[obsId]
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; obsId: string }> }
) {
    const { id, obsId } = await params;
    const auth = await authenticateRequest(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        await db.delete(observations).where(
            and(eq(observations.id, obsId), eq(observations.workspaceId, id))
        );

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete observation error:', error);
        return NextResponse.json({ error: 'Failed to delete observation' }, { status: 500 });
    }
}
