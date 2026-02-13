import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills, accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

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

function computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

// GET /api/workspaces/[id]/skills/[skillId]
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; skillId: string }> }
) {
    const { id, skillId } = await params;
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
        const skill = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }

        return NextResponse.json({ skill });
    } catch (error) {
        console.error('Get workspace skill error:', error);
        return NextResponse.json({ error: 'Failed to get workspace skill' }, { status: 500 });
    }
}

// PATCH /api/workspaces/[id]/skills/[skillId]
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; skillId: string }> }
) {
    const { id, skillId } = await params;
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
        const { name, description, content, source, metadata, enabled } = body;

        const existing = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!existing) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (content !== undefined) {
            updates.content = content;
            updates.contentHash = computeContentHash(content);
        }
        if (source !== undefined) updates.source = source;
        if (metadata !== undefined) updates.metadata = metadata;
        if (enabled !== undefined) updates.enabled = enabled;

        const [updated] = await db
            .update(workspaceSkills)
            .set(updates)
            .where(eq(workspaceSkills.id, skillId))
            .returning();

        return NextResponse.json({ skill: updated });
    } catch (error) {
        console.error('Update workspace skill error:', error);
        return NextResponse.json({ error: 'Failed to update workspace skill' }, { status: 500 });
    }
}

// DELETE /api/workspaces/[id]/skills/[skillId]
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; skillId: string }> }
) {
    const { id, skillId } = await params;
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
        const existing = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!existing) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }

        await db
            .delete(workspaceSkills)
            .where(eq(workspaceSkills.id, skillId));

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete workspace skill error:', error);
        return NextResponse.json({ error: 'Failed to delete workspace skill' }, { status: 500 });
    }
}
