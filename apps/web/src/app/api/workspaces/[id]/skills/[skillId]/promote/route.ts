import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaceSkills, skills, workspaces, accounts } from '@buildd/core/db/schema';
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

// POST /api/workspaces/[id]/skills/[skillId]/promote — promote workspace skill to team
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; skillId: string }> }
) {
    const { id, skillId } = await params;
    const auth = await authenticateRequest(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Promote requires admin role for session auth
    let teamId: string | null = null;

    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id, 'admin');
        if (!access) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
        teamId = access.teamId;
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        // For API auth, get the teamId from account
        teamId = auth.account.teamId;
    } else {
        // dev mode - need to look up workspace teamId
        const ws = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { teamId: true },
        });
        teamId = ws?.teamId || null;
    }

    if (!teamId) {
        return NextResponse.json({ error: 'Could not determine team' }, { status: 400 });
    }

    try {
        // Find the workspace skill
        const wsSkill = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!wsSkill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }

        // Upsert team skill by (teamId, slug)
        const existingTeamSkill = await db.query.skills.findFirst({
            where: and(eq(skills.teamId, teamId), eq(skills.slug, wsSkill.slug)),
        });

        let teamSkill;

        if (existingTeamSkill) {
            [teamSkill] = await db
                .update(skills)
                .set({
                    name: wsSkill.name,
                    description: wsSkill.description,
                    contentHash: wsSkill.contentHash,
                    content: wsSkill.content,
                    source: wsSkill.source,
                    updatedAt: new Date(),
                })
                .where(eq(skills.id, existingTeamSkill.id))
                .returning();
        } else {
            [teamSkill] = await db
                .insert(skills)
                .values({
                    teamId,
                    slug: wsSkill.slug,
                    name: wsSkill.name,
                    description: wsSkill.description,
                    contentHash: wsSkill.contentHash,
                    content: wsSkill.content,
                    source: wsSkill.source,
                })
                .returning();
        }

        // Update workspace skill to reference team skill and mark as promoted
        const [updated] = await db
            .update(workspaceSkills)
            .set({
                skillId: teamSkill.id,
                origin: 'promoted',
                updatedAt: new Date(),
            })
            .where(eq(workspaceSkills.id, skillId))
            .returning();

        return NextResponse.json({ skill: updated, teamSkill });
    } catch (error) {
        console.error('Promote workspace skill error:', error);
        return NextResponse.json({ error: 'Failed to promote skill' }, { status: 500 });
    }
}
