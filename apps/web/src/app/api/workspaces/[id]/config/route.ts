import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// GET /api/workspaces/[id]/config - Get workspace git config
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // In development, allow without auth for local-ui
    const authHeader = req.headers.get('authorization');
    const isApiAuth = authHeader?.startsWith('Bearer ');

    if (!isApiAuth && process.env.NODE_ENV !== 'development') {
        const user = await getCurrentUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    try {
        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: {
                id: true,
                name: true,
                gitConfig: true,
                configStatus: true,
            },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        return NextResponse.json({
            gitConfig: workspace.gitConfig,
            configStatus: workspace.configStatus,
        });
    } catch (error) {
        console.error('Get workspace config error:', error);
        return NextResponse.json({ error: 'Failed to get config' }, { status: 500 });
    }
}

// POST /api/workspaces/[id]/config - Save workspace git config
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
        const access = await verifyWorkspaceAccess(user.id, id);
        if (!access) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const body = await req.json();
        const gitConfig: WorkspaceGitConfig = {
            // Branching (required)
            defaultBranch: body.defaultBranch || 'main',
            branchingStrategy: body.branchingStrategy || 'feature',
            branchPrefix: body.branchPrefix || undefined,
            useBuildBranch: body.useBuildBranch || false,

            // Commit conventions
            commitStyle: body.commitStyle || 'freeform',
            commitPrefix: body.commitPrefix || undefined,

            // PR/Merge behavior
            requiresPR: body.requiresPR ?? false,
            targetBranch: body.targetBranch || undefined,
            autoCreatePR: body.autoCreatePR ?? false,

            // Agent instructions
            agentInstructions: body.agentInstructions || undefined,
            useClaudeMd: body.useClaudeMd ?? true,

            // Permission mode
            bypassPermissions: body.bypassPermissions ?? false,
        };

        await db
            .update(workspaces)
            .set({
                gitConfig,
                configStatus: 'admin_confirmed',
                updatedAt: new Date(),
            })
            .where(eq(workspaces.id, id));

        return NextResponse.json({ success: true, gitConfig });
    } catch (error) {
        console.error('Save workspace config error:', error);
        return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
    }
}
