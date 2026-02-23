import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import type { WorkspaceProject } from '@buildd/shared';

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

// GET /api/workspaces/[id]/projects — Return workspace projects array
export async function GET(
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
        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { id: true, projects: true },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        return NextResponse.json({ projects: workspace.projects || [] });
    } catch (error) {
        console.error('Get projects error:', error);
        return NextResponse.json({ error: 'Failed to get projects' }, { status: 500 });
    }
}

// PUT /api/workspaces/[id]/projects — Replace the entire projects array
export async function PUT(
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
        const { projects } = body;

        if (!Array.isArray(projects)) {
            return NextResponse.json({ error: 'projects must be an array' }, { status: 400 });
        }

        // Validate each project has a name
        for (const p of projects) {
            if (!p || typeof p !== 'object' || !p.name || typeof p.name !== 'string') {
                return NextResponse.json({ error: 'Each project must have a name string' }, { status: 400 });
            }
        }

        // Normalize to only allowed fields
        const normalized: WorkspaceProject[] = projects.map((p: any) => ({
            name: p.name,
            ...(p.path ? { path: p.path } : {}),
            ...(p.description ? { description: p.description } : {}),
            ...(p.color ? { color: p.color } : {}),
        }));

        await db.update(workspaces).set({
            projects: normalized,
            updatedAt: new Date(),
        }).where(eq(workspaces.id, id));

        return NextResponse.json({ projects: normalized });
    } catch (error) {
        console.error('Update projects error:', error);
        return NextResponse.json({ error: 'Failed to update projects' }, { status: 500 });
    }
}

// POST /api/workspaces/[id]/projects — Upsert a single project by name
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

        if (!body.name || typeof body.name !== 'string') {
            return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }

        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { id: true, projects: true },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const existing: WorkspaceProject[] = (workspace.projects as WorkspaceProject[]) || [];
        const newProject: WorkspaceProject = {
            name: body.name,
            ...(body.path ? { path: body.path } : {}),
            ...(body.description ? { description: body.description } : {}),
            ...(body.color ? { color: body.color } : {}),
        };

        // Upsert: replace existing project with same name, or append
        const idx = existing.findIndex(p => p.name === body.name);
        if (idx >= 0) {
            existing[idx] = newProject;
        } else {
            existing.push(newProject);
        }

        await db.update(workspaces).set({
            projects: existing,
            updatedAt: new Date(),
        }).where(eq(workspaces.id, id));

        return NextResponse.json({ project: newProject, projects: existing }, { status: idx >= 0 ? 200 : 201 });
    } catch (error) {
        console.error('Upsert project error:', error);
        return NextResponse.json({ error: 'Failed to upsert project' }, { status: 500 });
    }
}
