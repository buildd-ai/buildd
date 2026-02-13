import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaceSkills, workspaces, accounts } from '@buildd/core/db/schema';
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

// POST /api/workspaces/[id]/skills/sync — batch upsert from scanner
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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
        const { skills } = body;

        if (!Array.isArray(skills) || skills.length === 0) {
            return NextResponse.json(
                { error: 'skills array is required and must not be empty' },
                { status: 400 }
            );
        }

        // Verify workspace exists
        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { id: true },
        });
        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const results = [];

        for (const skill of skills) {
            const { slug, name, description, content, contentHash, source } = skill;

            if (!slug || !name || !content || !contentHash) {
                continue; // Skip invalid entries
            }

            if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
                continue; // Skip invalid slugs
            }

            const existing = await db.query.workspaceSkills.findFirst({
                where: and(
                    eq(workspaceSkills.workspaceId, id),
                    eq(workspaceSkills.slug, slug)
                ),
            });

            if (existing) {
                // Only update if content changed
                if (existing.contentHash !== contentHash) {
                    const [updated] = await db
                        .update(workspaceSkills)
                        .set({
                            name,
                            description: description || null,
                            content,
                            contentHash,
                            source: source || null,
                            origin: 'scan',
                            updatedAt: new Date(),
                        })
                        .where(eq(workspaceSkills.id, existing.id))
                        .returning();
                    results.push({ slug, action: 'updated', skill: updated });
                } else {
                    results.push({ slug, action: 'unchanged' });
                }
            } else {
                const [created] = await db
                    .insert(workspaceSkills)
                    .values({
                        workspaceId: id,
                        slug,
                        name,
                        description: description || null,
                        content,
                        contentHash,
                        source: source || null,
                        enabled: true,
                        origin: 'scan',
                        metadata: {},
                    })
                    .returning();
                results.push({ slug, action: 'created', skill: created });
            }
        }

        return NextResponse.json({ results });
    } catch (error) {
        console.error('Sync workspace skills error:', error);
        return NextResponse.json({ error: 'Failed to sync workspace skills' }, { status: 500 });
    }
}
